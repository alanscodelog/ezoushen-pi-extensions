import { basename } from "node:path";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const GIT_COMMAND_TIMEOUT_MS = 2_500;
const GIT_REFRESH_INTERVAL_MS = 1_000;

type ResponseSpeed = {
	tokensPerSecond?: number;
	inProgress: boolean;
};

type GitInfo = {
	changedFiles: number;
	added: number;
	deleted: number;
	prNumber?: number;
};

const STATUS_LABELS: Record<string, string> = {
	"pi-lens-lsp": "pi-lens",
	mcp: "mcp",
	"mcp-auth": "mcp",
	"background-tasks": "bg",
	"subagent-slash": "subagents",
	"subagent-slash-text": "subagents",
	"pi-permission-system": "perms",
};

export default function footer(pi: ExtensionAPI): void {
	let responseStartedAt: number | undefined;
	let liveOutputTokens = 0;
	let responseSpeed: ResponseSpeed | undefined;
	// Session-wide throughput: completed turns' output tokens and wall-clock time.
	let sessionOutputTokens = 0;
	let sessionElapsedMs = 0;
	let requestRender: (() => void) | undefined;
	let gitInfo: GitInfo | undefined;
	let gitRefreshGeneration = 0;
	let gitRefreshInFlight = false;
	let gitRefreshQueued = false;
	let gitRefreshForceQueued = false;
	let lastGitRefreshAt = Number.NEGATIVE_INFINITY;
	let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	let footerDisposed = false;
	let gitCwd: string | undefined;
	let gitBranch: string | undefined;
	let prCache: { branch: string; prNumber?: number } | undefined;
	let unsubscribeBranchChange: (() => void) | undefined;

	const startGitRefresh = (generation: number, cwd: string, forcePr = false) => {
		gitRefreshInFlight = true;
		lastGitRefreshAt = Date.now();
		void Promise.allSettled([refreshGit(cwd), refreshPr(cwd, forcePr, generation)]).then(([info, prNumber]) => {
			if (info.status === "rejected" || prNumber.status === "rejected") return;
			if (generation !== gitRefreshGeneration || footerDisposed) return;
			gitInfo = { ...info.value, prNumber: prNumber.value };
			requestRender?.();
		}).catch(() => {}).finally(() => {
			gitRefreshInFlight = false;
			if (gitRefreshQueued) scheduleQueuedGitRefresh(cwd);
		});
	};

	const scheduleQueuedGitRefresh = (fallbackCwd: string) => {
		if (!gitRefreshQueued || footerDisposed || gitRefreshInFlight || gitRefreshTimer) return;
		const delay = Math.max(0, lastGitRefreshAt + GIT_REFRESH_INTERVAL_MS - Date.now());
		const startQueuedRefresh = () => {
			gitRefreshTimer = undefined;
			if (!gitRefreshQueued || footerDisposed || gitRefreshInFlight) return;
			if (Date.now() < lastGitRefreshAt + GIT_REFRESH_INTERVAL_MS) {
				scheduleQueuedGitRefresh(fallbackCwd);
				return;
			}
			gitRefreshQueued = false;
			const forcePr = gitRefreshForceQueued;
			gitRefreshForceQueued = false;
			startGitRefresh(gitRefreshGeneration, gitCwd ?? fallbackCwd, forcePr);
		};
		if (delay === 0) {
			startQueuedRefresh();
		} else {
			gitRefreshTimer = setTimeout(startQueuedRefresh, delay);
		}
	};

	const refreshPr = async (cwd: string, force: boolean, generation: number): Promise<number | undefined> => {
		const branch = gitBranch;
		if (!branch) return undefined;
		if (!force && prCache?.branch === branch) return prCache.prNumber;
		const output = await runGh(cwd).catch((error: unknown): string | undefined => {
			if (isNoPullRequestError(error)) return "";
			return undefined;
		});
		if (generation !== gitRefreshGeneration || footerDisposed || branch !== gitBranch) return undefined;
		if (output === undefined) return prCache?.branch === branch ? prCache.prNumber : undefined;
		const prNumber = parsePrNumber(output);
		prCache = { branch, prNumber };
		return prNumber;
	};

	const requestGitRefresh = (forcePr = false) => {
		if (footerDisposed || !gitCwd) return;
		gitRefreshGeneration += 1;
		gitRefreshQueued = true;
		gitRefreshForceQueued ||= forcePr;
		if (gitRefreshInFlight) return;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		scheduleQueuedGitRefresh(gitCwd);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		sessionOutputTokens = 0;
		sessionElapsedMs = 0;
		responseSpeed = undefined;
		gitCwd = ctx.cwd;
		gitInfo = undefined;
		gitBranch = undefined;
		prCache = undefined;

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerDisposed = false;
			requestRender = () => tui.requestRender();
			gitBranch = footerData?.getGitBranch?.();
			unsubscribeBranchChange?.();
			unsubscribeBranchChange = footerData?.onBranchChange?.(() => {
				const branch = footerData?.getGitBranch?.();
				const branchChanged = branch !== gitBranch;
				if (branchChanged) {
					gitBranch = branch;
					prCache = undefined;
					if (gitInfo) gitInfo = { ...gitInfo, prNumber: undefined };
				}
				requestGitRefresh(branchChanged);
			});
			requestGitRefresh();
			return {
				dispose() {
					footerDisposed = true;
					gitRefreshGeneration += 1;
					gitRefreshQueued = false;
					gitRefreshForceQueued = false;
					if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
					gitRefreshTimer = undefined;
					unsubscribeBranchChange?.();
					unsubscribeBranchChange = undefined;
					requestRender = undefined;
				},
				invalidate() {
					tui.requestRender();
				},
				render(_width: number): string[] {
					const dir = basename(ctx.cwd) || ctx.cwd;
					const separator = theme.fg("borderMuted", " │ ");
					const line = [
						theme.fg("mdLink", dir),
						formatGitSection(theme, footerData?.getGitBranch?.(), gitInfo),
						formatContextSection(theme, ctx),
						formatSpeedSection(theme, responseSpeed),
						theme.fg("mdLink", formatModelName(ctx, pi)),
					].filter((segment): segment is string => segment !== undefined).join(separator);
					const extensionStatusLines: string[] = [];
					for (const [key, status] of footerData?.getExtensionStatuses?.() ?? []) {
						const owner = `${STATUS_LABELS[key] ?? key} · `;
						const firstPrefix = `${theme.fg("borderMuted", "│ ")}${theme.fg("dim", owner)}`;
						const nextPrefix = `${theme.fg("borderMuted", "│ ")}${" ".repeat(owner.length)}`;
						for (const [index, statusLine] of status.split(/\r?\n/).entries()) {
							if (!statusLine.trim()) continue;
							const linePrefix = index === 0 ? firstPrefix : nextPrefix;
							extensionStatusLines.push(truncateToWidth(`${linePrefix}${statusLine.trimEnd()}`, _width, "…"));
						}
					}
					return [truncateToWidth(line, _width, "…"), ...extensionStatusLines];
				},
			};
		});
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		responseStartedAt = Date.now();
		liveOutputTokens = 0;
		responseSpeed = { tokensPerSecond: sessionRate(0, 0), inProgress: true };
		requestRender?.();
	});

	const sessionRate = (liveTokens: number, liveElapsedMs: number): number | undefined =>
		calculateTokensPerSecond(sessionOutputTokens + liveTokens, sessionElapsedMs + liveElapsedMs);

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant" || responseStartedAt === undefined) return;

		const update = event.assistantMessageEvent;
		if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
			liveOutputTokens += Math.max(1, update.delta.length / 4);
		}
		responseSpeed = {
			tokensPerSecond: sessionRate(liveOutputTokens, Date.now() - responseStartedAt),
			inProgress: true,
		};
		requestRender?.();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") {
			requestRender?.();
			requestGitRefresh();
			return;
		}

		if (responseStartedAt !== undefined) {
			const outputTokens = event.message.usage?.output || Math.round(liveOutputTokens);
			sessionOutputTokens += outputTokens;
			sessionElapsedMs += Date.now() - responseStartedAt;
			responseSpeed = { tokensPerSecond: sessionRate(0, 0), inProgress: false };
		}
		responseStartedAt = undefined;
		liveOutputTokens = 0;
		requestRender?.();
		requestGitRefresh();
	});

	pi.on("tool_result", async () => requestGitRefresh());
	pi.on("model_select", async () => requestRender?.());
	pi.on("session_shutdown", async () => {
		footerDisposed = true;
		gitRefreshGeneration += 1;
		gitRefreshQueued = false;
		gitRefreshForceQueued = false;
		if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
		gitRefreshTimer = undefined;
		unsubscribeBranchChange?.();
		unsubscribeBranchChange = undefined;
		gitCwd = undefined;
		gitBranch = undefined;
		prCache = undefined;
		gitInfo = undefined;
		responseStartedAt = undefined;
		liveOutputTokens = 0;
		responseSpeed = undefined;
		sessionOutputTokens = 0;
		sessionElapsedMs = 0;
		requestRender = undefined;
	});
}

async function refreshGit(cwd: string): Promise<GitInfo> {
	const [status, numstat] = await Promise.allSettled([
		runGit(cwd, ["status", "--porcelain"]),
		runGit(cwd, ["diff", "HEAD", "--numstat"]),
	]);
	if (status.status === "rejected") throw status.reason;
	if (numstat.status === "rejected") throw numstat.reason;
	return parseGitInfo(status.value, numstat.value);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const execFileAsync = promisify(childProcess.execFile);
	const output = await execFileAsync("git", args, { cwd, timeout: GIT_COMMAND_TIMEOUT_MS });
	return typeof output === "string" ? output : output.stdout;
}

async function runGh(cwd: string): Promise<string> {
	const execFileAsync = promisify(childProcess.execFile);
	const output = await execFileAsync("gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
		cwd,
		timeout: GIT_COMMAND_TIMEOUT_MS,
	});
	return typeof output === "string" ? output : output.stdout;
}

function isNoPullRequestError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const details = error as { message?: unknown; stderr?: unknown };
	const text = [details.message, details.stderr].filter((value): value is string => typeof value === "string").join("\n");
	return /no (?:open )?pull requests found for branch\b/i.test(text);
}

function parsePrNumber(output: string): number | undefined {
	const prNumber = Number(output.trim());
	return Number.isInteger(prNumber) && prNumber > 0 ? prNumber : undefined;
}

function parseGitInfo(status: string, numstat: string): GitInfo {
	const changedFiles = status.split(/\r?\n/).filter((line) => line.length > 0).length;
	let added = 0;
	let deleted = 0;
	for (const line of numstat.split(/\r?\n/)) {
		const [addedText, deletedText] = line.split("\t");
		const addedLines = Number(addedText);
		const deletedLines = Number(deletedText);
		if (Number.isFinite(addedLines)) added += addedLines;
		if (Number.isFinite(deletedLines)) deleted += deletedLines;
	}
	return { changedFiles, added, deleted };
}

function formatGitSection(
	theme: ExtensionContext["ui"]["theme"],
	branch: string | undefined,
	info: GitInfo | undefined,
): string | undefined {
	if (!branch) return undefined;
	const branchText = info?.prNumber ? `${branch} (#${info.prNumber})` : branch;
	const text = info && info.changedFiles > 0
		? `${branchText} (${info.changedFiles}) +${info.added}/-${info.deleted}`
		: branchText;
	return theme.fg("mdLink", text);
}

function formatModelName(ctx: ExtensionContext, pi: ExtensionAPI): string {
	const provider = ctx.model?.provider;
	const model = ctx.model?.name || (ctx.model?.id ? ctx.model.id.replace(/^models\//, "") : "no-model");
	const supportsReasoning = ctx.model?.reasoning ?? false;
	const thinking = pi.getThinkingLevel?.() ?? "off";
	const thinkingDisplay = thinking !== "off" ? thinking : supportsReasoning ? "T" : "–";
	const modelPart = provider ? `(${provider}) ${model}` : model;
	return `${modelPart} [${thinkingDisplay}]`;
}

function formatContextSection(theme: ExtensionContext["ui"]["theme"], ctx: ExtensionContext): string {
	const usage = getUsage(ctx);
	const percent = usage.usedRatio * 100;
	const bar = formatContextBar(percent);
	const color = getZoneColor(getZone(usage.usedRatio, usage.contextWindow));
	const text = `${bar} ${Math.round(percent)}% · ${formatCompactTokens(usage.contextWindow)}`;
	return theme.fg(color, text);
}

function getUsage(ctx: ExtensionContext): { contextWindow: number; usedRatio: number } {
	const contextWindow = ctx.model?.contextWindow ?? 0;
	const usedTokens = ctx.getContextUsage?.()?.tokens ?? 0;
	const usedRatio = contextWindow > 0 ? Math.min(1, usedTokens / contextWindow) : 0;
	return { contextWindow, usedRatio };
}

function formatContextBar(percent: number, width = 6): string {
	const clamped = Math.min(100, Math.max(0, percent));
	const filled = Math.round((clamped / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

function getZone(usedRatio: number, contextWindow: number): string {
	if (contextWindow >= 500_000) {
		const usedTokens = contextWindow * usedRatio;
		if (usedTokens < 150_000) return "Plan";
		if (usedTokens < 250_000) return "Code";
		if (usedTokens < 400_000) return "Dump";
		if (usedTokens < 450_000) return "ExDump";
		return "Dead";
	}
	if (usedRatio < 0.4) return "Plan";
	if (usedRatio < 0.7) return "Code";
	if (usedRatio < 0.75) return "Dump";
	if (usedRatio < 0.8) return "ExDump";
	return "Dead";
}

function getZoneColor(zone: string): "success" | "warning" | "error" | "dim" {
	switch (zone) {
		case "Plan":
		case "Code":
			return "success";
		case "Dump":
			return "warning";
		case "ExDump":
		case "Dead":
			return "error";
		default:
			return "dim";
	}
}

function formatSpeedSection(theme: ExtensionContext["ui"]["theme"], speed: ResponseSpeed | undefined): string {
	if (!speed) return theme.fg("dim", "-- tps");
	const speedText = speed.tokensPerSecond === undefined ? "--" : formatTokensPerSecond(speed.tokensPerSecond);
	return theme.fg(getSpeedColor(speed), `${speedText} tps${speed.inProgress ? "…" : ""}`);
}

function getSpeedColor(speed: ResponseSpeed): "success" | "warning" | "error" | "dim" {
	const tokensPerSecond = speed.tokensPerSecond;
	if (tokensPerSecond === undefined || tokensPerSecond <= 0) return "dim";
	if (tokensPerSecond >= 20) return "success";
	if (tokensPerSecond >= 5) return "warning";
	return "error";
}

function formatTokensPerSecond(tokensPerSecond: number): string {
	if (tokensPerSecond < 100) return tokensPerSecond.toFixed(1);
	return Math.round(tokensPerSecond).toString();
}

function calculateTokensPerSecond(tokens: number, durationMs: number): number | undefined {
	if (tokens <= 0 || durationMs <= 0) return undefined;
	return tokens / (durationMs / 1_000);
}

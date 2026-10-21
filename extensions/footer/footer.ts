import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ResponseSpeed = {
	tokensPerSecond?: number;
	inProgress: boolean;
};

export default function footer(pi: ExtensionAPI): void {
	let responseStartedAt: number | undefined;
	let liveOutputTokens = 0;
	let responseSpeed: ResponseSpeed | undefined;
	let requestRender: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				dispose() {
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
						formatContextSection(theme, ctx),
						formatSpeedSection(theme, responseSpeed),
						theme.fg("mdLink", formatModelName(ctx)),
					].join(separator);
					return [line];
				},
			};
		});
	});

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		responseStartedAt = Date.now();
		liveOutputTokens = 0;
		responseSpeed = { inProgress: true };
		requestRender?.();
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant" || responseStartedAt === undefined) return;

		const update = event.assistantMessageEvent;
		if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
			liveOutputTokens += Math.max(1, update.delta.length / 4);
		}
		responseSpeed = {
			tokensPerSecond: calculateTokensPerSecond(liveOutputTokens, Date.now() - responseStartedAt),
			inProgress: true,
		};
		requestRender?.();
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") {
			requestRender?.();
			return;
		}

		if (responseStartedAt !== undefined) {
			const outputTokens = event.message.usage?.output || Math.round(liveOutputTokens);
			responseSpeed = {
				tokensPerSecond: calculateTokensPerSecond(outputTokens, Date.now() - responseStartedAt),
				inProgress: false,
			};
		}
		responseStartedAt = undefined;
		liveOutputTokens = 0;
		requestRender?.();
	});

	pi.on("model_select", async () => requestRender?.());
	pi.on("session_shutdown", async () => {
		responseStartedAt = undefined;
		liveOutputTokens = 0;
		responseSpeed = undefined;
		requestRender = undefined;
	});
}

function formatModelName(ctx: ExtensionContext): string {
	return ctx.model?.name || (ctx.model?.id ? ctx.model.id.replace(/^models\//, "") : "no-model");
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

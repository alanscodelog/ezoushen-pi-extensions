/**
 * focus-mode.ts — exchange timing and cost, with process lines and block titles.
 *
 * An *exchange* is one uninterrupted work span: from a prompt you submitted until
 * pi has nothing left to do automatically. A *turn* is a single model response
 * plus the tools it invoked, so a turn ends every time the model finishes
 * speaking, and the turn loop repeats while the model keeps calling tools. One
 * exchange therefore contains one or more turns.
 *
 * The exchange is the primary unit: the status line always shows the running or
 * last exchange, and a card is appended to the transcript when each one settles.
 * Block titles carry the detail; the card shows only exchange totals.
 *
 * Design notes worth keeping:
 *
 * - Timing runs from `before_agent_start` (or `agent_start`, for a run an extension
 *   message starts) to `agent_settled`, not `agent_end`.
 *   After `agent_end` pi may still auto-retry, auto-compact and retry, or drain a
 *   queued follow-up, so ending there would split one work span into several
 *   partial measurements.
 * - A prompt submitted while a run is already in flight continues the same
 *   exchange rather than starting a new one, because pi does not settle in
 *   between the two. `promptCount` records that it happened instead of restarting
 *   the timer and losing the earlier segment.
 * - Throughput is per turn (that turn's output tokens over that turn's wall time),
 *   not per exchange. Tool execution is part of the exchange's wall time, so
 *   dividing output by the whole exchange reports model speed as slower than it
 *   was, by the share of time tools held.
 * - A turn's model time is `durationMs - toolMs`. Tools run after the model has
 *   finished emitting its call, so the two spans do not overlap; this is an
 *   estimate from event timestamps, not an instrumented measurement.
 * - `toolMs` is the union of tool spans, not the sum of their durations. Parallel
 *   tool calls overlap, so summing would double-count wall time and could drive
 *   model time to zero; each tool's own duration is still listed by name.
 * - Time pi spends waiting on an extension prompt (a permission dialog, a
 *   question) is accumulated separately. It stays inside the wall-clock duration
 *   but is reported, so a round that was slow because a dialog sat unanswered is
 *   visible as such.
 * - A session card aggregates totals and carries no per-turn detail; it reports
 *   `turnCount` rather than a `turns` array so both card kinds render alike.
 * - Stats are local to this process and are written to the session file as custom
 *   entries, which do not participate in LLM context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";
import { FoldPicker } from "./src/fold-picker.ts";
import { TranscriptCursor } from "./src/transcript-cursor.ts";
import { HeadlineLengthError, HeadlineScheduler } from "./src/headline-scheduler.ts";
import { ToolFoldModel, type FoldBlockRecord, type ThinkingHeadlinePatch } from "./src/tool-fold.ts";
import { endHoverOnMove, installThinkingFold, installToolFold } from "./src/tool-render.ts";
import { Box, Text } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "exchange-stats";
/**
 * Headline corrections for blocks whose exchange record was already written, such
 * as a model summary that resolves after `agent_settled`. It has no entry renderer,
 * so Pi keeps it out of the transcript; restore applies the latest one per block.
 */
const HEADLINE_ENTRY_TYPE = "exchange-stats-headline";
const STATUS_KEY = "exchange";
/** How often the live status line refreshes while an exchange is running. */
const TICK_MS = 1_000;
/** Above this share of wall time, tool execution is called out in the summary. */
const TOOL_SHARE_NOTE = 0.25;
const FOLD_KEYS = {
	processKey: { default: "ctrl+alt+f", env: "PI_FOCUS_MODE_PROCESS_KEY" },
	exchangeKey: { default: "ctrl+alt+e", env: "PI_FOCUS_MODE_EXCHANGE_KEY" },
	pickerKey: { default: "ctrl+alt+s", env: "PI_FOCUS_MODE_PICKER_KEY" },
	cursorKey: { default: "ctrl+alt+g", env: "PI_FOCUS_MODE_CURSOR_KEY" },
} as const;
const CURSOR_SETTING = { cursorMode: { default: false, env: "PI_FOCUS_MODE_CURSOR_MODE", parseEnv: (value: string) => value === "true" } } as const;
const SUMMARY_SETTING = { summaryModel: { default: "", env: "PI_FOCUS_MODE_SUMMARY_MODEL" } } as const;
/** Every field a card can show, in the order a card shows them. */
const CARD_FIELDS = ["duration", "finishTime", "model", "input", "output", "tps", "cache", "waiting", "cost"] as const;
type CardField = (typeof CARD_FIELDS)[number];
const CARD_FIELDS_SETTING = {
	cardFields: {
		default: [...CARD_FIELDS] as unknown,
		env: "PI_FOCUS_MODE_CARD_FIELDS",
		parseEnv: (value: string): string[] => value.split(",").map((name) => name.trim()).filter(Boolean),
	},
} as const;

interface TokenTotals {
	input: number;
	output: number;
	/** Reasoning/thinking tokens; already included in `output` when reported. */
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

const emptyTotals = (): TokenTotals => ({
	input: 0,
	output: 0,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
});

interface ToolSpan {
	name: string;
	ms: number;
	isError: boolean;
}

/**
 * A tool execution with both endpoints retained. Kept apart from `ToolSpan`
 * because overlapping parallel runs have to be merged before they are summed.
 */
interface ToolRun {
	name: string;
	start: number;
	end: number;
	isError: boolean;
}

interface TurnRecord extends TokenTotals {
	index: number;
	durationMs: number;
	toolMs: number;
	/** `durationMs - toolMs`, see the module note on decomposition. */
	modelMs: number;
	/** Output tokens over this turn's wall time. */
	outputPerSec: number;
	tools: ToolSpan[];
}

interface ExchangeRecord extends TokenTotals {
	kind: "exchange" | "session";
	/** 1-based exchange number; on a session card, the exchange count. */
	index: number;
	/** Prompts folded into the span: above one means a mid-run follow-up. */
	promptCount: number;
	/** Turns in the span. Held separately because a session card has no detail. */
	turnCount: number;
	/** Per-turn detail; always empty on a session card. */
	turns: TurnRecord[];
	startedAt: number;
	endedAt?: number;
	durationMs: number;
	/** Wall time from the first process block to the trailing answer. */
	progressDurationMs?: number;
	waitingMs: number;
	/** Wall time tools held across the span. */
	toolMs: number;
	/** Model time across the span (the turns' `modelMs`); absent on entries before 0.2.0. */
	modelMs?: number;
	model: string;
	stopReason: string;
	/** Present on exchange entries written after block titles became persistent. */
	blocks?: FoldBlockRecord[];
}

type FoldSessionEntry = { type: string; customType?: string; data?: ExchangeRecord; message?: { role: string; timestamp?: number; content?: unknown[]; toolCallId?: string } };

interface StatusContext {
	hasUI: boolean;
	ui: { setStatus(key: string, value: string): void };
}

function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const s = ms / 1_000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function fmtLocalFinishTime(at: number): string {
	const date = new Date(at);
	const time = new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(date);
	const calendarDate = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric" });
	if (calendarDate.format(date) === calendarDate.format(new Date(Date.now()))) return time;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) + " " + time;
}

function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtRate(perSecond: number): string {
	return perSecond >= 10 ? `${Math.round(perSecond)}` : perSecond.toFixed(1);
}

/** Output tokens per second of model time, the turns' wall time less the tools they ran. */
function outputPerSecond(data: ExchangeRecord): number | undefined {
	// Before 0.2.0 only turns recorded model time; session cards and turn-less entries show no rate.
	const modelMs = data.modelMs ?? (data.turns?.length ? data.turns.reduce((sum, turn) => sum + turn.modelMs, 0) : undefined);
	if (!(data.output > 0) || !(modelMs !== undefined && modelMs > 0)) return undefined;
	return data.output / (modelMs / 1_000);
}

function fmtCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "$0";
	return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(4)}`;
}

function fmtCacheUsage(cacheRead: number, cacheWrite: number): string | undefined {
	const read = cacheRead > 0 ? fmtTokens(cacheRead) : undefined;
	const written = cacheWrite > 0 ? fmtTokens(cacheWrite) : undefined;
	if (read && written) return `cache ${read} / ${written} written`;
	if (read) return `cache ${read}`;
	if (written) return `cache ${written} written`;
	return undefined;
}

function plural(n: number, one: string, many = `${one}s`): string {
	return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

/**
 * Names the tool holding the turn open right now. With parallel calls the tool
 * running longest is reported and the rest collapsed into a count, because the
 * status line has room for one.
 */
function openToolText(spans: Map<string, { name: string; start: number }>, now: number): string | undefined {
	let longest: { name: string; start: number } | undefined;
	for (const span of spans.values()) {
		if (!longest || now - span.start > now - longest.start) longest = span;
	}
	if (!longest) return undefined;
	const extra = spans.size > 1 ? ` (+${spans.size - 1})` : "";
	return `${longest.name} ${fmtDuration(now - longest.start)}${extra}`;
}

/**
 * Wall-clock time covered by at least one tool. Parallel calls overlap, so adding
 * their individual durations would count the same instant twice.
 */
function unionMs(runs: ToolRun[]): number {
	if (runs.length === 0) return 0;
	const sorted = [...runs].sort((a: ToolRun, b: ToolRun) => a.start - b.start);
	let total = 0;
	let start = sorted[0].start;
	let end = sorted[0].end;
	for (const run of sorted.slice(1)) {
		if (run.start > end) {
			total += end - start;
			start = run.start;
			end = run.end;
		} else if (run.end > end) {
			end = run.end;
		}
	}
	return total + (end - start);
}

export function registerExchangeStats(pi: ExtensionAPI, toolComponent: typeof ToolExecutionComponent = ToolExecutionComponent, settingsRuntime: SettingsRuntime = {}) {
	let toolFold = new ToolFoldModel();
	let themeContext: { ui: { theme?: { fg(color: "dim" | "accent" | "muted", text: string): string; bg?(color: "selectedBg", text: string): string; italic?(text: string): string }; setStatus(key: string, value: string): void } } | undefined;
	const getTitleTheme = () => themeContext?.ui.theme;
	let outputPad = 1;
	let lastStatus = "";
	const requestRender = () => { if (themeContext) themeContext.ui.setStatus(STATUS_KEY, toolFold.cursorTitle() ? `${lastStatus} · Cursor ${toolFold.cursorTitle()}` : lastStatus); };
	let toolPatch: ReturnType<typeof installToolFold> | undefined;
	let thinkingPatch: ReturnType<typeof installThinkingFold> | undefined;
	let sessionActive = false;
	const resolvedKeys = resolveSettings("focus-mode", FOLD_KEYS, {
		cwd: process.cwd(), hasUI: true, isProjectTrusted: () => false,
	}, settingsRuntime);
	const cursorMode = resolveSettings("focus-mode", CURSOR_SETTING, {
		cwd: process.cwd(), hasUI: true, isProjectTrusted: () => false,
	}, settingsRuntime).cursorMode.value === true;
	const validKey = (value: unknown): value is KeyId => {
		if (typeof value !== "string") return false;
		const parts = value.split("+");
		const base = parts.pop();
		return parts.length > 0 && new Set(parts).size === parts.length &&
			parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part)) &&
			base !== undefined && (/^[a-z0-9]$/.test(base) || ["enter", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end"].includes(base));
	};
	const keys = Object.fromEntries(Object.entries(FOLD_KEYS).map(([name, definition]) => {
		const value = resolvedKeys[name as keyof typeof FOLD_KEYS].value;
		return [name, validKey(value) ? value : definition.default];
	})) as Record<keyof typeof FOLD_KEYS, KeyId>;
	const invalidKey = Object.entries(FOLD_KEYS).some(([name]) => !validKey(resolvedKeys[name as keyof typeof FOLD_KEYS].value));
	let warnedAboutKey = false;
	let warnedAboutToolFold = false;
	let warnedAboutThinkingFold = false;
	let summaryScheduler: HeadlineScheduler | undefined;
	let cardFields = new Set<CardField>(CARD_FIELDS);
	let summarySession = 0;
	let restoredEntries: FoldSessionEntry[] = [];
	let sessionTotals = {
		...emptyTotals(),
		exchanges: 0,
		turnCount: 0,
		durationMs: 0,
		toolMs: 0,
		waitingMs: 0,
		modelMs: 0,
	};
	let sessionStartedAt = 0;

	let running = false;
	let startedAt = 0;
	let promptCount = 0;
	let exchangeIndex = 0;
	let model = "unknown";
	let stopReason = "stop";
	let turns: TurnRecord[] = [];
	let totals = emptyTotals();
	let waitingMs = 0;
	let waitingStart: number | undefined;
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let liveRefresh: (() => void) | undefined;

	/** Tool spans still open in the turn in progress, keyed by toolCallId. */
	let activeTurn: { index: number; startedAt: number; spans: Map<string, { name: string; start: number }> } | undefined;
	let activeToolRuns: ToolRun[] = [];

	function setStatus(text: string, ctx: StatusContext): void {
		if (!ctx.hasUI) return;
		lastStatus = text;
		ctx.ui.setStatus(STATUS_KEY, toolFold.cursorTitle() ? `${text} · Cursor ${toolFold.cursorTitle()}` : text);
	}

	pi.registerShortcut(keys.processKey, { description: "Toggle latest process", handler: (ctx) => {
		if (toolFold.toggleLatestProcess() !== undefined) { themeContext = ctx; requestRender(); }
	} });
	pi.registerShortcut(keys.exchangeKey, { description: "Toggle latest exchange", handler: (ctx) => {
		if (toolFold.toggleLatestExchange() !== undefined) { themeContext = ctx; requestRender(); }
	} });
	pi.registerShortcut(keys.pickerKey, { description: "Choose exchange, process or block to fold", handler: async (ctx) => {
		if (!ctx.hasUI) return;
		await ctx.ui.custom((tui, theme, _keybindings, done) => new FoldPicker(toolFold, () => ctx.ui.theme ?? theme, () => tui.requestRender(), () => done(undefined)), { overlay: true });
	} });
	if (cursorMode) pi.registerShortcut(keys.cursorKey, { description: "Move through transcript folds", handler: async (ctx) => {
		if (!ctx.hasUI || !toolFold.startCursor()) return;
		themeContext = ctx;
		requestRender();
		try {
			await ctx.ui.custom((_tui, _theme, _keybindings, done) => new TranscriptCursor(toolFold, requestRender, () => done(undefined)), { overlay: true });
		} finally {
			toolFold.stopCursor();
			requestRender();
		}
	} });

	/** Live line: elapsed, turns finished, and the tool currently running. */
	function liveStatusText(): string {
		const now = Date.now();
		const parts = [`⏱ ${fmtDuration(now - startedAt)}`];
		if (turns.length > 0) parts.push(`${plural(turns.length, "turn")} done`);
		const toolText = activeTurn ? openToolText(activeTurn.spans, now) : undefined;
		if (toolText) parts.push(toolText);
		else if (activeTurn) parts.push(`turn ${activeTurn.index}`);
		return parts.join(" · ");
	}

	function stopLiveTimer(): void {
		if (liveTimer) clearInterval(liveTimer);
		liveTimer = undefined;
		liveRefresh = undefined;
	}

	function resetExchangeState(): void {
		running = false;
		startedAt = 0;
		promptCount = 0;
		turns = [];
		totals = emptyTotals();
		waitingMs = 0;
		waitingStart = undefined;
		activeTurn = undefined;
		activeToolRuns = [];
		stopLiveTimer();
	}

	function restoreSession(ctx: { sessionManager?: { getBranch(): unknown[] } }): void {
		const entries = (ctx.sessionManager?.getBranch() ?? []) as FoldSessionEntry[];
		restoredEntries = entries;
		toolFold.clear((id) => {
			let correction: ThinkingHeadlinePatch | undefined;
			for (let index = restoredEntries.length - 1; index >= 0; index--) {
				const entry = restoredEntries[index];
				if (entry.type !== "custom") continue;
				// SAFETY: an exchange-stats-headline entry always carries a ThinkingHeadlinePatch as data; TypeScript cannot map customType -> data shape, so reinterpret entry.data once.
								const patch = entry.customType === HEADLINE_ENTRY_TYPE ? entry.data as unknown as ThinkingHeadlinePatch | undefined : undefined;
				if (!correction && patch?.id === id) correction = patch;
				if (entry.customType !== ENTRY_TYPE) continue;
				const found = entry.data?.blocks?.find((block) => block.id === id);
				if (found) return found.kind === "thinking" && correction ? { ...found, headline: correction.headline, headlineSource: correction.headlineSource } : found;
			}
			return undefined;
		});
		// Completed entries only seed history. A compaction or tree switch can arrive while a
		// run is in flight (Pi auto-compacts before settling); that run keeps the index it
		// began with, and branch messages after the last record belong to it.
		const recordedIndex = entries.reduce((highest, entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data?.kind === "exchange"
			? Math.max(highest, entry.data.index) : highest, 0);
		if (!running) exchangeIndex = recordedIndex;
		const lastCompaction = entries.findLastIndex((entry) => entry.type === "compaction");
		const active = entries.slice(lastCompaction + 1);
		let nextExchange = active.find((entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data?.kind === "exchange")?.data?.index ?? (running ? exchangeIndex : exchangeIndex + 1);
		let inExchange = false;
		for (const entry of active) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data?.kind === "exchange") {
				toolFold.endExchange(entry.data.progressDurationMs ?? entry.data.durationMs);
				inExchange = false;
				nextExchange = entry.data.index + 1;
			} else if (entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
				if (!inExchange) { toolFold.beginExchange(nextExchange); inExchange = true; }
				toolFold.ingest(entry.message as Parameters<ToolFoldModel["ingest"]>[0]);
			} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
				toolFold.end(entry.message.toolCallId, false, { content: entry.message.content as Array<{ type: string; text?: string }> });
			}
		}
		// A trailing exchange without a record is history unless it is the run in flight.
		if (!running && inExchange) toolFold.endExchange();
		else if (running && !inExchange) toolFold.beginExchange(exchangeIndex);
	}

	/** The fields cards show; unknown names are dropped with one warning, and a list with none valid shows every field. */
	function resolveCardFields(ctx: ExtensionContext, session: number): Set<CardField> {
		const value = resolveSettings("focus-mode", CARD_FIELDS_SETTING, {
			cwd: ctx.cwd ?? process.cwd(), hasUI: ctx.hasUI, isProjectTrusted: () => ctx.isProjectTrusted?.() ?? false,
		}, settingsRuntime).cardFields.value;
		const names = Array.isArray(value) ? value.map(String) : [];
		const known = names.filter((name): name is CardField => (CARD_FIELDS as readonly string[]).includes(name));
		if (known.length !== names.length || !Array.isArray(value)) {
			const unknown = Array.isArray(value) ? names.filter((name) => !known.includes(name as CardField)).join(", ") : JSON.stringify(value);
			announce(ctx, `focus-mode: cardFields ignores ${unknown}; fields are ${CARD_FIELDS.join(", ")}`, "warning", `focus-mode:card-fields:${session}`);
		}
		return new Set(known.length > 0 ? known : CARD_FIELDS);
	}

	// ---- Transcript card ----

	pi.registerEntryRenderer<ExchangeRecord>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const dimText = (text: string) => {
			const colored = theme.fg("dim", text);
			return theme.italic?.(colored) ?? colored;
		};
		// The card is not a fold control: a move onto it ends a fold hover; everything else stays Box's.
		const boxMouse = box.handleMouse.bind(box);
		box.handleMouse = (event) => endHoverOnMove(event) ?? boxMouse(event);
		if (!data) {
			box.addChild(new Text(dimText("(no stats)"), 0, 0));
			return box;
		}

		const show = (field: CardField) => cardFields.has(field);
		const headline: string[] = [];
		if (data.kind === "session") headline.push(`📊 Session · ${plural(data.turnCount, "turn")} across ${plural(data.index, "exchange")}`);
		else {
			if (show("duration")) headline.push(`⏱ ${fmtDuration(data.durationMs)}`);
			if (show("finishTime") && data.endedAt !== undefined) headline.push(fmtLocalFinishTime(data.endedAt));
		}
		if (show("model")) headline.push(data.model);

		const summary: string[] = [];
		if (show("input")) summary.push(`in ${fmtTokens(data.input)}`);
		if (show("output")) summary.push(`out ${fmtTokens(data.output)}`);
		const rate = show("tps") ? outputPerSecond(data) : undefined;
		if (rate !== undefined) summary.push(`${fmtRate(rate)} tps`);
		const cache = show("cache") ? fmtCacheUsage(data.cacheRead, data.cacheWrite) : undefined;
		if (cache) summary.push(cache);
		if (show("waiting") && data.waitingMs > 0) summary.push(`waiting ${fmtDuration(data.waitingMs)}`);
		if (show("cost")) summary.push(fmtCost(data.cost));
		const metrics = summary.length > 0 ? `(${summary.join(" · ")})` : "";
		// Chosen fields can all be empty for this entry (no finish time, no waiting); keep the card readable.
		const line = [headline.join(" · "), metrics].filter(Boolean).join(" ") || `⏱ ${fmtDuration(data.durationMs)}`;
		box.addChild(new Text(dimText(line), 0, 0));

		return box;
	});

	// ---- Lifecycle ----

	pi.on("session_start", (_event, ctx) => {
		if (sessionActive) return;
		sessionActive = true;
		resetExchangeState();
		toolFold = new ToolFoldModel();
		outputPad = 1;
		lastStatus = "";
		restoredEntries = [];
		sessionTotals = { ...emptyTotals(), exchanges: 0, turnCount: 0, durationMs: 0, toolMs: 0, waitingMs: 0, modelMs: 0 };
		toolPatch = installToolFold(toolComponent, toolFold, getTitleTheme, () => outputPad);
		thinkingPatch = installThinkingFold(AssistantMessageComponent, toolFold, getTitleTheme, requestRender, (padding) => { outputPad = padding; });
		themeContext = ctx;
		const session = ++summarySession;
		summaryScheduler?.dispose();
		summaryScheduler = undefined;
		cardFields = resolveCardFields(ctx, session);
		const summaryValue = resolveSettings("focus-mode", SUMMARY_SETTING, {
			cwd: ctx.cwd ?? process.cwd(), hasUI: ctx.hasUI, isProjectTrusted: () => ctx.isProjectTrusted?.() ?? false,
		}, settingsRuntime).summaryModel.value;
		const configuredModel = typeof summaryValue === "string" ? summaryValue.trim() : "";
		if (configuredModel) {
			const slash = configuredModel.indexOf("/");
			const chosen = slash > 0 ? ctx.modelRegistry?.find(configuredModel.slice(0, slash), configuredModel.slice(slash + 1)) : undefined;
			if (!chosen) {
				announce(ctx, `focus-mode: unknown summaryModel ${configuredModel}; using trace sentence`, "warning", `focus-mode:unknown-summary:${session}`);
			} else {
				summaryScheduler = new HeadlineScheduler({
					summarize: async (trace, signal) => {
						const response = await ctx.modelRegistry.streamSimple(chosen, {
							systemPrompt: "Summarize this live thinking trace as a headline of at most 10 words. Return only the headline.",
							messages: [{ role: "user", content: [{ type: "text", text: trace }], timestamp: Date.now() }],
						}, { reasoning: "off", maxTokens: 32, signal }).result();
						if (response.stopReason === "length" && !response.content.some((part) => part.type === "text" && part.text.trim())) {
							throw new HeadlineLengthError("model did not answer within its output cap");
						}
						if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? "headline request failed");
						return response.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
					},
					onHeadline: (key, headline) => {
						const [timestamp, index] = key.split(":").map(Number);
						const patch = toolFold.setThinkingHeadline({ timestamp }, index, headline);
						if (patch) {
							try {
								pi.appendEntry<ThinkingHeadlinePatch>(HEADLINE_ENTRY_TYPE, patch);
								// SAFETY: restore reads entry.data as a ThinkingHeadlinePatch, so persist it under the ExchangeRecord generic appendEntry<T>() requires; the object is really the headline patch.
																restoredEntries.push({ type: "custom", customType: HEADLINE_ENTRY_TYPE, data: patch as unknown as ExchangeRecord });
							} catch {
								// See the agent_settled note on runtimes without entry persistence.
							}
						}
						requestRender();
					},
					onFailure: (reason, message) => {
						const detail = reason === "length"
							? "model did not answer within its output cap; set thinkingLevelMap.off to \"none\" for this model"
							: reason === "timeout" ? "request timed out" : (message ?? "headline request failed").replace(/\s+/g, " ").trim().slice(0, 120);
						announce(ctx, `focus-mode: headline summary ${configuredModel}: ${detail}; using trace sentence`, "warning", `focus-mode:headline-failure:${session}`);
					},
				});
			}
		}
		if (invalidKey && !warnedAboutKey) {
			announce(ctx, "focus-mode: invalid fold shortcut; using default key", "warning", "focus-mode:invalid-fold-key");
			warnedAboutKey = true;
		}
		if (!toolPatch.installed && !warnedAboutToolFold) {
			announce(ctx, "focus-mode: tool folding unavailable; Pi tool rows remain native", "warning");
			warnedAboutToolFold = true;
		}
		if (!thinkingPatch.installed && !warnedAboutThinkingFold) {
			announce(ctx, "focus-mode: thinking folding unavailable; Pi thinking remains native", "warning");
			warnedAboutThinkingFold = true;
		}
		restoreSession(ctx);
		sessionStartedAt = Date.now();
		setStatus("⏱ ready", ctx);
	});

	pi.on("session_shutdown", () => {
		if (!sessionActive) return;
		sessionActive = false;
		themeContext = undefined;
		toolFold.stopCursor();
		summaryScheduler?.dispose();
		summaryScheduler = undefined;
		toolPatch?.restore();
		thinkingPatch?.restore();
		toolPatch = undefined;
		thinkingPatch = undefined;
		resetExchangeState();
		toolFold = new ToolFoldModel();
		restoredEntries = [];
	});

	pi.on("session_compact", (_event, ctx) => { restoreSession(ctx); requestRender(); });
	pi.on("session_tree", (_event, ctx) => { restoreSession(ctx); requestRender(); });

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		toolFold.observeThinking(event.message, event.assistantMessageEvent, event.message.usage?.reasoning);
		toolFold.ingest(event.message);
		const update = event.assistantMessageEvent;
		if (update.type === "thinking_delta" && update.contentIndex !== undefined) {
			let start = update.contentIndex;
			while (start > 0 && event.message.content[start - 1]?.type === "thinking") start--;
			let end = start;
			while (event.message.content[end]?.type === "thinking") end++;
			const trace = event.message.content.slice(start, end).map((item) => item.type === "thinking" ? item.thinking.trim() : "").filter(Boolean).join("\n\n");
			if (trace) summaryScheduler?.observe(`${event.message.timestamp}:${start}`, trace);
		} else if (update.type !== "thinking_start") {
			for (let index = 0; index < event.message.content.length; index++) {
				if (event.message.content[index].type === "thinking") summaryScheduler?.settle(`${event.message.timestamp}:${index}`);
			}
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			toolFold.ingest(event.message);
			toolFold.settleThinking(event.message);
			for (let index = 0; index < event.message.content.length; index++) {
				if (event.message.content[index].type === "thinking") summaryScheduler?.settle(`${event.message.timestamp}:${index}`);
			}
		}
	});

	function beginExchange(ctx: ExtensionContext, prompts: number): void {
		running = true;
		toolFold.beginExchange(exchangeIndex + 1);
		startedAt = Date.now();
		promptCount = prompts;
		exchangeIndex++;
		turns = [];
		totals = emptyTotals();
		waitingMs = 0;
		waitingStart = undefined;
		activeTurn = undefined;
		activeToolRuns = [];
		model = ctx.model ? ctx.model.name || ctx.model.id : "unknown";
		stopReason = "stop";

		stopLiveTimer();
		setStatus(liveStatusText(), ctx);
		liveRefresh = () => setStatus(liveStatusText(), ctx);
		liveTimer = setInterval(() => {
			try {
				liveRefresh?.();
				summaryScheduler?.tick();
			} catch {
				// /new or /reload invalidates the runner while a run is in flight; a stale
				// status update is not worth failing the turn over.
				stopLiveTimer();
			}
		}, TICK_MS);
	}

	pi.on("before_agent_start", (_event, ctx) => {
		if (running) {
			// A follow-up arrived mid-run; pi will not settle until it drains, so this
			// continues the current span instead of restarting it.
			promptCount++;
			return;
		}
		beginExchange(ctx, 1);
	});

	// A run started by an extension message (a background-task notification, for example)
	// skips before_agent_start, so it begins here; its response gets a card like any other.
	pi.on("agent_start", (_event, ctx) => {
		if (!running) beginExchange(ctx, 0);
	});

	pi.on("turn_start", (event, _ctx) => {
		if (!running) return;
		activeTurn = { index: event.turnIndex ?? turns.length + 1, startedAt: Date.now(), spans: new Map() };
		activeToolRuns = [];
	});

	pi.on("tool_execution_start", (event, _ctx) => {
		toolFold.start(event.toolCallId, event.toolName);
		if (!running || !activeTurn) return;
		activeTurn.spans.set(event.toolCallId, { name: event.toolName, start: Date.now() });
	});

	pi.on("tool_execution_end", (event, _ctx) => {
		toolFold.end(event.toolCallId, Boolean(event.isError), event.result);
		if (!running || !activeTurn) return;
		const open = activeTurn.spans.get(event.toolCallId);
		if (open) {
			activeTurn.spans.delete(event.toolCallId);
			activeToolRuns.push({
				name: event.toolName ?? open.name,
				start: open.start,
				end: Date.now(),
				isError: Boolean(event.isError),
			});
			return;
		}
		// A tool whose start arrived outside a turn: still record it, so tool time is
		// not silently understated. A zero-length span adds nothing to the union.
		const at = Date.now();
		activeToolRuns.push({ name: event.toolName, start: at, end: at, isError: Boolean(event.isError) });
	});

	pi.on("turn_end", (event, _ctx) => {
		if (!running || !activeTurn) return;
		const endedAt = Date.now();

		// A span still open at turn end would otherwise count toward the turn duration
		// but be missing from the breakdown.
		for (const [id, open] of activeTurn.spans) {
			activeToolRuns.push({ name: open.name, start: open.start, end: endedAt, isError: false });
			activeTurn.spans.delete(id);
		}

		const usage = event.message?.role === "assistant" ? event.message.usage : undefined;
		const durationMs = endedAt - activeTurn.startedAt;
		const toolMs = unionMs(activeToolRuns);
		const output = usage?.output ?? 0;

		turns.push({
			index: activeTurn.index,
			durationMs,
			toolMs,
			modelMs: Math.max(0, durationMs - toolMs),
			outputPerSec: durationMs > 0 ? output / (durationMs / 1_000) : 0,
			tools: activeToolRuns.map((run: ToolRun) => ({ name: run.name, ms: run.end - run.start, isError: run.isError })),
			input: usage?.input ?? 0,
			output,
			reasoning: usage?.reasoning ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			totalTokens: usage?.totalTokens ?? 0,
			cost: usage?.cost?.total ?? 0,
		});

		totals.input += usage?.input ?? 0;
		totals.output += output;
		totals.reasoning += usage?.reasoning ?? 0;
		totals.cacheRead += usage?.cacheRead ?? 0;
		totals.cacheWrite += usage?.cacheWrite ?? 0;
		totals.totalTokens += usage?.totalTokens ?? 0;
		totals.cost += usage?.cost?.total ?? 0;

		if (event.message?.stopReason) stopReason = event.message.stopReason;
		activeTurn = undefined;
		activeToolRuns = [];
	});

	// Time pi spends blocked on an extension prompt stays inside the wall clock but
	// is tracked apart, so it can be reported instead of mistaken for work.
	pi.on("ui_prompt_start", (_event, _ctx) => {
		if (!running || waitingStart !== undefined) return;
		waitingStart = Date.now();
	});

	pi.on("ui_prompt_end", (_event, _ctx) => {
		if (waitingStart === undefined) return;
		waitingMs += Date.now() - waitingStart;
		waitingStart = undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!running) return;
		const endedAt = Date.now();
		if (waitingStart !== undefined) {
			waitingMs += endedAt - waitingStart;
			waitingStart = undefined;
		}

		const durationMs = endedAt - startedAt;
		const progressDurationMs = toolFold.progressDurationForExchange(exchangeIndex);
		const toolMs = turns.reduce((sum: number, turn: TurnRecord) => sum + turn.toolMs, 0);
		const modelMs = turns.reduce((sum: number, turn: TurnRecord) => sum + turn.modelMs, 0);
		const record: ExchangeRecord = {
			...totals,
			kind: "exchange",
			index: exchangeIndex,
			promptCount,
			turnCount: turns.length,
			turns,
			startedAt,
			endedAt,
			durationMs,
			...(progressDurationMs === undefined ? {} : { progressDurationMs }),
			waitingMs,
			toolMs,
			modelMs,
			model,
			stopReason,
			blocks: toolFold.recordsForExchange(exchangeIndex),
		};

		stopLiveTimer();

		sessionTotals.input += totals.input;
		sessionTotals.output += totals.output;
		sessionTotals.reasoning += totals.reasoning;
		sessionTotals.cacheRead += totals.cacheRead;
		sessionTotals.cacheWrite += totals.cacheWrite;
		sessionTotals.totalTokens += totals.totalTokens;
		sessionTotals.cost += totals.cost;
		sessionTotals.exchanges++;
		sessionTotals.turnCount += turns.length;
		sessionTotals.durationMs += durationMs;
		sessionTotals.toolMs += toolMs;
		sessionTotals.waitingMs += waitingMs;
		sessionTotals.modelMs += modelMs;

		try {
			pi.appendEntry<ExchangeRecord>(ENTRY_TYPE, record);
			if (!restoredEntries.some((entry) => entry.data === record)) restoredEntries.push({ type: "custom", customType: ENTRY_TYPE, data: record });
		} catch {
			// Entry persistence is unavailable in print/JSON mode and on a stale runner
			// after /new; the status line below still reports the span.
		}

		const parts = [`⏱ ${fmtDuration(durationMs)}`, plural(turns.length, "turn")];
		if (toolMs > 0 && durationMs > 0 && toolMs / durationMs >= TOOL_SHARE_NOTE) {
			parts.push(`tools ${fmtDuration(toolMs)}`);
		}
		parts.push(`out ${fmtTokens(totals.output)}`);
		if (totals.cost > 0) parts.push(fmtCost(totals.cost));
		if (waitingMs > 0) parts.push(`waiting ${fmtDuration(waitingMs)}`);
		setStatus(parts.join(" · "), ctx);

		toolFold.endExchange();
		toolFold.releaseExchangeRecords();
		resetExchangeState();
	});

	 pi.registerCommand("sessionstats", {
		description: "Append a cumulative summary card of this session's totals",
		handler: () => {
			const record: ExchangeRecord = {
				...sessionTotals,
				kind: "session",
				index: sessionTotals.exchanges,
				promptCount: sessionTotals.exchanges,
				turnCount: sessionTotals.turnCount,
				turns: [],
				startedAt: sessionStartedAt,
				endedAt: Date.now(),
				durationMs: sessionTotals.durationMs,
				waitingMs: sessionTotals.waitingMs,
				toolMs: sessionTotals.toolMs,
				model: `${plural(sessionTotals.turnCount, "turn")} tracked`,
				stopReason: "session",
			};
			try {
				pi.appendEntry<ExchangeRecord>(ENTRY_TYPE, record);
			} catch {
				// See the agent_settled note on runtimes without entry persistence.
			}
		},
	});
}

export default registerExchangeStats;

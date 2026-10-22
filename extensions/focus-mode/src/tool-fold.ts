interface ThinkingEvent {
	type: string;
	contentIndex?: number;
	delta?: string;
}

interface ThinkingBlock {
	startedAt: number;
	endedAt?: number;
	characters: number;
	tokens?: number;
	headline?: string;
}

export type FoldBlockRecord =
	| { kind: "thinking"; id: string; durationMs?: number; startedAt?: number; endedAt?: number; status: "done"; wordCount: number; headline: string; headlineSource: "model" | "trace" }
	| { kind: "tool"; id: string; durationMs?: number; startedAt?: number; endedAt?: number; status: "ok" | "error" | "unknown"; lineCount: number };

/** A headline correction for a thinking block whose exchange record is already saved. */
export interface ThinkingHeadlinePatch { id: string; headline: string; headlineSource: "model" | "trace" }

interface ThinkingMessage {
	timestamp?: number;
}

interface ProcessMessage extends ThinkingMessage {
	content: Array<{ type: string; thinking?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }>;
}

type ProcessBlock =
	| { kind: "thinking"; key: string; message: ThinkingMessage; index: number; trace: string }
	| { kind: "tool"; key: string };

interface Process {
	id: string;
	exchange: number;
	blocks: ProcessBlock[];
	open: boolean;
	/** Set once its exchange settles or is restored from history; it then shows no live activity. */
	settled: boolean;
}

type ExchangeItem = { key: string; exchange: number; startedAt: number; kind: "block" | "text" };
type ExchangeProgress = {
	exchange: number;
	lead: string;
	open: boolean;
	durationMs: number;
	thinking: number;
	tools: number;
	notes: number;
};
type FoldControl =
	| { kind: "progress"; exchange: number }
	| { kind: "process"; id: string }
	| { kind: "thinking"; message: ThinkingMessage; index: number }
	| { kind: "tool"; id: string };

const MAX_THINKING_MESSAGES = 256;

function elapsed(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function headline(trace: string, streaming: boolean): string {
	const plain = trace.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "").replace(/\*\*|`/g, "");
	let start = 0;
	let last = "Thinking";
	const boundaries = streaming ? /[.?!]+(?=\s)|[。？！]+|\r?\n/g : /[.?!]+(?=\s|$)|[。？！]+|\r?\n/g;
	for (const end of plain.matchAll(boundaries)) {
		const sentence = plain.slice(start, end.index + end[0].length).trim().replace(/\s+/g, " ");
		if (sentence) last = sentence;
		start = end.index + end[0].length;
	}
	return last;
}
const traceHeadline = headline;

/** Holds display timing for each thinking content item in an assistant message. */
class ThinkingFoldModel {
	private blocks = new Map<number, Map<number, ThinkingBlock>>();
	private untimedBlocks = new WeakMap<object, Map<number, ThinkingBlock>>();
	private now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	private forMessage(message: ThinkingMessage, create: boolean): Map<number, ThinkingBlock> | undefined {
		if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) {
			const existing = this.untimedBlocks.get(message);
			if (existing || !create) return existing;
			const blocks = new Map<number, ThinkingBlock>();
			this.untimedBlocks.set(message, blocks);
			return blocks;
		}
		const existing = this.blocks.get(message.timestamp);
		if (existing || !create) return existing;
		// Retain recent completed messages for Pi's history rebuilds without growing per delta.
		if (this.blocks.size >= MAX_THINKING_MESSAGES) this.blocks.delete(this.blocks.keys().next().value!);
		const blocks = new Map<number, ThinkingBlock>();
		this.blocks.set(message.timestamp, blocks);
		return blocks;
	}

	observe(message: ThinkingMessage, event: ThinkingEvent, reasoningTokens?: number): void {
		const blocks = this.forMessage(message, event.type === "thinking_delta");
		if (!blocks) return;
		const at = this.now();
		if (event.type === "thinking_delta" && event.contentIndex !== undefined) {
			const block = blocks.get(event.contentIndex) ?? { startedAt: at, characters: 0 };
			block.characters += event.delta?.length ?? 0;
			if (reasoningTokens !== undefined && reasoningTokens > 0) block.tokens = reasoningTokens;
			blocks.set(event.contentIndex, block);
		} else if (event.type === "thinking_end") {
			const block = event.contentIndex === undefined ? undefined : blocks.get(event.contentIndex);
			if (block && block.endedAt === undefined) block.endedAt = at;
		} else if (event.type !== "thinking_start") {
			for (const block of blocks.values()) {
				if (block.endedAt === undefined) block.endedAt = at;
			}
		}
	}

	settle(message: ThinkingMessage): void {
		for (const block of this.forMessage(message, false)?.values() ?? []) {
			if (block.endedAt === undefined) block.endedAt = this.now();
		}
	}

	setHeadline(message: ThinkingMessage, index: number, headline: string | undefined): void {
		const block = this.forMessage(message, false)?.get(index);
		if (block) block.headline = headline;
	}

	record(message: ThinkingMessage, index: number, trace: string): FoldBlockRecord {
		const block = this.forMessage(message, false)?.get(index);
		return { kind: "thinking", id: `thinking:${message.timestamp}:${index}`,
			durationMs: block?.endedAt === undefined ? undefined : Math.max(0, block.endedAt - block.startedAt),
			startedAt: block?.startedAt, endedAt: block?.endedAt, status: "done",
			wordCount: trace.trim().split(/\s+/).filter(Boolean).length,
			headline: block?.headline ?? headline(trace, false), headlineSource: block?.headline ? "model" : "trace" };
	}

	title(message: ThinkingMessage, index: number, trace: string, streaming: boolean, saved?: FoldBlockRecord): string {
		const block = this.forMessage(message, false)?.get(index);
		const ms = saved?.durationMs ?? (block ? Math.max(0, (block.endedAt ?? this.now()) - block.startedAt) : undefined);
		const label = saved?.kind === "thinking" ? saved.headline : block?.headline ?? headline(trace, streaming && block?.endedAt === undefined);
		if (!streaming || block?.endedAt !== undefined) {
			const words = saved?.kind === "thinking" ? saved.wordCount : trace.trim().split(/\s+/).filter(Boolean).length;
			return `◈ ${label} · ${ms === undefined ? "—" : elapsed(ms)} · ${words} ${words === 1 ? "word" : "words"}`;
		}
		const count = block?.tokens ?? Math.max(1, Math.ceil((block?.characters ?? trace.length) / 4));
		const prefix = block?.tokens === undefined ? "~" : "";
		const rate = ms !== undefined && ms > 0 ? Math.round(count / (ms / 1000)) : 0;
		return `◈ ${label} · ${ms === undefined ? "—" : elapsed(ms)} · ${prefix}${count} tok · ${prefix}${rate} tok/s`;
	}

	timing(message: ThinkingMessage, index: number): { start: number; end?: number } | undefined {
		const block = this.forMessage(message, false)?.get(index);
		return block && { start: block.startedAt, end: block.endedAt };
	}
}

interface ToolBlock {
	name: string;
	args?: Record<string, unknown>;
	startedAt?: number;
	endedAt?: number;
	isError: boolean;
	result?: { content?: Array<{ type: string; text?: string }> };
	open: boolean;
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function summary(args?: Record<string, unknown>): string {
	if (!args) return "";
	for (const key of ["command", "path", "pattern"]) {
		if (typeof args[key] === "string") return args[key].replace(/\s+/g, " ").trim();
	}
	const value = Object.values(args).find((item) => typeof item === "string");
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function lineCount(result?: ToolBlock["result"]): number {
	const output = result?.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
	if (!output) return 0;
	return output.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Holds process membership, fold state, and display timing for assistant blocks. */
export class ToolFoldModel {
	private blocks = new Map<string, ToolBlock>();
	private processList: Process[] = [];
	private processById = new Map<string, Process>();
	private processByBlock = new Map<string, Process>();
	private seenContent = new Map<number, Set<number>>();
	private exchangeItems: ExchangeItem[] = [];
	private progress = new Map<number, ExchangeProgress>();
	private progressByItem = new Map<string, ExchangeProgress>();
	private openProcess?: Process;
	private openThinking = new Set<string>();
	private currentExchange = 0;
	private now: () => number;
	private thinking: ThinkingFoldModel;
	private saved?: (id: string) => FoldBlockRecord | undefined;
	private pendingThinking = new Map<string, FoldBlockRecord>();
	private cursorActive = false;
	private cursorKey?: string;

	constructor(now: () => number = Date.now) {
		this.now = now;
		this.thinking = new ThinkingFoldModel(now);
	}

	/** Rebuilds process membership from the active branch while keeping restored stats in session entries. */
	clear(saved?: (id: string) => FoldBlockRecord | undefined): void {
		this.blocks.clear();
		this.processList = [];
		this.processById.clear();
		this.processByBlock.clear();
		this.seenContent.clear();
		this.exchangeItems = [];
		this.progress.clear();
		this.progressByItem.clear();
		this.openProcess = undefined;
		this.openThinking.clear();
		this.currentExchange = 0;
		this.thinking = new ThinkingFoldModel(this.now);
		this.pendingThinking.clear();
		this.cursorActive = false;
		this.cursorKey = undefined;
		this.saved = saved;
	}

	/**
	 * Returns the saved display record of each block in the exchange: timing, status
	 * and counts, plus each thinking block's headline. That headline is the model
	 * summary or the trace's last complete sentence, so it can repeat trace text;
	 * the rest of the trace, tool arguments and results stay in Pi messages.
	 */
	recordsForExchange(exchange: number): FoldBlockRecord[] {
		return this.processList.filter((process) => process.exchange === exchange).flatMap((process) => process.blocks.map((block): FoldBlockRecord => {
			if (block.kind === "thinking") return this.pendingThinking.get(block.key) ?? this.thinking.record(block.message, block.index, block.trace);
			const tool = this.blocks.get(block.key.slice(5));
			return { kind: "tool", id: block.key, durationMs: tool?.startedAt === undefined || tool.endedAt === undefined ? undefined : Math.max(0, tool.endedAt - tool.startedAt),
				startedAt: tool?.startedAt, endedAt: tool?.endedAt, status: !tool?.endedAt ? "unknown" : tool.isError ? "error" : "ok", lineCount: lineCount(tool?.result) };
		}));
	}

	releaseExchangeRecords(): void { this.pendingThinking.clear(); }

	/** Adds newly visible content in message order; repeated snapshots keep existing membership. */
	ingest(message: ProcessMessage): void {
		if (typeof message?.timestamp !== "number" || !Number.isFinite(message.timestamp) || !Array.isArray(message.content)) return;
		const seen = this.seenContent.get(message.timestamp) ?? new Set<number>();
		this.seenContent.set(message.timestamp, seen);
		for (let index = 0; index < message.content.length; index++) {
			const item = message.content[index];
			if (item.type === "thinking") {
				const start = index;
				const traces: string[] = [];
				while (message.content[index]?.type === "thinking") {
					if (message.content[index].thinking?.trim()) traces.push(message.content[index].thinking!.trim());
					index++;
				}
				index--;
				if (!traces.length) continue;
				const key = `thinking:${message.timestamp}:${start}`;
				const existing = this.processByBlock.get(key)?.blocks.find((block) => block.key === key);
			if (existing?.kind === "thinking") existing.trace = traces.join("\n\n");
				else this.append({ kind: "thinking", key, message: { timestamp: message.timestamp }, index: start, trace: traces.join("\n\n") });
				continue;
			}
			if (seen.has(index)) continue;
			if (item.type === "text") {
				if (!item.text?.trim()) continue;
				this.exchangeItems.push({ key: `text:${message.timestamp}:${index}`, exchange: Math.max(1, this.currentExchange), startedAt: this.now(), kind: "text" });
				this.openProcess = undefined;
			}
			if (item.type === "toolCall" && item.id) {
				this.append({ kind: "tool", key: `tool:${item.id}` });
				this.observe(item.id, item.name ?? "tool", item.arguments ?? {});
			}
			if (item.type === "toolCall" && !item.id) continue;
			seen.add(index);
		}
	}

	private append(block: ProcessBlock): void {
		if (this.processByBlock.has(block.key)) return;
		if (!this.openProcess) {
			this.openProcess = { id: block.key, exchange: Math.max(1, this.currentExchange), blocks: [], open: false, settled: false };
			this.processList.push(this.openProcess);
			this.processById.set(this.openProcess.id, this.openProcess);
		}
		this.openProcess.blocks.push(block);
		this.processByBlock.set(block.key, this.openProcess);
		this.exchangeItems.push({ key: block.key, exchange: this.openProcess.exchange, startedAt: this.now(), kind: "block" });
	}

	processes(): ReadonlyArray<Process> { return this.processList; }
	hasTextImmediatelyBefore(key: string): boolean {
		const index = this.exchangeItems.findIndex((item) => item.key === key);
		const item = this.exchangeItems[index];
		const previous = index > 0 ? this.exchangeItems[index - 1] : undefined;
		return previous?.exchange === item?.exchange && previous?.kind === "text";
	}
	private progressParts(exchange: number): { items: ExchangeItem[]; final: ExchangeItem } | undefined {
		const items = this.exchangeItems.filter((item) => item.exchange === exchange);
		const lastBlock = items.findLastIndex((item) => item.kind === "block");
		const final = items[lastBlock + 1];
		return lastBlock >= 0 && final?.kind === "text" ? { items: items.slice(0, lastBlock + 1), final } : undefined;
	}
	progressDurationForExchange(exchange: number): number | undefined {
		const parts = this.progressParts(exchange);
		if (!parts) return undefined;
		const first = parts.items.find((item) => item.kind === "block") ?? parts.items[0];
		const block = first.kind === "block" ? this.processByBlock.get(first.key)?.blocks.find((item) => item.key === first.key) : undefined;
		const saved = this.pendingThinking.get(first.key) ?? this.saved?.(first.key);
		const start = saved?.startedAt ?? (block?.kind === "thinking" ? this.thinking.timing(block.message, block.index)?.start : block?.kind === "tool" ? this.blocks.get(block.key.slice(5))?.startedAt : undefined) ?? first.startedAt;
		return Math.max(0, parts.final.startedAt - start);
	}
	progressForItem(key: string): { exchange: number; lead: boolean; open: boolean } | undefined {
		const progress = this.progressByItem.get(key);
		return progress && { exchange: progress.exchange, lead: progress.lead === key, open: progress.open };
	}
	/** Returns the settled progress branch for an item, grouping consecutive blocks by process. */
	progressGuideForItem(key: string): { branch: "├ " | "└ "; continuation: "│ " | "  " } | undefined {
		const progress = this.progressByItem.get(key);
		if (!progress?.open) return undefined;
		const parts = this.progressParts(progress.exchange);
		if (!parts) return undefined;
		const children: string[] = [];
		let previousProcess: string | undefined;
		for (const item of parts.items) {
			if (item.kind === "text") {
				children.push(item.key);
				previousProcess = undefined;
				continue;
			}
			const process = this.processByBlock.get(item.key);
			const child = process?.id ?? item.key;
			if (child !== previousProcess) children.push(child);
			previousProcess = child;
		}
		const item = parts.items.find((candidate) => candidate.key === key);
		const child = item?.kind === "text" ? item.key : item && this.processByBlock.get(item.key)?.id;
		const index = child === undefined ? -1 : children.indexOf(child);
		if (index < 0) return undefined;
		const last = index === children.length - 1;
		return last ? { branch: "└ ", continuation: "  " } : { branch: "├ ", continuation: "│ " };
	}
	/** Returns the branch for a block title and the continuation for its opened output. */
	processBlockGuide(key: string): { branch: "├ " | "└ "; continuation: "│ " | "  " } | undefined {
		const process = this.processByBlock.get(key);
		const index = process?.blocks.findIndex((block) => block.key === key) ?? -1;
		if (!process || index < 0) return undefined;
		const last = index === process.blocks.length - 1;
		return last ? { branch: "└ ", continuation: "  " } : { branch: "├ ", continuation: "│ " };
	}
	/** Returns the guide columns that continue into an item from its previous transcript item. */
	guideBeforeItem(key: string): string | undefined {
		const index = this.exchangeItems.findIndex((item) => item.key === key);
		if (index <= 0) return undefined;
		const current = this.exchangeItems[index];
		const previous = this.exchangeItems[index - 1];
		if (previous.exchange !== current.exchange) return undefined;
		const progress = this.progressByItem.get(key);
		const outer = progress?.open ? this.progressGuideForItem(previous.key)?.continuation ?? "" : "";
		const previousProcess = previous.kind === "block" ? this.processByBlock.get(previous.key) : undefined;
		const currentProcess = current.kind === "block" ? this.processByBlock.get(current.key) : undefined;
		if (previousProcess && currentProcess?.id === previousProcess.id) {
			if (!previousProcess.open) return undefined;
			return outer + (this.processBlockGuide(previous.key)?.continuation ?? "");
		}
		return outer || undefined;
	}
	progressLine(exchange: number): string {
		const progress = this.progress.get(exchange);
		if (!progress) return "";
		const notes = progress.notes ? ` · ${progress.notes} ${progress.notes === 1 ? "note" : "notes"}` : "";
		return `${progress.open ? "▾" : "▸"} Worked for ${elapsed(progress.durationMs)} · ◈ ${progress.thinking} ⚙ ${progress.tools}${notes}`;
	}
	toggleProgress(exchange: number): boolean | undefined {
		const progress = this.progress.get(exchange);
		if (!progress) return undefined;
		progress.open = !progress.open;
		return progress.open;
	}
	/** Toggles a fold row and sets its direct children to the same open state. */
	toggleOneLevel(control: FoldControl): boolean | undefined {
		if (control.kind === "progress") {
			const open = this.toggleProgress(control.exchange);
			if (open === undefined) return undefined;
			for (const process of this.processList) {
				if (process.exchange === control.exchange && process.open !== open) this.toggleProcess(process.id);
			}
			return open;
		}
		if (control.kind === "process") {
			const open = this.toggleProcess(control.id);
			if (open === undefined) return undefined;
			for (const block of this.processById.get(control.id)!.blocks) {
				if (block.kind === "thinking") {
					if (this.isThinkingOpen(block.message, block.index) !== open) this.toggleThinking(block.message, block.index);
				} else {
					const id = block.key.slice(5);
					if (this.isOpen(id) !== open) this.toggle(id);
				}
			}
			return open;
		}
		if (control.kind === "thinking") return this.toggleThinking(control.message, control.index);
		return this.toggle(control.id);
	}
	private cursorRows(): Array<{ key: string; title: string; toggle: () => void }> {
		const rows: Array<{ key: string; title: string; toggle: () => void }> = [];
		for (const process of this.processList) {
			const progress = this.progress.get(process.exchange);
			if (progress && !rows.some((row) => row.key === `exchange:${process.exchange}`)) rows.push({ key: `exchange:${process.exchange}`, title: this.progressLine(process.exchange), toggle: () => { this.toggleProgress(process.exchange); } });
			if (progress && !progress.open) continue;
			const last = process.blocks.at(-1);
			const detail = last?.kind === "thinking" ? this.thinkingTitle(last.message, last.index, last.trace, false)
				: last?.kind === "tool" ? this.titleParts(last.key.slice(5)) : undefined;
			const label = typeof detail === "string" ? detail : detail ? `⚙ ${detail.name} ${detail.argument}`.trim() : "";
			rows.push({ key: `process:${process.id}`, title: `${this.processLine(process.id)}${label ? ` · ${label}` : ""}`, toggle: () => { this.toggleProcess(process.id); } });
			if (!process.open) continue;
			for (const block of process.blocks) {
				if (block.kind === "thinking") rows.push({ key: block.key, title: this.thinkingTitle(block.message, block.index, block.trace, false), toggle: () => { this.toggleThinking(block.message, block.index); } });
				else {
					const id = block.key.slice(5);
					const parts = this.titleParts(id);
					rows.push({ key: block.key, title: `⚙ ${parts?.name ?? "tool"} ${parts?.argument ?? ""}`.trim(), toggle: () => { this.toggle(id); } });
				}
			}
		}
		return rows;
	}
	/** Selects settled progress lines, process lines, and block titles in transcript order. */
	startCursor(): boolean {
		const first = this.cursorRows()[0];
		if (!first) return false;
		this.cursorActive = true;
		this.cursorKey = first.key;
		return true;
	}
	stopCursor(): void { this.cursorActive = false; this.cursorKey = undefined; }
	cursorMove(delta: number): void {
		const rows = this.cursorRows();
		if (!rows.length) { this.cursorKey = undefined; return; }
		const index = rows.findIndex((row) => row.key === this.cursorKey);
		this.cursorKey = rows[Math.max(0, Math.min(rows.length - 1, Math.max(0, index) + delta))].key;
	}
	cursorToggle(): void {
		const row = this.cursorRows().find((item) => item.key === this.cursorKey);
		row?.toggle();
	}
	cursorTitle(): string | undefined { return this.cursorActive ? this.cursorRows().find((item) => item.key === this.cursorKey)?.title : undefined; }
	isCursorHighlighted(key: string): boolean { return this.cursorActive && this.cursorKey === key; }
	beginExchange(index = this.currentExchange + 1): void { this.currentExchange = index; this.openProcess = undefined; }
	/**
	 * Starts a new visual fold segment inside the current exchange after a mid-run
	 * prompt (a steer or follow-up). The exchange card still counts both prompts,
	 * but the transcript gets a fresh progress line and a fresh process tree instead
	 * of continuing the earlier one across the user row. Fractional ids keep the
	 * segment from colliding with the next exchange's integer index.
	 */
	beginSegment(): void {
		if (this.openProcess) this.openProcess.settled = true;
		this.openProcess = undefined;
		this.currentExchange = Math.max(1, this.currentExchange) + 0.5;
	}
	/** Closes the open process and folds answered progress after the final text is known. */
	endExchange(durationMs?: number, answered = true): void {
		if (answered) {
			const parts = this.progressParts(this.currentExchange);
			if (parts) {
				const progress: ExchangeProgress = { exchange: this.currentExchange, lead: parts.items[0].key, open: false,
					durationMs: durationMs ?? this.progressDurationForExchange(this.currentExchange) ?? 0,
					thinking: parts.items.filter((item) => item.key.startsWith("thinking:")).length,
					tools: parts.items.filter((item) => item.key.startsWith("tool:")).length,
					notes: parts.items.filter((item) => item.kind === "text").length };
				this.progress.set(this.currentExchange, progress);
				for (const item of parts.items) this.progressByItem.set(item.key, progress);
			}
		}
		this.openProcess = undefined;
		for (let index = this.processList.length - 1; index >= 0 && !this.processList[index].settled; index--) this.processList[index].settled = true;
	}
	toggleLatestProcess(): boolean | undefined {
		const process = this.processList.at(-1);
		return process && this.toggleProcess(process.id);
	}
	toggleExchange(exchange: number): boolean | undefined {
		if (this.progress.has(exchange)) return this.toggleProgress(exchange);
		const processes = this.processList.filter((process) => process.exchange === exchange);
		if (!processes.length) return undefined;
		const open = processes.some((process) => !process.open);
		for (const process of processes) process.open = open;
		return open;
	}
	isExchangeOpen(exchange: number): boolean | undefined {
		const progress = this.progress.get(exchange);
		if (progress) return progress.open;
		const processes = this.processList.filter((process) => process.exchange === exchange);
		return processes.length ? processes.every((process) => process.open) : undefined;
	}
	toggleLatestExchange(): boolean | undefined {
		const process = this.processList.at(-1);
		return process && this.toggleExchange(process.exchange);
	}
	processForThinking(message: ThinkingMessage, index: number): Process | undefined {
		return this.processByBlock.get(`thinking:${message.timestamp}:${index}`);
	}
	processForTool(id: string): Process | undefined { return this.processByBlock.get(`tool:${id}`); }
	/** Whether this model has ingested or run the tool call, so its session owns the component. */
	ownsTool(id: string): boolean { return this.processByBlock.has(`tool:${id}`) || this.blocks.has(id); }
	/** Whether this model has ingested the assistant message, so its session owns the component. */
	ownsMessage(message: ThinkingMessage): boolean { return typeof message?.timestamp === "number" && this.seenContent.has(message.timestamp); }
	/**
	 * Whether a thinking run or tool call in the message matches what this model ingested
	 * for that timestamp. Used to tell apart sessions whose messages share a timestamp.
	 */
	ingestedContentOf(message: ThinkingMessage & { content?: ProcessMessage["content"] }): boolean {
		const content = message?.content ?? [];
		for (let index = 0; index < content.length; index++) {
			const item = content[index];
			if (item.type === "toolCall" && item.id && this.processByBlock.has(`tool:${item.id}`)) return true;
			if (item.type !== "thinking" || content[index - 1]?.type === "thinking") continue;
			const traces: string[] = [];
			for (let run = index; content[run]?.type === "thinking"; run++) if (content[run].thinking?.trim()) traces.push(content[run].thinking!.trim());
			const key = `thinking:${message.timestamp}:${index}`;
			const block = this.processByBlock.get(key)?.blocks.find((candidate) => candidate.key === key);
			if (block?.kind === "thinking" && block.trace === traces.join("\n\n")) return true;
		}
		return false;
	}
	isProcessLead(id: string, key: string): boolean { return this.processById.get(id)?.blocks[0]?.key === key; }
	toggleProcess(id: string): boolean | undefined {
		const process = this.processById.get(id);
		if (!process) return undefined;
		process.open = !process.open;
		return process.open;
	}
	isProcessOpen(id: string): boolean { return this.processById.get(id)?.open ?? false; }
	toggleThinking(message: ThinkingMessage, index: number): boolean {
		const key = `thinking:${message.timestamp}:${index}`;
		if (this.openThinking.has(key)) { this.openThinking.delete(key); return false; }
		this.openThinking.add(key);
		return true;
	}
	isThinkingOpen(message: ThinkingMessage, index: number): boolean { return this.openThinking.has(`thinking:${message.timestamp}:${index}`); }

	processLine(id: string): string {
		const process = this.processById.get(id);
		if (!process) return "";
		let first: number | undefined;
		let last: number | undefined;
		let activity = "";
		let queued = "";
		for (const block of process.blocks) {
			const tool = block.kind === "tool" ? this.blocks.get(block.key.slice(5)) : undefined;
			const saved = this.pendingThinking.get(block.key) ?? this.saved?.(block.key);
			const timing = saved?.startedAt !== undefined ? { start: saved.startedAt, end: saved.endedAt }
				: block.kind === "thinking" ? this.thinking.timing(block.message, block.index)
				: tool?.startedAt === undefined ? undefined : { start: tool.startedAt, end: tool.endedAt };
			// Pi streams a tool call before executing it; name it without inventing a time.
			// A saved record means the call settled (possibly never run), so it is not queued.
			if (!timing && !process.settled && block.kind === "tool" && tool?.endedAt === undefined && !saved) queued ||= `⚙ ${tool?.name ?? "tool"} queued`;
			if (!timing) continue;
			first = first === undefined ? timing.start : Math.min(first, timing.start);
			last = Math.max(last ?? timing.start, timing.end ?? (process.settled ? timing.start : this.now()));
			if (timing.end === undefined && !process.settled) activity = block.kind === "tool"
				? `⚙ ${tool?.name ?? "tool"} running ${elapsed(this.now() - timing.start)}`
				: this.thinking.title(block.message, block.index, block.trace, true);
		}
		const count = `◈ ${process.blocks.filter((block) => block.kind === "thinking").length} ⚙ ${process.blocks.filter((block) => block.kind === "tool").length}`;
		const total = first === undefined || last === undefined ? "0ms" : elapsed(Math.max(0, last - first));
		return `${process.open ? "▾" : "▸"} ${count} · ${activity || queued || total}`;
	}

	observe(id: string, name: string, args: Record<string, unknown>, result?: ToolBlock["result"]): void {
		const block = this.blocks.get(id);
		if (block) {
			block.args = args;
			if (result) block.result = result;
		} else {
			this.blocks.set(id, { name, args, result, isError: false, open: false });
		}
	}

	start(id: string, name: string, at = this.now()): void {
		const block = this.blocks.get(id) ?? { name, isError: false, open: false };
		block.name = name;
		block.startedAt = at;
		this.blocks.set(id, block);
	}

	end(id: string, isError: boolean, result?: ToolBlock["result"], at = this.now()): void {
		const block = this.blocks.get(id) ?? { name: "tool", isError: false, open: false };
		block.endedAt = at;
		block.isError = isError;
		if (result) block.result = result;
		this.blocks.set(id, block);
	}

	observeThinking(message: ThinkingMessage, event: ThinkingEvent, reasoningTokens?: number): void {
		this.thinking.observe(message, event, reasoningTokens);
	}

	settleThinking(message: ThinkingMessage & { content?: ProcessMessage["content"] }): void {
		this.thinking.settle(message);
		for (let index = 0; index < (message.content?.length ?? 0); index++) {
			if (message.content?.[index].type !== "thinking" || message.content?.[index - 1]?.type === "thinking") continue;
			const key = `thinking:${message.timestamp}:${index}`;
			const block = this.processByBlock.get(key)?.blocks.find((item) => item.key === key);
			if (block?.kind === "thinking") this.pendingThinking.set(key, this.thinking.record(message, index, block.trace));
		}
	}

	thinkingTitle(message: ThinkingMessage, index: number, trace: string, streaming: boolean): string {
		const key = `thinking:${message.timestamp}:${index}`;
		return this.thinking.title(message, index, trace, streaming, this.pendingThinking.get(key) ?? this.saved?.(key));
	}

	/**
	 * Applies a model headline, or `undefined` to fall back to the trace sentence.
	 * Returns the correction to persist when the block's exchange record was already
	 * saved with a different headline; otherwise the change is live or still pending.
	 */
	setThinkingHeadline(message: ThinkingMessage, index: number, headline: string | undefined): ThinkingHeadlinePatch | undefined {
		const key = `thinking:${message.timestamp}:${index}`;
		this.thinking.setHeadline(message, index, headline);
		const block = this.processByBlock.get(key)?.blocks.find((item) => item.key === key);
		const next = headline ? { headline, headlineSource: "model" as const }
			: block?.kind === "thinking" ? { headline: traceHeadline(block.trace, false), headlineSource: "trace" as const } : undefined;
		const pending = this.pendingThinking.get(key);
		if (pending?.kind === "thinking") {
			if (next) Object.assign(pending, next);
			return undefined;
		}
		const saved = this.saved?.(key);
		if (!next || saved?.kind !== "thinking" || (saved.headline === next.headline && saved.headlineSource === next.headlineSource)) return undefined;
		return { id: key, ...next };
	}

	toggle(id: string): boolean | undefined {
		const block = this.blocks.get(id);
		if (!block) return undefined;
		block.open = !block.open;
		return block.open;
	}

	isOpen(id: string): boolean {
		return this.blocks.get(id)?.open ?? false;
	}

	titleParts(id: string): { name: string; argument: string; stats: string } | undefined {
		const block = this.blocks.get(id);
		if (!block) return undefined;
		const saved = this.saved?.(`tool:${id}`);
		const argument = summary(block.args);
		// A call whose exchange settled without a result never finished; it must not read as running.
		const settled = this.processByBlock.get(`tool:${id}`)?.settled ?? false;
		const noResult = saved?.kind === "tool" ? saved.status === "unknown" : block.endedAt === undefined && settled;
		if (noResult) return { name: block.name, argument, stats: "no result" };
		const elapsed = saved?.durationMs ?? (block.startedAt === undefined ? undefined : Math.max(0, (block.endedAt ?? this.now()) - block.startedAt));
		const status = saved?.kind === "tool" ? saved.status === "error" ? "✗" : "✓" : block.endedAt === undefined ? "running" : block.isError ? "✗" : "✓";
		const count = saved?.kind === "tool" ? saved.lineCount : lineCount(block.result);
		const lines = saved?.kind === "tool" || block.endedAt !== undefined ? ` · ${count} ${count === 1 ? "line" : "lines"}` : "";
		return { name: block.name, argument, stats: `${status} ${duration(elapsed)}${lines}` };
	}
}

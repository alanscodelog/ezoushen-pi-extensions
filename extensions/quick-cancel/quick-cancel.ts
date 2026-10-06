import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

/**
 * `ctrl+alt+x`. `ctrl`+`alt`+a letter is sent as a distinct escape sequence by
 * terminals, so it does not collide with the free letters and is not stripped
 * like `ctrl+shift+x` (which most terminals deliver as `ctrl+x`, colliding with
 * pi's built-in shortcut). The handler always calls `ctx.abort()` itself, so it
 * works regardless of the key. Binding it to `escape` (no modifier) would
 * collide with pi's built-in interrupt and be skipped, so it is not the default.
 *
 * Note: the terminal must actually transmit the `ctrl`+`alt` combo in a form pi
 * can parse. Verified against one runtime that sends legacy sequences: it
 * delivers `ctrl+alt+x` as `ESC`+`0x18`, which pi does not bind (and
 * `alt+escape` arrives as the ambiguous double-`ESC`, also unbindable) — but
 * `alt`+`letter` (classic `ESC`+letter meta form) fires fine. Users whose
 * terminal can't passthrough `ctrl+alt` can set `PI_QUICK_CANCEL_KEY` to a key
 * their terminal sends distinctly (e.g. `alt+x`), or use the `quick-cancel`
 * slash command instead.
 */
const DEFAULT_KEY = "ctrl+alt+x";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_QUICK_CANCEL_KEY" } } as const;
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

/** The prompt that triggered the most recent run, captured so it can be returned. */
interface CapturedPrompt {
	text: string;
}

/** Minimal structural view of the session entries the rewind needs. */
interface SessionEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	message?: { role: string; content: unknown };
}

/** pi passes the full `SessionManager` at runtime even though the type is the
 * readonly view; the rewind needs the tree-mutating `branch`/`resetLeaf`. */
interface RewindableSessionManager {
	getEntries(): SessionEntryLike[];
	getEntry(id: string): SessionEntryLike | undefined;
	branch(id: string): void;
	resetLeaf(): void;
}

function isShortcutKey(value: unknown): value is ShortcutKey {
	if (typeof value !== "string") return false;
	const parts = value.split("+");
	const base = parts.pop();
	return parts.length > 0 && new Set(parts).size === parts.length &&
		parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part)) &&
		base !== undefined && (/^[a-z0-9]$/.test(base) || ["enter", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end"].includes(base));
}

/** Flatten a message `content` (string or content parts) to plain text. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
			.join("");
	}
	return "";
}

/**
 * Find the session entry of the user message that started the run being
 * cancelled. Matches the captured prompt text (searching newest-first); falls
 * back to the newest user message entry, which is the prompt of the run that
 * just ended unless something was queued mid-run.
 */
function findPromptEntryId(sm: { getEntries(): SessionEntryLike[] }, prompt: string | undefined): string | undefined {
	const entries = sm.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		if (prompt === undefined || contentText(entry.message.content).trim() === prompt.trim()) return entry.id;
	}
	return undefined;
}

/**
 * Rewind the session tree so the canonical history ends just before the given
 * prompt entry: the run's user message and any assistant output it produced
 * drop out of the context. `entryId` must be a user-message entry; branching to
 * its parent is the data-layer equivalent of pi's tree navigation for a user
 * message target (leaf := parentId, or no leaf when the prompt is the root).
 */
function rewindSessionData(sm: RewindableSessionManager, entryId: string): boolean {
	const entry = sm.getEntry(entryId);
	if (!entry) return false;
	if (entry.parentId === null) sm.resetLeaf();
	else sm.branch(entry.parentId);
	return true;
}

export default function registerQuickCancel(
	pi: ExtensionAPI,
	settingsRuntime: SettingsRuntime = {},
): void {
	const resolved = resolveSettings("pi-quick-cancel", KEY_SETTING, {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => false,
	}, settingsRuntime);
	const configuredKey = resolved.key.value;
	const validKey = isShortcutKey(configuredKey);
	const key: ShortcutKey = validKey ? configuredKey : DEFAULT_KEY;
	let warnedAboutKey = false;

	/**
	 * The prompt captured from the last `before_agent_start`, kept until the
	 * run settles so a quick cancel can return it to the editor. `null` when
	 * there is no run whose prompt can be returned.
	 */
	let captured: CapturedPrompt | null = null;
	/** Set when the shortcut cancelled a run: the session tree is rewound to
	 * just before the prompt once the aborted loop settles (`agent_end`). */
	let pendingRewind = false;

	// SAFETY: pi binds the full SessionManager instance even though the
	// extension-facing type is the Readonly view (interactive-mode passes
	// `sessionManager: this.sessionManager`); branch/resetLeaf exist at runtime.
	const sessionOf = (ctx: ExtensionContext): RewindableSessionManager => ctx.sessionManager as unknown as RewindableSessionManager;

	pi.on("session_start", (_event, ctx) => {
		if (!validKey && !warnedAboutKey) {
			announce(ctx, "pi-quick-cancel: invalid key setting; using ctrl+alt+x", "warning", "pi-quick-cancel:invalid-key");
			warnedAboutKey = true;
		}
	});

	// The canonical prompt that started the current run. Captured early (after
	// template expansion) so it can be restored even if the editor has cleared.
	pi.on("before_agent_start", (event) => {
		captured = { text: event.prompt };
		pendingRewind = false;
	});

	// The run is over: if a quick cancel asked for a rewind, drop the exchange
	// from the session tree now — every entry the aborted run appended (the user
	// prompt plus any assistant output) is persisted by the time this fires, so
	// branching to the prompt's parent removes exactly this exchange.
	pi.on("agent_end", (_event, ctx) => {
		if (pendingRewind && captured) {
			const prompt = captured.text;
			const entryId = findPromptEntryId(sessionOf(ctx), prompt);
			if (entryId && rewindSessionData(sessionOf(ctx), entryId)) {
				announce(ctx, "pi-quick-cancel: run cancelled; chat history rewound to before the prompt", "info");
			}
		}
		captured = null;
		pendingRewind = false;
	});

	pi.registerShortcut(key, {
		description: "Cancel the run, rewind the chat to before the prompt, and return the prompt to the editor",
		handler: (ctx) => {
			const editorText = ctx.ui?.getEditorText?.();
			const text = captured?.text ?? editorText;

			// Nothing is running: there is nothing to cancel. Best-effort return
			// the prompt to the editor instead, so a stray press never loses it.
			if (ctx.isIdle()) {
				if (captured?.text) {
					ctx.ui?.setEditorText?.(captured.text);
					announce(ctx, "pi-quick-cancel: nothing was streaming; prompt returned to editor", "info");
				} else if (text) {
					ctx.ui?.setEditorText?.(text);
					announce(ctx, "pi-quick-cancel: prompt returned to editor", "info");
				} else {
					announce(ctx, "pi-quick-cancel: nothing to cancel", "info");
				}
				return;
			}

			// An active run is in flight: cancel it (the "esc" half) and restore
			// the prompt to the editor immediately, no matter how far the run got —
			// the whole exchange is rewound, so there is nothing to preserve in the
			// transcript. The session tree rewind itself happens on `agent_end`, once
			// the aborted loop has finished writing.
			ctx.abort();
			if (text) {
				ctx.ui?.setEditorText?.(text);
				pendingRewind = true;
				announce(ctx, "pi-quick-cancel: cancelling; prompt returned to editor, chat will rewind to before the prompt", "info");
			} else {
				announce(ctx, "pi-quick-cancel: cancelled", "info");
			}
		},
	});

	// Full-fidelity rewind: pi's own tree navigation rebuilds the visible
	// transcript (the aborted exchange disappears immediately), restores the
	// prompt to the editor, and refreshes the agent context. Available as a
	// command because `navigateTree` lives on the command context, not the
	// shortcut context.
	pi.registerCommand("quick-cancel", {
		description: "Rewind the chat to before the last prompt and return the prompt to the editor",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const prompt = captured?.text;
			if (!ctx.isIdle()) {
				// An active run: cancel it, then wait for the loop to settle —
				// navigateTree refuses to run mid-stream.
				ctx.abort();
				await ctx.waitForIdle();
			}
			// SAFETY: same runtime SessionManager instance as the shortcut path; the
			// command-facing Readonly type just doesn't expose the entries shape.
			const sm = ctx.sessionManager as unknown as { getEntries(): SessionEntryLike[]; getEntry(id: string): SessionEntryLike | undefined };
			const entryId = findPromptEntryId(sm, prompt);
			if (!entryId) {
				announce(ctx, "pi-quick-cancel: nothing to rewind", "info");
				return;
			}
			const result = await ctx.navigateTree(entryId);
			if (result.cancelled) return;
			// navigateTree already restores a user-message prompt to an empty
			// editor; make sure it lands even if the editor kept stray text.
			const entry = sm.getEntry(entryId);
			const promptText = prompt ?? (entry ? contentText(entry.message?.content) : "");
			if (promptText && !ctx.ui?.getEditorText?.()) ctx.ui?.setEditorText?.(promptText);
			announce(ctx, "pi-quick-cancel: rewound to before the prompt", "info");
		},
	});
}

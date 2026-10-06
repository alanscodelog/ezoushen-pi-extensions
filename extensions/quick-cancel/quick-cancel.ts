import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

/**
 * Default shortcut: `ctrl+alt+x`. A distinct escape sequence, no collision with
 * pi's built-ins, and not strippable the way `ctrl+shift+x` collapses to
 * `ctrl+x`. `escape` itself is pi's interrupt and would be skipped.
 *
 * The terminal must actually transmit the combo — see the README for the
 * verified matrix (legacy `ctrl+alt` and `alt+escape` are unbindable;
 * `alt+letter` works). Overridable via `PI_QUICK_CANCEL_KEY`.
 */
const DEFAULT_KEY = "ctrl+alt+x";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_QUICK_CANCEL_KEY" } } as const;
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

/** Minimal structural view of the session entries the rewind needs. */
interface SessionEntryLike {
	id: string;
	parentId: string | null;
	type: string;
	message?: { role: string; content: unknown };
}

/** pi passes the full `SessionManager` instance at runtime even though the
 * extension-facing type is the readonly view; the rewind reads its entries. */
interface ReadableSessionManager {
	getEntries(): SessionEntryLike[];
	getEntry(id: string): SessionEntryLike | undefined;
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
function findPromptEntryId(sm: ReadableSessionManager, prompt: string | null): string | undefined {
	const entries = sm.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		if (prompt === null || contentText(entry.message.content).trim() === prompt.trim()) return entry.id;
	}
	return undefined;
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
	 * The prompt of the most recent run, captured so the rewind can find its
	 * exchange. `null` once the run settles — a later idle press then falls
	 * back to the newest user message entry instead of a stale match.
	 */
	let captured: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		if (!validKey && !warnedAboutKey) {
			announce(ctx, "pi-quick-cancel: invalid key setting; using ctrl+alt+x", "warning", "pi-quick-cancel:invalid-key");
			warnedAboutKey = true;
		}
	});

	// The canonical prompt that started the current run. Captured early (after
	// template expansion) so the rewind can find the exchange even though the
	// editor has cleared.
	pi.on("before_agent_start", (event) => {
		captured = event.prompt;
	});

	pi.on("agent_end", () => {
		captured = null;
	});

	/**
	 * Cancel any in-flight run, wait for the loop to settle, then navigate the
	 * session tree to just before the prompt. pi's tree navigation rewinds the
	 * canonical history, rebuilds the visible transcript (the exchange
	 * disappears immediately), and restores the prompt to the editor.
	 */
	const rewind = async (ctx: ExtensionCommandContext): Promise<void> => {
		const prompt = captured;
		if (!ctx.isIdle()) {
			// An active run: cancel it, then wait for the loop to settle —
			// navigateTree refuses to run mid-stream.
			ctx.abort();
			await ctx.waitForIdle();
		}
		// SAFETY: pi binds the full SessionManager instance even though the
		// extension-facing type is the Readonly view; getEntries/getEntry exist
		// at runtime.
		const sm = ctx.sessionManager as unknown as ReadableSessionManager;
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
	};

	pi.registerCommand("quick-cancel", {
		description: "Rewind the chat to before the last prompt and return the prompt to the editor",
		handler: (_args, ctx) => rewind(ctx),
	});

	// The shortcut is the command: only the command context can reach the
	// transcript UI, and dispatching through sendUserMessage works even
	// mid-stream (extension commands run before the streaming check in prompt()).
	pi.registerShortcut(key, {
		description: "Rewind the chat to before the prompt (cancels the run)",
		handler: () => pi.sendUserMessage("/quick-cancel", { expandPromptTemplates: true }),
	});
}

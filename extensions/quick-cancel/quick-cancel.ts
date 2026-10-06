import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

/**
 * `ctrl+alt+x`. `ctrl`+`alt`+a letter is sent as a distinct escape sequence by
 * terminals, so it does not collide with the free letters and is not stripped
 * like `ctrl+shift+x` (which most terminals deliver as `ctrl+x`, colliding with
 * pi's built-in shortcut). The handler always calls `ctx.abort()` itself, so it
 * works regardless of the key. Binding it to `escape` would collide with the
 * built-in interrupt and be skipped by pi, so it is not the default.
 */
const DEFAULT_KEY = "ctrl+alt+x";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_QUICK_CANCEL_KEY" } } as const;
type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

/** The prompt that triggered the most recent run, captured so it can be returned. */
interface CapturedPrompt {
	text: string;
}

function isShortcutKey(value: unknown): value is ShortcutKey {
	if (typeof value !== "string") return false;
	const parts = value.split("+");
	const base = parts.pop();
	return parts.length > 0 && new Set(parts).size === parts.length &&
		parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part)) &&
		base !== undefined && (/^[a-z0-9]$/.test(base) || ["enter", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end"].includes(base));
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
	/** Whether the first assistant response block has fully ended. While false
	 * there is nothing to lose (nothing output yet, or the first block is still
	 * streaming), so cancelling can safely return the prompt to the editor. */
	let firstAssistantEnded = false;

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
		firstAssistantEnded = false;
	});

	// The first assistant block has fully streamed: after this point cancelling
	// keeps the prompt in the transcript (there is output to preserve) rather than
	// returning it to the editor.
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant" && !firstAssistantEnded) {
			firstAssistantEnded = true;
		}
	});

	// The run is over: drop any pending recovery state so a later press cannot
	// return a stale prompt.
	pi.on("agent_end", () => {
		captured = null;
		firstAssistantEnded = false;
	});

	pi.registerShortcut(key, {
		description: "Cancel the run and (early) return the prompt to the editor",
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

			// An active run is in flight: cancel it (the "esc" half).
			ctx.abort();

			if (!text) {
				announce(ctx, "pi-quick-cancel: cancelled", "info");
				return;
			}

			if (!firstAssistantEnded) {
				// Nothing output yet, or the first block is still streaming — there
				// is nothing to lose, so return the prompt to the editor (the
				// "unwind to that prompt" half, automated).
				ctx.ui?.setEditorText?.(text);
				announce(ctx, "pi-quick-cancel: cancelled before the first response finished; prompt returned to editor", "info");
			} else {
				// The first response already finished: the prompt is already in the
				// transcript as context, so leave it there and only cancel.
				announce(ctx, "pi-quick-cancel: cancelled; first response already finished", "info");
			}
		},
	});
}

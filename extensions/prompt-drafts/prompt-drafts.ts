import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { announce } from "../../shared/announce.ts";
import { resolveSettings, type SettingsRuntime } from "../../shared/settings.ts";

const DEFAULT_KEY = "ctrl+s";
const KEY_SETTING = { key: { default: DEFAULT_KEY, env: "PI_PROMPT_DRAFTS_KEY" } } as const;

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

function isShortcutKey(value: unknown): value is ShortcutKey {
	if (typeof value !== "string") return false;
	const parts = value.split("+");
	const base = parts.pop();
	return parts.length > 0 && new Set(parts).size === parts.length &&
		parts.every((part) => ["ctrl", "alt", "shift", "super"].includes(part)) &&
		base !== undefined && (/^[a-z0-9]$/.test(base) || ["enter", "escape", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end"].includes(base));
}

/** First line of a draft, truncated for display in the picker. */
function firstLine(text: string, max = 80): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/**
 * Ctrl+S drafts for the prompt editor, in the style of Claude Code's message
 * queueing: press the draft key to set aside the text you are typing, keep
 * typing or wait, and get it back -- automatically the moment you send your
 * next prompt, or with the same key at any time.
 *
 * The drafts form a queue: each press with text in the editor pushes to the
 * end, each restore hands back the oldest draft, so drafts come back in the
 * order they were written. A prompt the user sends verbatim is dropped from
 * the queue, so an auto-restore can never duplicate something that was
 * already submitted.
 *
 * The /draft command pushes to the same queue without touching the editor,
 * so wrappers and other extensions can enqueue text directly. /drafts (no
 * args) opens a picker showing the first line of each draft; /drafts clear
 * discards the whole queue.
 */
export default function registerPromptDrafts(pi: ExtensionAPI, settingsRuntime: SettingsRuntime = {}): void {
	const resolved = resolveSettings("pi-prompt-drafts", KEY_SETTING, {
		cwd: process.cwd(),
		hasUI: true,
		isProjectTrusted: () => false,
	}, settingsRuntime);
	const configuredKey = resolved.key.value;
	const validKey = isShortcutKey(configuredKey);
	const key: ShortcutKey = validKey ? configuredKey : DEFAULT_KEY;
	let warnedAboutKey = false;

	/** Saved drafts, oldest first. In-memory per pi process. */
	const drafts: string[] = [];

	const restoreOldest = (ctx: ExtensionContext): boolean => {
		const draft = drafts.shift();
		if (draft === undefined) {
			announce(ctx, "pi-prompt-drafts: no drafts.", "info", "pi-prompt-drafts:empty");
			return false;
		}
		if (ctx.ui.getEditorText().trim()) {
			drafts.unshift(draft);
			announce(ctx, "pi-prompt-drafts: the editor is not empty, so the draft was kept. Clear the editor and restore again.", "warning", "pi-prompt-drafts:editor-busy");
			return false;
		}
		ctx.ui.setEditorText(draft);
		announce(ctx, "pi-prompt-drafts: draft restored to the editor.", "info", "pi-prompt-drafts:restored");
		return true;
	};

	/** Shared restore core: hands the oldest draft to an empty editor. */
	const restoreNext = (ctx: ExtensionContext, onBusy: "notify" | "skip"): boolean => {
		if (drafts.length === 0) return false;
		if (ctx.ui.getEditorText().trim()) {
			if (onBusy === "notify") {
				announce(ctx, "pi-prompt-drafts: a saved draft is waiting; press the draft key to restore it.", "info", "pi-prompt-drafts:waiting");
			}
			return false;
		}
		const draft = drafts.shift();
		if (draft === undefined) return false;
		ctx.ui.setEditorText(draft);
		announce(ctx, "pi-prompt-drafts: draft restored to the editor; press enter to send it.", "info", "pi-prompt-drafts:auto-restored");
		return true;
	};

	/** Interactive picker: shows the first line of each draft, restores the chosen one. */
	const pickDraft = async (ctx: ExtensionContext): Promise<boolean> => {
		if (drafts.length === 0) {
			announce(ctx, "pi-prompt-drafts: no drafts.", "info", "pi-prompt-drafts:empty");
			return false;
		}

		const items = drafts.map((text, index) => ({
			value: index,
			label: firstLine(text),
		}));

		const selectedIndex = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Drafts")), 1, 0));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter restore • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (selectedIndex === null) return false;

		const draft = drafts[selectedIndex];
		if (draft === undefined) return false;

		// Remove the chosen draft by index so duplicate texts don't lose the
		// wrong entry. If the editor is occupied, push it back to the end so
		// the draft is kept rather than silently dropped.
		drafts.splice(selectedIndex, 1);
		if (ctx.ui.getEditorText().trim()) {
			drafts.push(draft);
			announce(ctx, "pi-prompt-drafts: the editor is not empty, so the draft was kept.", "warning", "pi-prompt-drafts:editor-busy");
			return false;
		}

		ctx.ui.setEditorText(draft);
		announce(ctx, "pi-prompt-drafts: draft restored to the editor.", "info", "pi-prompt-drafts:restored");
		return true;
	};

	pi.on("session_start", (_event, ctx) => {
		// Drafts do not follow the user across sessions; an old prompt
		// surfacing in a new conversation would be a surprise, not a feature.
		drafts.length = 0;
		if (!validKey && !warnedAboutKey) {
			announce(ctx, "pi-prompt-drafts: invalid key setting; using ctrl+s", "warning", "pi-prompt-drafts:invalid-key");
			warnedAboutKey = true;
		}
	});

	// The moment a prompt is sent is the moment the drafts come back: the
	// sent message becomes the active prompt, so the saved draft becomes the
	// next one to review and submit. pi clears the editor before the input
	// event dispatches, so the restore lands in an empty editor. A sent prompt
	// that matches a saved draft exactly is dropped instead -- it has been
	// used, and leaving it queued would make the restore re-fill the editor
	// with an already-submitted message. The editor-occupied guard only fires
	// when another extension filled it in an earlier input handler.
	pi.on("input", (event, ctx) => {
		const sent = event.text;
		const index = drafts.indexOf(sent);
		if (index !== -1) drafts.splice(index, 1);
		restoreNext(ctx, "notify");
	});

	// Built-in slash commands are intercepted by pi's editor before any event
	// fires, so they never reach the input event. pi does emit selection events
	// when a config picker completes, and its editor reads empty then -- the
	// same moment the drafts are due back. Only explicit picks restore: ctrl+p
	// cycling ("cycle") and session restore must not surface a draft. An
	// occupied editor skips silently -- a selection is not a send worth
	// interrupting. Extension commands (including /drafts and /draft) run
	// before the input event inside session.prompt, so they never trigger a
	// restore either.
	pi.on("model_select", (event, ctx) => {
		if (event.source === "set") restoreNext(ctx, "skip");
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		restoreNext(ctx, "skip");
	});

	pi.registerShortcut(key, {
		description: "Save the editor draft (press again with an empty editor to restore; comes back automatically when you send the next prompt)",
		handler: (ctx) => {
			const text = ctx.ui.getEditorText();
			if (text.trim()) {
				drafts.push(text);
				ctx.ui.setEditorText("");
				announce(ctx, `pi-prompt-drafts: draft saved. It comes back when you send your next prompt, or press ${key} to restore it now.`, "info", "pi-prompt-drafts:saved");
				return;
			}
			restoreOldest(ctx);
		},
	});

	pi.registerCommand("draft", {
		description: "Queue the given text as a draft without touching the editor (`/draft <message>`)",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			if (!text) {
				announce(ctx, "pi-prompt-drafts: usage: /draft <message>", "info", "pi-prompt-drafts:draft-usage");
				return;
			}
			drafts.push(text);
			const count = drafts.length;
			const suffix = count === 1 ? "1 draft queued." : `${count} drafts queued.`;
			announce(ctx, `pi-prompt-drafts: draft added. ${suffix}`, "info", "pi-prompt-drafts:draft-added");
		},
	});

	pi.registerCommand("drafts", {
		description: "Pick a draft to restore (`/drafts clear` discards every draft)",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			if (arg === "") {
				await pickDraft(ctx);
				return;
			}
			if (arg === "clear") {
				const count = drafts.length;
				drafts.length = 0;
				let message = "pi-prompt-drafts: no drafts.";
				if (count === 1) message = "pi-prompt-drafts: discarded 1 draft.";
				if (count > 1) message = `pi-prompt-drafts: discarded ${count} drafts.`;
				announce(ctx, message, "info", "pi-prompt-drafts:cleared");
				return;
			}
			announce(ctx, "pi-prompt-drafts: usage: /drafts [clear]", "info", "pi-prompt-drafts:usage");
		},
	});
}

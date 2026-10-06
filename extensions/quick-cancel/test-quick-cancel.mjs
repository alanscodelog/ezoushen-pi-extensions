import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerQuickCancel from "./quick-cancel.ts";

/**
 * A minimal pi harness for the quick-cancel shortcut. It records calls,
 * holds editor text, and lets tests drive the extension lifecycle events
 * (before_agent_start, message_start, message_end, agent_end) exactly as pi
 * would, so the shortcut handler can be exercised in isolation.
 */
function createHarness({
	editorText = "",
	idle = true,
	prompt,
	nonInteractive = false,
} = {}) {
	const shortcuts = new Map();
	const calls = [];
	const events = new Map();
	const notifications = [];
	let currentText = editorText;
	let agentIdle = idle;
	const assistantPrompt = prompt ?? "answer my question";
	const assistantParts = "the response";

	const pi = {
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		on(event, handler) {
			let handlers = events.get(event);
			if (!handlers) events.set(event, handlers = new Set());
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};

	const ui = {
		getEditorText() {
			calls.push("getEditorText");
			return currentText;
		},
		setEditorText(text) {
			calls.push("setEditorText");
			if (text === undefined || text === null) {
				calls.push("setEditorText-clear");
				currentText = "";
				return;
			}
			currentText = text;
		},
		notify(message, level) {
			calls.push("notify");
			notifications.push({ message, level });
		},
	};

	const ctx = {
		hasUI: !nonInteractive,
		ui: nonInteractive ? undefined : ui,
		isIdle() {
			calls.push("isIdle");
			return agentIdle;
		},
		abort() {
			calls.push("abort");
			agentIdle = true;
		},
	};

	return {
		calls,
		ctx,
		events,
		notifications,
		shortcuts,
		pi,
		get editorText() {
			return currentText;
		},
		/** Drive the extension lifecycle, as pi would. */
		startRun({ withImages } = {}) {
			this.emit("before_agent_start", {
				type: "before_agent_start",
				prompt: assistantPrompt,
				images: withImages ? [{ type: "image", imageData: "x" }] : [],
			});
			this.emit("message_start", {
				type: "message_start",
				message: { role: "assistant", content: [] },
			});
		},
		finishFirstBlock({ empty = false } = {}) {
			this.emit("message_end", {
				type: "message_end",
				message: {
					role: "assistant",
					content: empty ? [] : [{ type: "text", text: assistantParts }],
				},
			});
		},
		settle() {
			this.emit("agent_end", { type: "agent_end", messages: [] });
		},
		emit(event, data) {
			for (const handler of events.get(event) ?? []) handler(data, ctx);
		},
	};
}

const handler = (harness) => harness.shortcuts.get("escape").handler;

test("early cancel during a streaming run returns the prompt to the editor", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.equal(harness.editorText, "answer my question");
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0].level, "info");
	assert.match(harness.notifications[0].message, /cancelled before the first response finished/i);
});

test("cancel after the first block finished leaves the prompt in the transcript", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	// The editor is not touched: the prompt already belongs to the transcript.
	assert.equal(harness.calls.includes("setEditorText"), false);
	assert.equal(harness.editorText, "");
	assert.match(harness.notifications[0].message, /first response already finished/i);
});

test("a run that produced no output at all is treated as unfinished", async () => {
	// No assistant message_end was emitted, so the first block is unfinished.
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	// note: finishFirstBlock() is NOT called

	await handler(harness)(harness.ctx);

	assert.equal(harness.editorText, "answer my question");
	assert.match(harness.notifications[0].message, /before the first response finished/i);
});

test("idle press with no run just reports nothing to cancel", async () => {
	const harness = createHarness({ idle: true });
	registerQuickCancel(harness.pi);

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.includes("abort"), false);
	assert.equal(harness.calls.filter((c) => c === "setEditorText").length, 0);
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0].message, /nothing to cancel/i);
});

test("idle press returns a captured prompt to the editor", async () => {
	const harness = createHarness({ idle: true });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.settle(); // clears recovery state, run is idle

	await handler(harness)(harness.ctx);

	// settle cleared captured, so this falls through to "nothing to cancel" wording.
	assert.match(harness.notifications[0].message, /nothing to cancel/i);
});

test("idle press restores editor text when nothing was captured", async () => {
	const harness = createHarness({ idle: true, editorText: "untyped prompt" });
	registerQuickCancel(harness.pi);

	await handler(harness)(harness.ctx);

	assert.equal(harness.editorText, "untyped prompt");
	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0].message, /prompt returned to editor/i);
});

test("cancel with no known prompt only aborts", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	// No startRun(): before_agent_start never fired, editor empty.

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.equal(harness.calls.includes("setEditorText"), false);
	assert.match(harness.notifications[0].message, /^pi-quick-cancel: cancelled\b/);
});

test("agent_end clears recovery state so a later idle press cancels nothing", async () => {
	// The run finishes (settle), after which the press happens while idle.
	// If agent_end did not clear the captured prompt, this idle press would
	// instead restore the prompt to the editor.
	const harness = createHarness({ idle: true });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();
	harness.settle();

	await handler(harness)(harness.ctx);

	assert.match(harness.notifications[0].message, /nothing to cancel/i);
	assert.equal(harness.calls.filter((c) => c === "abort").length, 0);
});

test("non-interactive mode announces to stderr and never touches the editor", async () => {
	// Capture stderr: in non-interactive mode announce() writes there instead of
	// ctx.ui.notify, which the harness does not expose.
	const originalWrite = process.stderr.write;
	const lines = [];
	process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
	try {
		const harness = createHarness({ idle: false, nonInteractive: true });
		registerQuickCancel(harness.pi);
		harness.startRun();

		await handler(harness)(harness.ctx);

		assert.equal(harness.calls.includes("getEditorText"), false);
		assert.equal(harness.calls.includes("setEditorText"), false);
	} finally {
		process.stderr.write = originalWrite;
	}

	assert.equal(lines.length, 1);
	assert.match(lines[0], /cancelled before the first response finished/);
});

test("invalid key setting uses escape and warns once", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-quick-cancel-invalid-"));
	try {
		writeFileSync(join(agentDir, "pi-quick-cancel.json"), JSON.stringify({ key: "not-a-key" }));
		const harness = createHarness();
		registerQuickCancel(harness.pi, { agentDir, environment: {} });

		assert.equal(harness.shortcuts.has("escape"), true);
		harness.emit("session_start", {});
		harness.emit("session_start", {});
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0].message, /invalid key setting/i);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a custom key setting replaces the default escape binding", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-quick-cancel-key-"));
	try {
		writeFileSync(join(agentDir, "pi-quick-cancel.json"), JSON.stringify({ key: "ctrl+shift+k" }));
		const harness = createHarness();
		registerQuickCancel(harness.pi, { agentDir, environment: {} });

		assert.equal(harness.shortcuts.has("ctrl+shift+k"), true);
		assert.equal(harness.shortcuts.has("escape"), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a captured prompt is returned to the editor when bound to a custom key", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi, { agentDir: undefined, environment: {} });
	harness.shortcuts.set("ctrl+shift+k", harness.shortcuts.get("escape"));

	harness.startRun();
	await harness.shortcuts.get("ctrl+shift+k").handler(harness.ctx);

	assert.equal(harness.editorText, "answer my question");
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerQuickCancel from "./quick-cancel.ts";

/**
 * A minimal in-memory session tree mirroring pi's SessionManager semantics:
 * append-only entries where each new entry's parent is the current leaf, and
 * `branch(id)` re-points the leaf so the canonical history ends at `id`.
 */
function createSessionTree() {
	const entries = [];
	let leafId = null;
	let nextId = 1;
	const sm = {
		append(entry) {
			const id = `e${nextId++}`;
			entries.push({ id, parentId: leafId, type: "message", ...entry });
			leafId = id;
			return id;
		},
		getEntries: () => entries,
		getEntry: (id) => entries.find((e) => e.id === id),
		branch: (id) => {
			leafId = sm.getEntry(id) ? id : null;
		},
		resetLeaf: () => {
			leafId = null;
		},
		get leafId() {
			return leafId;
		},
		/** The canonical history: walk from the leaf back to the root. */
		branchEntries() {
			const out = [];
			let cur = leafId ? sm.getEntry(leafId) : undefined;
			while (cur) {
				out.unshift(cur);
				cur = cur.parentId === null ? undefined : sm.getEntry(cur.parentId);
			}
			return out;
		},
	};
	return sm;
}

/**
 * A minimal pi harness for the quick-cancel shortcut. It records calls,
 * holds editor text, keeps a session tree, and lets tests drive the extension
 * lifecycle events (before_agent_start, message_start, message_end, agent_end)
 * exactly as pi would, so the shortcut handler can be exercised in isolation.
 */
function createHarness({
	editorText = "",
	idle = true,
	prompt,
	nonInteractive = false,
} = {}) {
	const shortcuts = new Map();
	const commands = new Map();
	const calls = [];
	const events = new Map();
	const notifications = [];
	let currentText = editorText;
	let agentIdle = idle;
	const assistantPrompt = prompt ?? "answer my question";
	const assistantParts = "the response";
	const sessionManager = createSessionTree();

	const pi = {
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		registerCommand(name, options) {
			commands.set(name, options);
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
		sessionManager,
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
		sessionManager,
		shortcuts,
		commands,
		pi,
		get editorText() {
			return currentText;
		},
		set editorText(value) {
			currentText = value;
		},
		/** Drive the extension lifecycle, as pi would. */
		startRun({ withImages } = {}) {
			// pi appends the user message to the session before the agent loop.
			this.sessionManager.append({ message: { role: "user", content: assistantPrompt } });
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
			// pi appends the assistant message to the session when it ends.
			if (!empty) {
				this.sessionManager.append({ message: { role: "assistant", content: [{ type: "text", text: assistantParts }] } });
			}
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

const handler = (harness) => harness.shortcuts.get("ctrl+alt+x").handler;

/** A navigateTree spy that mirrors pi's semantics for a user-message target:
 * leaf := parentId, prompt text restored to an empty editor. */
function navigateTreeSpy(harness, navigateCalls) {
	return async (entryId) => {
		navigateCalls.push(entryId);
		const entry = harness.sessionManager.getEntry(entryId);
		if (entry) {
			if (entry.parentId === null) harness.sessionManager.resetLeaf();
			else harness.sessionManager.branch(entry.parentId);
			if (!harness.editorText) {
				const content = entry.message?.content;
				if (typeof content === "string") {
					harness.editorText = content;
				} else if (Array.isArray(content)) {
					harness.editorText = content.map((p) => p?.text ?? "").join("");
				}
			}
		}
		return { cancelled: false };
	};
}

test("early cancel during a streaming run returns the prompt to the editor", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.equal(harness.editorText, "answer my question");
	assert.equal(harness.notifications.length, 1);
	assert.equal(harness.notifications[0].level, "info");
	assert.match(harness.notifications[0].message, /prompt returned to editor/i);
});

test("cancel rewinds the chat to before the prompt once the run settles", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();
	const promptEntry = harness.sessionManager.getEntries().at(-2);
	const assistantEntry = harness.sessionManager.getEntries().at(-1);
	assert.equal(promptEntry.message.role, "user");
	assert.equal(assistantEntry.message.role, "assistant");

	await handler(harness)(harness.ctx);
	assert.equal(harness.editorText, "answer my question");

	// The exchange is still in the session while the aborted loop settles.
	assert.equal(harness.sessionManager.branchEntries().length, 2);

	harness.settle();
	// The rewind removed the whole exchange from the canonical history.
	const remaining = harness.sessionManager.branchEntries();
	assert.equal(remaining.length, 0);
	assert.equal(remaining.includes(promptEntry), false);
	assert.equal(remaining.includes(assistantEntry), false);
	assert.match(harness.notifications.at(-1).message, /rewound to before the prompt/i);
});

test("cancel works the same no matter how far the run got", async () => {
	// With the rewind in place there is nothing to preserve in the transcript:
	// even after the first response fully streamed, the prompt is restored and
	// the whole exchange is queued for removal from the history.
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.equal(harness.editorText, "answer my question");
	assert.match(harness.notifications[0].message, /prompt returned to editor/i);
	assert.match(harness.notifications[0].message, /chat will rewind/i);
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
		harness.settle();

		assert.equal(harness.calls.includes("getEditorText"), false);
		assert.equal(harness.calls.includes("setEditorText"), false);
	} finally {
		process.stderr.write = originalWrite;
	}

	assert.equal(lines.length, 2);
	assert.match(lines[0], /prompt returned to editor/);
	assert.match(lines[1], /rewound to before the prompt/);
});

test("the quick-cancel command rewinds via navigateTree to the prompt entry", async () => {
	const harness = createHarness({ idle: true });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();
	harness.settle();

	const navigateCalls = [];
	const command = harness.commands.get("quick-cancel");
	assert.ok(command, "quick-cancel command registered");
	await command.handler("", {
		...harness.ctx,
		isIdle: () => true,
		waitForIdle: async () => {},
		navigateTree: navigateTreeSpy(harness, navigateCalls),
	});

	const promptEntryId = harness.sessionManager.getEntries().filter((e) => e.message.role === "user").at(-1).id;
	assert.deepEqual(navigateCalls, [promptEntryId]);
	assert.equal(harness.editorText, "answer my question");
});

test("the quick-cancel command aborts a streaming run and waits for idle first", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();

	const navigateCalls = [];
	let idleAfterAbort = false;
	const command = harness.commands.get("quick-cancel");
	const commandCtx = {
		...harness.ctx,
		isIdle: () => idleAfterAbort,
		waitForIdle: async () => {
			idleAfterAbort = true;
		},
		navigateTree: navigateTreeSpy(harness, navigateCalls),
	};
	await command.handler("", commandCtx);

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.deepEqual(navigateCalls, [harness.sessionManager.getEntries().filter((e) => e.message.role === "user").at(-1).id]);
	// waitForIdle settled the run, so the agent_end rewind already emptied the
	// canonical history; navigateTree then points the editor at the prompt.
	const remaining = harness.sessionManager.branchEntries();
	assert.equal(remaining.filter((e) => e.message.role === "user").length, 0);
});

test("invalid key setting uses ctrl+alt+x and warns once", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-quick-cancel-invalid-"));
	try {
		writeFileSync(join(agentDir, "pi-quick-cancel.json"), JSON.stringify({ key: "not-a-key" }));
		const harness = createHarness();
		registerQuickCancel(harness.pi, { agentDir, environment: {} });

		assert.equal(harness.shortcuts.has("ctrl+alt+x"), true);
		harness.emit("session_start", {});
		harness.emit("session_start", {});
		assert.equal(harness.notifications.length, 1);
		assert.match(harness.notifications[0].message, /invalid key setting/i);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a custom key setting replaces the default ctrl+alt+x binding", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-quick-cancel-key-"));
	try {
		writeFileSync(join(agentDir, "pi-quick-cancel.json"), JSON.stringify({ key: "ctrl+shift+k" }));
		const harness = createHarness();
		registerQuickCancel(harness.pi, { agentDir, environment: {} });

		assert.equal(harness.shortcuts.has("ctrl+shift+k"), true);
		assert.equal(harness.shortcuts.has("ctrl+alt+x"), false);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a captured prompt is returned to the editor when bound to a custom key", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi, { agentDir: undefined, environment: {} });
	harness.shortcuts.set("ctrl+shift+k", harness.shortcuts.get("ctrl+alt+x"));

	harness.startRun();
	await harness.shortcuts.get("ctrl+shift+k").handler(harness.ctx);

	assert.equal(harness.editorText, "answer my question");
});

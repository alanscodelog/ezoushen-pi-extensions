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
 * A minimal pi harness for the quick-cancel shortcut. It records calls, holds
 * editor text, keeps a session tree, dispatches extension commands exactly as
 * pi would (prompt() runs them before the streaming check), and lets tests
 * drive the extension lifecycle events. `navigateTree` mirrors pi's real
 * semantics for a user-message target: leaf := parentId, prompt text restored
 * to an empty editor.
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
	const navigateCalls = [];
	let currentText = editorText;
	let agentIdle = idle;
	const assistantPrompt = prompt ?? "answer my question";
	const assistantParts = "the response";
	const sessionManager = createSessionTree();

	const navigateTree = async (entryId) => {
		navigateCalls.push(entryId);
		const entry = sessionManager.getEntry(entryId);
		if (entry) {
			if (entry.parentId === null) sessionManager.resetLeaf();
			else sessionManager.branch(entry.parentId);
			if (!currentText) {
				const content = entry.message?.content;
				if (typeof content === "string") {
					currentText = content;
				} else if (Array.isArray(content)) {
					currentText = content.map((p) => p?.text ?? "").join("");
				}
			}
		}
		return { cancelled: false };
	};

	const pi = {
		registerShortcut(key, options) {
			shortcuts.set(key, options);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		async sendUserMessage(text, options = {}) {
			calls.push(`sendUserMessage:${String(text)}`);
			const name = String(text).replace(/^\//, "");
			const command = commands.get(name);
			if (options.expandPromptTemplates && command) {
				const commandCtx = {
					...ctx,
					isIdle: () => agentIdle,
					waitForIdle: async () => {
						agentIdle = true;
					},
					navigateTree,
				};
				await command.handler("", commandCtx);
			}
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

	const harness = {
		calls,
		ctx,
		events,
		notifications,
		navigateCalls,
		navigateTree,
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
		get agentIdle() {
			return agentIdle;
		},
		set agentIdle(value) {
			agentIdle = value;
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
	return harness;
}

const handler = (harness) => harness.shortcuts.get("ctrl+alt+x").handler;
const lastUserEntryId = (harness) => harness.sessionManager.getEntries().filter((e) => e.message.role === "user").at(-1).id;

test("pressing the shortcut during a run rewinds the chat and restores the prompt", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();
	const promptEntryId = lastUserEntryId(harness);

	await handler(harness)(harness.ctx);

	// The shortcut delegates to the quick-cancel command, which cancels the
	// run and rewinds via pi's tree navigation.
	assert.ok(harness.calls.includes("sendUserMessage:/quick-cancel"));
	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.deepEqual(harness.navigateCalls, [promptEntryId]);
	assert.equal(harness.editorText, "answer my question");
	// The whole exchange is out of the canonical history.
	assert.equal(harness.sessionManager.branchEntries().length, 0);
	assert.match(harness.notifications.at(-1).message, /rewound to before the prompt/i);
});

test("pressing the shortcut while idle rewinds the last completed exchange", async () => {
	const harness = createHarness({ idle: true });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();
	const promptEntryId = lastUserEntryId(harness);

	await handler(harness)(harness.ctx);

	assert.equal(harness.calls.includes("abort"), false);
	assert.deepEqual(harness.navigateCalls, [promptEntryId]);
	assert.equal(harness.editorText, "answer my question");
	assert.equal(harness.sessionManager.branchEntries().length, 0);
});

test("untyped editor text survives an idle rewind", async () => {
	const harness = createHarness({ idle: true, editorText: "untyped prompt" });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();

	await handler(harness)(harness.ctx);

	// The exchange is rewound from history, but the editor keeps the text the
	// user was typing: the prompt restore only fills an empty editor.
	assert.equal(harness.sessionManager.branchEntries().length, 0);
	assert.equal(harness.editorText, "untyped prompt");
});

test("pressing the shortcut with no exchange at all reports nothing to rewind", async () => {
	const harness = createHarness({ idle: true });
	registerQuickCancel(harness.pi);

	await handler(harness)(harness.ctx);

	assert.equal(harness.navigateCalls.length, 0);
	assert.equal(harness.calls.includes("abort"), false);
	assert.match(harness.notifications[0].message, /nothing to rewind/i);
});

test("the command aborts a streaming run before rewinding", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi);
	harness.startRun();
	harness.finishFirstBlock();

	const command = harness.commands.get("quick-cancel");
	assert.ok(command, "quick-cancel command registered");
	// abort() flips the harness idle, matching a loop that settles on abort.
	// The harness ctx carries the real-semantics navigateTree (ExtensionCommandContext).
	await command.handler("", { ...harness.ctx, waitForIdle: async () => {}, navigateTree: harness.navigateTree });

	assert.equal(harness.calls.filter((c) => c === "abort").length, 1);
	assert.deepEqual(harness.navigateCalls, [lastUserEntryId(harness)]);
	assert.equal(harness.sessionManager.branchEntries().length, 0);
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
	assert.match(lines[0], /rewound to before the prompt/);
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

test("a rewind still runs when bound to a custom key", async () => {
	const harness = createHarness({ idle: false });
	registerQuickCancel(harness.pi, { agentDir: undefined, environment: {} });
	harness.shortcuts.set("ctrl+shift+k", harness.shortcuts.get("ctrl+alt+x"));

	harness.startRun();
	await harness.shortcuts.get("ctrl+shift+k").handler(harness.ctx);

	assert.deepEqual(harness.navigateCalls, [lastUserEntryId(harness)]);
	assert.equal(harness.editorText, "answer my question");
});

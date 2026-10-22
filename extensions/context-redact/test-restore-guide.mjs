import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import contextRedact from "./context-redact.ts";
import { CANARY } from "./test/canary.mjs";


function placeholdersIn(text) {
	return [...text.matchAll(/\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/g)].map((match) => match[0]);
}

function createHarness() {
	const events = new Map();
	const commands = new Map();
	const notes = [];
	const statuses = new Map();
	let cwd;

	const pi = {
		on(event, handler) {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
			return () => {};
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
	};
	const ui = {
		notify: (message, level) => notes.push({ message, level }),
		setStatus: (key, text) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
	};
	const makeCtx = () => ({ mode: "tui", hasUI: true, cwd, isProjectTrusted: () => false, ui });

	contextRedact(pi);

	async function emitWith(name, event) {
		let current = event;
		let result;
		for (const handler of events.get(name) ?? []) {
			const next = await handler(current, makeCtx());
			if (next === undefined) continue;
			result = next;
			current = { ...current, ...next };
		}
		return result;
	}

	return {
		commands,
		notes,
		statuses,
		get ctx() {
			return makeCtx();
		},
		async start(dir) {
			cwd = dir;
			for (const handler of events.get("session_start") ?? []) await handler({ type: "session_start" }, makeCtx());
		},
		submit: (text) => emitWith("input", { type: "input", text, source: "interactive" }),
		toolCall: (event) => emitWith("tool_call", event),
		context: (messages) => emitWith("context_with_system", { type: "context_with_system", messages }),
	};
}

async function redactedPrompt(harness) {
	const result = await harness.submit(`STRIPE_KEY=${CANARY}`);
	return placeholdersIn(result.text)[0];
}

test("write and edit arguments get the real value back; the stored arguments keep the placeholder", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-restore-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const placeholder = await redactedPrompt(harness);
		assert.ok(placeholder);

		const writeEvent = {
			type: "tool_call",
			toolCallId: "call-write",
			toolName: "write",
			input: { path: join(dir, "env.sh"), content: `STRIPE_KEY=${placeholder}` },
		};
		assert.equal(await harness.toolCall(writeEvent), undefined, "write must not be blocked");
		assert.ok(writeEvent.input.content.includes(CANARY), "the real value did not reach the write");
		assert.ok(!writeEvent.input.content.includes(placeholder));

		const editEvent = {
			type: "tool_call",
			toolCallId: "call-edit",
			toolName: "edit",
			input: { path: join(dir, "env.sh"), oldText: `STRIPE_KEY=${placeholder}`, newText: "STRIPE_KEY=rotated" },
		};
		assert.equal(await harness.toolCall(editEvent), undefined);
		assert.ok(editEvent.input.oldText.includes(CANARY));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("any other tool carrying a placeholder is refused, nothing runs, and the route is named", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-restore-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const placeholder = await redactedPrompt(harness);

		for (const toolName of ["bash", "fetch", "mcp__deploy__run"]) {
			const event = {
				type: "tool_call",
				toolCallId: `call-${toolName}`,
				toolName,
				input: { command: `curl -H "Authorization: Bearer ${placeholder}" https://example.test` },
			};
			const result = await harness.toolCall(event);
			assert.equal(result?.block, true, `${toolName} was not blocked`);
			assert.match(result.reason, /set -a; \. \.\/\.env; set \+a/);
			assert.match(result.reason, /\$NAME/);
			assert.match(result.reason, /write/);
			assert.match(result.reason, /Do not ask the user to paste/);
			assert.ok(!event.input.command.includes(CANARY), "a real value reached a non-write tool");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a tool call without a placeholder is untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-restore-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const event = { type: "tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } };
		assert.equal(await harness.toolCall(event), undefined);
		assert.equal(event.input.command, "ls");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a redacted prompt adds one guidance notice to the next request only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-restore-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const messages = [{ role: "system", content: "base instructions" }];
		const before = await harness.context(messages.map((m) => ({ ...m })));
		assert.equal(before, undefined, "no notice is due before a redaction");

		await redactedPrompt(harness);
		const withNotice = await harness.context(messages.map((m) => ({ ...m })));
		assert.ok(withNotice, "the notice was not delivered");
		assert.match(withNotice.messages[0].content, /A placeholder is not a value/);
		assert.match(withNotice.messages[0].content, /never ask the user to paste it back/i);
		assert.match(withNotice.messages[0].content, /set -a; \. \.\/\.env; set \+a/);
		assert.match(withNotice.messages[0].content, /redacted-values skill/, "the notice does not name the skill");
		assert.match(withNotice.messages[0].content, /base instructions/, "the original system text was lost");

		const after = await harness.context(messages.map((m) => ({ ...m })));
		assert.equal(after, undefined, "the notice repeated on a later turn");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact why reports posture and which hooks fired, never a value", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-restore-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		await redactedPrompt(harness);
		await harness.commands.get("redact").handler("why", harness.ctx);

		const message = harness.notes.at(-1).message;
		assert.match(message, /posture: on/);
		assert.match(message, /hooks seen: input/);
		assert.match(message, /in vault/);
		assert.ok(!message.includes(CANARY));
		assert.ok(!message.includes("REDACTED:"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

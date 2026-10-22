import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import contextRedact from "./context-redact.ts";
import { CANARY } from "./test/canary.mjs";


function createHarness() {
	const events = new Map();
	const notes = [];
	const statuses = new Map();
	let cwd;

	const pi = {
		on(event, handler) {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
			return () => {};
		},
		registerCommand() {},
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

	async function emit(name, event) {
		let current = event;
		for (const handler of events.get(name) ?? []) {
			const next = await handler(current, makeCtx());
			if (next === undefined) continue;
			current = { ...current, ...next };
		}
		return current;
	}

	return {
		notes,
		statuses,
		async start(dir) {
			cwd = dir;
			for (const handler of events.get("session_start") ?? []) await handler({ type: "session_start" }, makeCtx());
		},
		emit,
	};
}

test("a reply that restates a secret is replaced with the placeholder, role and blocks kept", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `the key was ${CANARY}` },
				{ type: "text", text: "here it is:" },
				{ type: "text", text: `STRIPE_KEY=${CANARY}` },
			],
		};
		const result = await harness.emit("message_end", { type: "message_end", message });

		assert.equal(result.message.role, "assistant");
		assert.equal(result.message.content.length, 3);
		assert.equal(result.message.content[0].type, "thinking");
		assert.match(result.message.content[0].thinking, /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/);
		assert.equal(result.message.content[1].text, "here it is:");
		assert.match(result.message.content[2].text, /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/);
		assert.ok(JSON.stringify(result.message).indexOf(CANARY) === -1);
		assert.match(harness.statuses.get("context-redact"), /redact 2/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a reply with nothing secret is left untouched", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const message = { role: "assistant", content: [{ type: "text", text: "nothing here" }] };
		const result = await harness.emit("message_end", { type: "message_end", message });
		assert.equal(result.message, message);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("injected system content is scrubbed in the outgoing request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const messages = [
			{ role: "system", content: `project notes: key ${CANARY}` },
			{ role: "user", content: [{ type: "text", text: "continue" }] },
			{ role: "assistant", content: [{ type: "text", text: "working" }] },
		];
		const result = await harness.emit("context_with_system", { type: "context_with_system", messages });

		assert.equal(result.messages.length, 3);
		assert.match(result.messages[0].content, /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/);
		assert.ok(result.messages[0].content.indexOf(CANARY) === -1);
		assert.deepEqual(result.messages[1], messages[1]);
		assert.deepEqual(result.messages[2], messages[2]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a message already scrubbed on the way into the transcript is not rescanned", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const message = { role: "assistant", content: [{ type: "text", text: `STRIPE_KEY=${CANARY}` }] };
		await harness.emit("message_end", { type: "message_end", message });
		const messages = [{ role: "system", content: "sys" }, message];
		const result = await harness.emit("context_with_system", { type: "context_with_system", messages });
		assert.equal(result.messages, messages, "the transcript was rewritten again after message_end");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an injected transcript with no secret produces no rewrite", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const messages = [{ role: "system", content: "nothing secret" }];
		const result = await harness.emit("context_with_system", { type: "context_with_system", messages });
		assert.equal(result.messages, messages);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("withholding a reply keeps the tool calls it asked for", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const saved = process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS;
		process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS = "-1";
		try {
			const harness = createHarness();
			await harness.start(dir);
			const message = {
				role: "assistant",
				content: [
					{ type: "text", text: `STRIPE_KEY=${CANARY}` },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.env" } },
				],
			};
			const result = await harness.emit("message_end", { type: "message_end", message });
			assert.equal(result.message.content.length, 2);
			assert.match(result.message.content[0].text, /^\[redact withheld this content/);
			assert.equal(result.message.content[1].type, "toolCall");
			assert.equal(result.message.content[1].id, "call-1");
		} finally {
			if (saved === undefined) delete process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS;
			else process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS = saved;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unscannable reply is withheld rather than stored raw", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-reply-"));
	try {
		const saved = process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS;
		process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS = "-1";
		try {
			const harness = createHarness();
			await harness.start(dir);
			const message = { role: "assistant", content: [{ type: "text", text: `STRIPE_KEY=${CANARY}` }] };
			const result = await harness.emit("message_end", { type: "message_end", message });
			assert.equal(result.message.role, "assistant");
			assert.match(result.message.content[0].text, /^\[redact withheld this content/);
			assert.ok(!JSON.stringify(result.message).includes(CANARY));
		} finally {
			if (saved === undefined) delete process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS;
			else process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS = saved;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

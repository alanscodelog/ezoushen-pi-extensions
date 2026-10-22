import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import contextRedact from "./context-redact.ts";
import { CANARY } from "./test/canary.mjs";

const SALT_CANARY = CANARY;

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
	const makeCtx = () => ({
		mode: "tui",
		hasUI: true,
		cwd,
		isProjectTrusted: () => false,
		ui,
	});

	contextRedact(pi);

	async function deliver(event) {
		let current = event;
		for (const handler of events.get("tool_result") ?? []) {
			const next = await handler(current, makeCtx());
			if (next === undefined) continue;
			current = { ...current, ...next };
		}
		return current;
	}

	return {
		events,
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
		deliver,
	};
}

function textResult(text, details, usage) {
	return {
		type: "tool_result",
		toolName: "read",
		toolCallId: "call-1",
		input: { path: "notes.env" },
		content: [{ type: "text", text }],
		details,
		isError: false,
		usage,
	};
}

test("a file read holding a key is stored and sent as a placeholder, details intact", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-tool-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const details = { path: "notes.env", truncated: false, lines: 2 };
		const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, cost: 0 };
		const result = await harness.deliver(textResult(`STRIPE_KEY=${SALT_CANARY}`, details, usage));

		const text = result.content.map((block) => block.text ?? "").join("");
		assert.match(text, /\[REDACTED:GENERIC_API_KEY#[0-9a-f]{16}\]/);
		assert.ok(!text.includes(SALT_CANARY));
		assert.deepEqual(result.details, details);
		assert.deepEqual(result.usage, usage, "tool usage was dropped by the redaction");
		assert.match(harness.statuses.get("context-redact"), /redact 1/);

		await harness.commands.get("redact").handler("", harness.ctx);
		assert.match(harness.notes.at(-1).message, /GENERIC_API_KEY×1/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a result with nothing secret passes through byte-identical with no rewrite", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-tool-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const original = textResult("plain build output\nnothing to see");
		const result = await harness.deliver(original);
		assert.equal(result.content[0].text, original.content[0].text);
		assert.equal(result.details, original.details);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a row above the candidate ceiling is withheld whole, never half-scrubbed", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-tool-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const crowd = Array.from({ length: 600 }, (_, index) => `STRIPE_KEY=${CANARY}${index}`).join("\n");
		const result = await harness.deliver(textResult(crowd));

		const text = result.content.map((block) => block.text ?? "").join("");
		assert.match(text, /^\[redact withheld this content/);
		assert.match(text, /\(hits\)/);
		assert.ok(!text.includes("sk_live_"));

		await harness.commands.get("redact").handler("", harness.ctx);
		assert.match(harness.notes.at(-1).message, /1 withheld/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a scan that overruns its budget withholds the row and names the failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-tool-"));
	try {
		const saved = process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS;
		process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS = "-1";
		try {
			const harness = createHarness();
			await harness.start(dir);
			const result = await harness.deliver(textResult(`STRIPE_KEY=${SALT_CANARY}`));
			const text = result.content.map((block) => block.text ?? "").join("");
			assert.match(text, /\(budget\)/);
			assert.ok(!text.includes(SALT_CANARY));
			assert.equal(result.isError, false, "withholding must not turn the row into a tool error");
		} finally {
			if (saved === undefined) delete process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS;
			else process.env.PI_CONTEXT_REDACT_SCAN_BUDGET_MS = saved;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

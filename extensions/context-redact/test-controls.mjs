import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import contextRedact from "./context-redact.ts";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const GENERIC = "api_key = k9f3c9a2b7d1e4f6";

function placeholders(text) {
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

	return {
		notes,
		statuses,
		get ctx() {
			return makeCtx();
		},
		async start(dir) {
			cwd = dir;
			for (const handler of events.get("session_start") ?? []) await handler({ type: "session_start" }, makeCtx());
		},
		async submit(text) {
			let current = text;
			let result = { action: "continue" };
			for (const handler of events.get("input") ?? []) {
				const next = await handler({ type: "input", text: current, source: "interactive" }, makeCtx());
				if (next?.action === "handled") return next;
				if (next?.action === "transform") {
					result = next;
					current = next.text;
				}
			}
			return result;
		},
		run: (args) => commands.get("redact").handler(args, makeCtx()),
	};
}

test("/redact allow exempts a value that would otherwise be redacted", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const before = await harness.submit(GENERIC);
		assert.equal(placeholders(before.text).length, 1);

		await harness.run("allow k9f3c9a2b7d1e4f6");
		const after = await harness.submit(GENERIC);
		assert.equal(after.action, "continue");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact deny forces a value the allowlist would keep", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const before = await harness.submit(`id ${UUID}`);
		assert.equal(before.action, "continue", "the UUID should pass untouched first");

		await harness.run(`deny ${UUID}`);
		const after = await harness.submit(`id ${UUID}`);
		assert.match(after.text, /\[REDACTED:USER_DENY#[0-9a-f]{16}\]/);
		assert.ok(!after.text.includes(UUID));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact rule off stops that family's label, on puts it back, list shows it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	try {
		const harness = createHarness();
		await harness.start(dir);

		await harness.run("rule off generic-api-key");
		const off = await harness.submit(GENERIC);
		assert.ok(!placeholders(off.text ?? "").some((p) => p.includes("GENERIC_API_KEY")));

		await harness.run("rule list");
		assert.match(harness.notes.at(-1).message, /generic-api-key/);

		await harness.run("rule on generic-api-key");
		const back = await harness.submit(GENERIC);
		assert.match(back.text, /\[REDACTED:GENERIC_API_KEY#[0-9a-f]{16}\]/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown rule id reports and changes nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		await harness.run("rule off not-a-rule");
		assert.match(harness.notes.at(-1).message, /no such rule: not-a-rule/);
		const result = await harness.submit(GENERIC);
		assert.equal(placeholders(result.text).length, 1, "the corpus changed after a typo");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("disabledRules from settings are off at session start", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	const saved = process.env.PI_CONTEXT_REDACT_DISABLED_RULES;
	process.env.PI_CONTEXT_REDACT_DISABLED_RULES = "generic-api-key";
	try {
		const harness = createHarness();
		await harness.start(dir);
		const result = await harness.submit(GENERIC);
		assert.ok(!placeholders(result.text ?? "").some((p) => p.includes("GENERIC_API_KEY")));
	} finally {
		if (saved === undefined) delete process.env.PI_CONTEXT_REDACT_DISABLED_RULES;
		else process.env.PI_CONTEXT_REDACT_DISABLED_RULES = saved;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact tier changes the operating point", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const borderline = "example sample dummy fixture mock api_token = k9f3c9a2b7d1e4f6";
		const balanced = await harness.submit(borderline);
		assert.equal(balanced.action, "continue");

		await harness.run("tier strict");
		const strict = await harness.submit(borderline);
		assert.equal(strict.action, "transform");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact reports counts, restore count, vault size and withheld count, never a value", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-controls-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		await harness.submit(`api_key = k9f3c9a2b7d1e4f6 and id ${UUID}`);
		await harness.run("");
		const message = harness.notes.at(-1).message;
		assert.match(message, /hidden/);
		assert.match(message, /restored/);
		assert.match(message, /vault/);
		assert.match(message, /withheld/);
		assert.ok(!message.includes(UUID));
		assert.ok(!message.includes("k9f3c9a2b7d1e4f6"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

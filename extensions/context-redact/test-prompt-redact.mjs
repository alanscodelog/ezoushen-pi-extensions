import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import contextRedact from "./context-redact.ts";

const PEM_KEY = [
	"-----BEGIN RSA PRIVATE KEY-----",
	"MFwCAQACggEBAMvA27/Ka6Sf9JCoZRniWKM6NretBBvC9OetYNd0dvS7zEeYcrxm",
	"ZRiaZp+ufgOMR1yJyWIj7is6ylJwKXi2fr8NR6HDgGbVitM969urgPJEGDil+A==",
	"-----END RSA PRIVATE KEY-----",
].join("\n");
const JWT =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const CARD = "4111 1111 1111 1111";
const SSN = "123-45-6784";
const IBAN = "DE89370400440532013000";

function createHarness({ trusted = false } = {}) {
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
		isProjectTrusted: () => trusted,
		ui,
	});

	contextRedact(pi);
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
		async submit(text) {
			let current = text;
			let result = { action: "continue" };
			for (const handler of events.get("input") ?? []) {
				const next = await handler(
					{ type: "input", text: current, source: "interactive" },
					makeCtx(),
				);
				if (next?.action === "handled") return next;
				if (next?.action === "transform") {
					result = next;
					current = next.text;
				}
			}
			return result;
		},
	};
}

function placeholders(text) {
	return [...text.matchAll(/\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/g)].map((match) => match[0]);
}

async function withEnv(overrides, run) {
	const saved = {};
	for (const [key, value] of Object.entries(overrides)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("structural secrets in a prompt become labelled placeholders", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const result = await harness.submit(`key:\n${PEM_KEY}\njwt ${JWT}\ncard ${CARD} ssn ${SSN} iban ${IBAN}`);

		assert.equal(result.action, "transform");
		assert.doesNotMatch(result.text, /BEGIN RSA PRIVATE KEY/, "the PEM body survived");
		assert.ok(!result.text.includes(JWT));
		assert.ok(!result.text.includes("4111 1111 1111 1111"));
		assert.ok(!result.text.includes(SSN));
		assert.ok(!result.text.includes(IBAN));
		assert.equal(placeholders(result.text).length, 5);
		assert.match(result.text, /\[REDACTED:RSA_PRIVATE_KEY#[0-9a-f]{16}\]/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the same value yields the same placeholder, and another session differs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-"));
	try {
		const first = createHarness();
		await first.start(dir);
		const a = await first.submit(`card ${CARD}`);
		const b = await first.submit(`again card ${CARD}`);
		const second = createHarness();
		await second.start(dir);
		const c = await second.submit(`card ${CARD}`);

		assert.equal(placeholders(a.text)[0], placeholders(b.text)[0]);
		assert.notEqual(placeholders(a.text)[0], placeholders(c.text)[0]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact reports counts by label and never a value", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		await harness.submit(`card ${CARD} and ssn ${SSN}`);
		await harness.commands.get("redact").handler("", harness.ctx);

		const message = harness.notes.at(-1).message;
		assert.match(message, /2 hidden/);
		assert.match(message, /CARD_NUMBER×1/);
		assert.match(message, /SSN×1/);
		assert.ok(!message.includes(CARD));
		assert.ok(!message.includes(SSN));
		assert.match(harness.statuses.get("context-redact"), /redact 2/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/redact off leaves prompts untouched and /redact on resumes scanning", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-"));
	try {
		const harness = createHarness();
		await harness.start(dir);
		const command = harness.commands.get("redact");

		await command.handler("off", harness.ctx);
		const off = await harness.submit(`card ${CARD}`);
		assert.equal(off.action, "continue");

		await command.handler("on", harness.ctx);
		const on = await harness.submit(`card ${CARD}`);
		assert.equal(on.action, "transform");
		assert.equal(placeholders(on.text).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a scan that overruns its budget withholds the prompt with a visible notice", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-"));
	try {
		await withEnv({ PI_CONTEXT_REDACT_SCAN_BUDGET_MS: "-1" }, async () => {
			const harness = createHarness();
			await harness.start(dir);
			const result = await harness.submit(`card ${CARD}`);
			assert.equal(result.action, "handled");
			const note = harness.notes.at(-1);
			assert.equal(note.level, "warning");
			assert.match(note.message, /withheld your prompt \(budget\)/);
			assert.match(note.message, /not sent rather than sent unscanned/);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fresh install loads and starts silently", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-redact-"));
	try {
		const harness = createHarness();
		await withEnv(
			{
				PI_CONTEXT_REDACT_ENABLED: undefined,
				PI_CONTEXT_REDACT_TIER: undefined,
				PI_CONTEXT_REDACT_SCAN_BUDGET_MS: undefined,
			},
			async () => {
				await harness.start(dir);
			},
		);
		assert.equal(harness.statuses.size, 0);
		assert.equal(harness.notes.length, 0);
		const unchanged = await harness.submit("nothing secret here");
		assert.equal(unchanged.action, "continue");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

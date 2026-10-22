import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import footer from "../footer.ts";

function mount() {
	const handlers = new Map();
	let footerFactory;
	footer({ on: (name, handler) => handlers.set(name, handler) });
	const ctx = {
		hasUI: true,
		cwd: "/repo/my-project",
		model: { id: "catalog-model-id", name: "Catalog Model", contextWindow: 262_000 },
		getContextUsage: () => ({ tokens: 90_000 }),
		ui: { setFooter: (value) => { footerFactory = value; } },
	};
	return Promise.resolve(handlers.get("session_start")({}, ctx)).then(() => {
		const theme = { fg: (_color, value) => value };
		const ui = { requestRender() {} };
		return { ctx, handlers, renderer: footerFactory(ui, theme, {}) };
	});
}

function spyOnChildProcess() {
	const calls = [];
	const names = ["exec", "execFile", "execSync", "execFileSync", "fork", "spawn", "spawnSync"];
	const originals = new Map(names.map((name) => [name, childProcess[name]]));
	for (const name of names) {
		childProcess[name] = (..._args) => {
			calls.push(name);
			throw new Error(`${name} called during render`);
		};
	}
	syncBuiltinESMExports();
	return {
		calls,
		restore() {
			for (const [name, original] of originals) childProcess[name] = original;
			syncBuiltinESMExports();
		},
	};
}

test("render does not launch a child process", async () => {
	const mounted = await mount();
	const spy = spyOnChildProcess();
	let renderError;
	try {
		try {
			mounted.renderer.render(120);
		} catch (error) {
			renderError = error;
		}
	} finally {
		spy.restore();
	}
	assert.deepEqual(spy.calls, []);
	assert.equal(renderError, undefined);
});

test("a 262k context window with 90k used renders the used percent and window suffix", async () => {
	const mounted = await mount();
	const lines = mounted.renderer.render(120);
	assert.ok(lines.some((line) => line.includes("██░░░░ 34% · 262k")));
});

test("the footer shows the catalog model name instead of its id", async () => {
	const mounted = await mount();
	const text = mounted.renderer.render(120).join("\n");
	assert.match(text, /Catalog Model/);
	assert.doesNotMatch(text, /catalog-model-id/);
});

test("the footer renders the directory, context, current speed, and model name", async () => {
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const mounted = await mount();
		const startResponse = mounted.handlers.get("message_start");
		assert.equal(typeof startResponse, "function");
		await startResponse({ message: { role: "assistant" } }, mounted.ctx);
		now = 2_000;
		const updateResponse = mounted.handlers.get("message_update");
		assert.equal(typeof updateResponse, "function");
		await updateResponse({
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "four" },
		}, mounted.ctx);
		assert.deepEqual(mounted.renderer.render(120), [
			"my-project │ ██░░░░ 34% · 262k │ 1.0 tps… │ Catalog Model [–]",
		]);
	} finally {
		Date.now = originalNow;
	}
});

test("the footer shows the provider, display name and thinking level", async () => {
	const handlers = new Map();
	let footerFactory;
	footer({ on: (name, handler) => handlers.set(name, handler), getThinkingLevel: () => "high" });
	const ctx = {
		hasUI: true,
		cwd: "/repo/my-project",
		model: { id: "catalog-model-id", name: "Catalog Model", provider: "splash", contextWindow: 262_000, reasoning: true },
		getContextUsage: () => ({ tokens: 90_000 }),
		ui: { setFooter: (value) => { footerFactory = value; } },
	};
	await handlers.get("session_start")({}, ctx);
	const theme = { fg: (_color, value) => value };
	const renderer = footerFactory({ requestRender() {} }, theme, {});
	assert.match(renderer.render(200).join("\n"), /\(splash\) Catalog Model \[high\]/);
});

test("a reasoning model with thinking off shows T, and a plain model shows a dash", async () => {
	for (const [model, expected] of [
		[{ id: "m", name: "Reasoner", provider: "p", contextWindow: 262_000, reasoning: true }, "Reasoner [T]"],
		[{ id: "m", name: "Plain", provider: "p", contextWindow: 262_000 }, "Plain [–]"],
	]) {
		const handlers = new Map();
		let footerFactory;
		footer({ on: (name, handler) => handlers.set(name, handler), getThinkingLevel: () => "off" });
		const ctx = {
			hasUI: true,
			cwd: "/repo/my-project",
			model,
			getContextUsage: () => ({ tokens: 1_000 }),
			ui: { setFooter: (value) => { footerFactory = value; } },
		};
		await handlers.get("session_start")({}, ctx);
		const renderer = footerFactory({ requestRender() {} }, { fg: (_c, v) => v }, {});
		assert.ok(renderer.render(200).join("\n").includes(expected), expected);
	}
});

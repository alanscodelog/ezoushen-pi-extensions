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

test("speed is the whole-session average, not the last turn rate", async () => {
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const mounted = await mount();
		const start = mounted.handlers.get("message_start");
		const update = mounted.handlers.get("message_update");
		const end = mounted.handlers.get("message_end");

		// turn 1: 100 output tokens over 2s -> 50 tps on its own
		await start({ message: { role: "assistant" } }, mounted.ctx);
		now = 2_000;
		await update({
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "abcd" },
		}, mounted.ctx);
		now = 3_000;
		await end({ message: { role: "assistant", usage: { output: 100 } } }, mounted.ctx);
		assert.match(mounted.renderer.render(120).join("\n"), /50\.0 tps/);

		// turn 2: 300 output tokens over 1s -> 300 tps on its own, but the
		// session is now 400 tokens over 3s -> ~133 tps (integers at or above 100)
		now = 10_000;
		await start({ message: { role: "assistant" } }, mounted.ctx);
		now = 11_000;
		await end({ message: { role: "assistant", usage: { output: 300 } } }, mounted.ctx);
		assert.match(mounted.renderer.render(120).join("\n"), /133 tps/);
	} finally {
		Date.now = originalNow;
	}
});

test("during a turn the session average includes the live output so far", async () => {
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		const mounted = await mount();
		const start = mounted.handlers.get("message_start");
		const update = mounted.handlers.get("message_update");
		const end = mounted.handlers.get("message_end");

		await start({ message: { role: "assistant" } }, mounted.ctx);
		now = 3_000;
		await end({ message: { role: "assistant", usage: { output: 200 } } }, mounted.ctx);

		// 200 tokens / 2s = 100 tps; start a second turn and stream more
		now = 10_000;
		await start({ message: { role: "assistant" } }, mounted.ctx);
		now = 11_000;
		await update({
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "abcdefgh" },
		}, mounted.ctx);
		// session: 200 + ~2 live tokens over 2s + 1s -> ~67.3 tps, still marked in progress
		const line = mounted.renderer.render(120).join("\n");
		assert.match(line, /tps…/);
		assert.doesNotMatch(line, /100\.0 tps/);
	} finally {
		Date.now = originalNow;
	}
});

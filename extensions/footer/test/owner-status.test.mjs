import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import footer from "../footer.ts";

function mount(footerData = {}) {
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
		return { renderer: footerFactory(ui, theme, footerData) };
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

test("published extension statuses render as separate owner blocks", async () => {
	const mounted = await mount({
		getExtensionStatuses: () => new Map([
			["pi-lens", "Searching"],
			["owner-b", "Ready"],
		]),
	});

	assert.deepEqual(mounted.renderer.render(120), [
		"my-project │ ██░░░░ 34% · 262k │ -- tps │ Catalog Model [–]",
		"│ pi-lens · Searching",
		"│ owner-b · Ready",
	]);
});

test("a multi-line extension status indents continuation lines under its label", async () => {
	const mounted = await mount({
		getExtensionStatuses: () => new Map([
			["pi-lens", "Searching\nwaiting for results\nready"],
		]),
	});

	assert.deepEqual(mounted.renderer.render(120), [
		"my-project │ ██░░░░ 34% · 262k │ -- tps │ Catalog Model [–]",
		"│ pi-lens · Searching",
		`${"│ "}${" ".repeat("pi-lens · ".length)}waiting for results`,
		`${"│ "}${" ".repeat("pi-lens · ".length)}ready`,
	]);
});

test("all footer lines fit the available width", async () => {
	const mounted = await mount({
		getExtensionStatuses: () => new Map([
			["pi-lens", "Searching the index"],
			["owner-b", "Ready"],
		]),
	});
	assert.ok(mounted.renderer.render(120)[1].startsWith("│ pi-lens · "));
	for (const width of [0, 1, 24, 60, 120]) {
		const lines = mounted.renderer.render(width);
		assert.ok(lines.length >= 3);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `all lines fit width ${width}`);
		assert.deepEqual(lines.slice(-2), [
			truncateToWidth("│ pi-lens · Searching the index", width, "…"),
			truncateToWidth("│ owner-b · Ready", width, "…"),
		]);
	}
});

test("owners without published statuses produce no owner blocks", async () => {
	const mounted = await mount({ getExtensionStatuses: () => new Map() });

	assert.deepEqual(mounted.renderer.render(120), [
		"my-project │ ██░░░░ 34% · 262k │ -- tps │ Catalog Model [–]",
	]);
});

test("render reads cached owner statuses without launching a process", async () => {
	let statusReads = 0;
	const mounted = await mount({
		getExtensionStatuses: () => {
			statusReads += 1;
			return new Map([["pi-lens", "Working"]]);
		},
	});
	const processes = spyOnChildProcess();
	try {
		assert.equal(statusReads, 0);
		const lines = mounted.renderer.render(120);
		assert.equal(statusReads, 1);
		assert.deepEqual(processes.calls, []);
		assert.deepEqual(lines.slice(1), ["│ pi-lens · Working"]);
	} finally {
		processes.restore();
	}
});

test("owner labels are dim and the pipe is borderMuted, and known keys use friendly labels", async () => {
	const colours = [];
	const handlers = new Map();
	let footerFactory;
	footer({ on: (name, handler) => handlers.set(name, handler) });
	const ctx = {
		hasUI: true,
		cwd: "/repo/my-project",
		model: { id: "m", name: "Model", contextWindow: 262_000 },
		getContextUsage: () => ({ tokens: 1_000 }),
		ui: { setFooter: (value) => { footerFactory = value; } },
	};
	await handlers.get("session_start")({}, ctx);
	const theme = { fg: (colour, value) => { colours.push([colour, value]); return value; } };
	const renderer = footerFactory(
		{ requestRender() {} },
		theme,
		{ getExtensionStatuses: () => new Map([["pi-lens-lsp", "Active: typescript"], ["pi-permission-system", "yolo"]]) },
	);
	const text = renderer.render(120).join("\n");
	assert.match(text, /│ pi-lens · Active: typescript/);
	assert.match(text, /│ perms · yolo/);
	assert.ok(colours.some(([c, v]) => c === "borderMuted" && v.trim() === "│"), "pipe uses borderMuted");
	assert.ok(colours.some(([c, v]) => c === "dim" && v.startsWith("pi-lens · ")), "label uses dim");
});

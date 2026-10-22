import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import footer from "../footer.ts";

function mount(branch = "feature/worktree") {
	const handlers = new Map();
	let footerFactory;
	let branchListener;
	let currentBranch = branch;
	footer({ on: (name, handler) => handlers.set(name, handler) });
	const ctx = {
		hasUI: true,
		cwd: "/repo/my-project",
		model: { id: "catalog-model-id", name: "Catalog Model", contextWindow: 262_000 },
		getContextUsage: () => ({ tokens: 90_000 }),
		ui: { setFooter: (value) => { footerFactory = value; } },
	};
	const footerData = {
		getGitBranch: () => currentBranch,
		onBranchChange: (callback) => {
			branchListener = callback;
			return () => { branchListener = undefined; };
		},
	};
	return Promise.resolve(handlers.get("session_start")({}, ctx)).then(() => {
		const theme = { fg: (_color, value) => value };
		const ui = { requestRender() {} };
		return {
			ctx,
			handlers,
			renderer: footerFactory(ui, theme, footerData),
			changeBranch: (nextBranch) => {
				currentBranch = nextBranch;
				branchListener?.();
			},
		};
	});
}

function stubExecFile(outputs) {
	const calls = [];
	const original = childProcess.execFile;
	childProcess.execFile = (file, args, options, callback) => {
		calls.push({ file, args, options });
		let output = outputs.get(`${file} ${args.join(" ")}`) ?? "";
		if (Array.isArray(output)) output = output.shift() ?? "";
		if (output instanceof Error) callback(output, "", "");
		else callback(null, output, "");
		return {};
	};
	syncBuiltinESMExports();
	return {
		calls,
		restore() {
			childProcess.execFile = original;
			syncBuiltinESMExports();
		},
	};
}

function stubDeferredPr() {
	const calls = [];
	const pending = [];
	const original = childProcess.execFile;
	childProcess.execFile = (file, args, options, callback) => {
		calls.push({ file, args, options });
		if (file === "gh") pending.push({ callback });
		else callback(null, "", "");
		return {};
	};
	syncBuiltinESMExports();
	return {
		calls,
		resolvePr(output) {
			const call = pending.shift();
			assert.ok(call);
			call.callback(null, output, "");
		},
		restore() {
			childProcess.execFile = original;
			syncBuiltinESMExports();
		},
	};
}

test("the footer shows the associated PR number next to its branch using a bounded gh lookup", async () => {
	const process = stubExecFile(new Map([
		["git status --porcelain", ""],
		["git diff HEAD --numstat", ""],
		["gh pr view --json number --jq .number", "42"],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree \(#42\)/);
		const ghCall = process.calls.find(({ file }) => file === "gh");
		assert.deepEqual(ghCall && { file: ghCall.file, args: ghCall.args, timeout: ghCall.options.timeout }, {
			file: "gh",
			args: ["pr", "view", "--json", "number", "--jq", ".number"],
			timeout: 2_500,
		});
	} finally {
		process.restore();
	}
});

test("a no-PR result is cached until the branch changes", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const process = stubExecFile(new Map([
		["git status --porcelain", ""],
		["git diff HEAD --numstat", ""],
		["gh pr view --json number --jq .number", [Object.assign(new Error("Command failed"), {
			stderr: 'no pull requests found for branch "feature/worktree"',
		}), "84"]],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 1);

		await mounted.handlers.get("tool_result")({}, mounted.ctx);
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 1);
		assert.doesNotMatch(mounted.renderer.render(120).join("\n"), /#84/);

		mounted.changeBranch("feature/next");
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 2);
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/next \(#84\)/);
	} finally {
		process.restore();
		t.mock.timers.reset();
	}
});

test("a failed PR lookup is retried on the next refresh", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const process = stubExecFile(new Map([
		["git status --porcelain", ""],
		["git diff HEAD --numstat", ""],
		["gh pr view --json number --jq .number", [Object.assign(new Error("Command failed"), {
			stderr: "temporary GitHub API failure",
		}), "84"]],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 1);

		await mounted.handlers.get("tool_result")({}, mounted.ctx);
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 2);
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree \(#84\)/);
	} finally {
		process.restore();
		t.mock.timers.reset();
	}
});

test("a PR result from an older branch is discarded after a branch change", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const process = stubDeferredPr();
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		mounted.changeBranch("feature/next");

		process.resolvePr("42");
		await new Promise((resolve) => setImmediate(resolve));
		assert.doesNotMatch(mounted.renderer.render(120).join("\n"), /#42/);
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 1);

		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(process.calls.filter(({ file }) => file === "gh").length, 2);
		process.resolvePr("84");
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/next \(#84\)/);
	} finally {
		process.restore();
		t.mock.timers.reset();
	}
});

test("render reads the cached PR number without launching another process", async () => {
	const process = stubExecFile(new Map([
		["git status --porcelain", ""],
		["git diff HEAD --numstat", ""],
		["gh pr view --json number --jq .number", "42"],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		const callsBeforeRender = process.calls.length;
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree \(#42\)/);
		assert.equal(process.calls.length, callsBeforeRender);
	} finally {
		process.restore();
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import footer from "../footer.ts";

function mount(branch = "feature/worktree") {
	const handlers = new Map();
	let footerFactory;
	let branchListener;
	footer({ on: (name, handler) => handlers.set(name, handler) });
	const ctx = {
		hasUI: true,
		cwd: "/repo/my-project",
		model: { id: "catalog-model-id", name: "Catalog Model", contextWindow: 262_000 },
		getContextUsage: () => ({ tokens: 90_000 }),
		ui: { setFooter: (value) => { footerFactory = value; } },
	};
	const footerData = {
		getGitBranch: () => branch,
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
			refreshBranch: () => branchListener?.(),
		};
	});
}

function stubGit(outputs) {
	const calls = [];
	const original = childProcess.execFile;
	childProcess.execFile = (file, args, options, callback) => {
		if (file !== "git") {
			callback(new Error("non-git command not configured in git-status fixture"), "", "");
			return {};
		}
		calls.push({ file, args, options });
		callback(null, outputs.get(args.join(" ")) ?? "", "");
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

function stubDeferredGit() {
	const calls = [];
	const pending = [];
	const original = childProcess.execFile;
	childProcess.execFile = (file, args, options, callback) => {
		if (file !== "git") {
			callback(new Error("non-git command not configured in git-status fixture"), "", "");
			return {};
		}
		const call = { file, args, options, callback };
		calls.push(call);
		pending.push(call);
		return {};
	};
	syncBuiltinESMExports();
	return {
		calls,
		resolveRound(outputs) {
			const round = pending.splice(0, 2);
			assert.equal(round.length, 2);
			for (const call of round) call.callback(null, outputs.get(call.args.join(" ")) ?? "", "");
		},
		restore() {
			childProcess.execFile = original;
			syncBuiltinESMExports();
		},
	};
}

test("the footer shows the branch, changed-file count, and added/deleted lines", async () => {
	const git = stubGit(new Map([
		["status --porcelain", " M src/changed.ts\n?? src/new.ts\n"],
		["diff HEAD --numstat", "5\t3\tsrc/changed.ts\n"],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree \(2\) \+5\/-3/);
		assert.deepEqual(git.calls.map(({ args, options }) => ({ args, timeout: options.timeout })), [
			{ args: ["status", "--porcelain"], timeout: 2_500 },
			{ args: ["diff", "HEAD", "--numstat"], timeout: 2_500 },
		]);
	} finally {
		git.restore();
	}
});

test("render paints cached git status without launching git", async () => {
	const git = stubGit(new Map([
		["status --porcelain", " M src/changed.ts\n"],
		["diff HEAD --numstat", "5\t3\tsrc/changed.ts\n"],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		const callsBeforeRender = git.calls.length;
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree \(1\) \+5\/-3/);
		assert.equal(git.calls.length, callsBeforeRender);
	} finally {
		git.restore();
	}
});

test("git refreshes start no more than once per second", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const git = stubGit(new Map([
		["status --porcelain", " M src/changed.ts\n"],
		["diff HEAD --numstat", "5\t3\tsrc/changed.ts\n"],
	]));
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 2);

		mounted.refreshBranch();
		assert.equal(git.calls.length, 2);
		t.mock.timers.tick(999);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 2);

		t.mock.timers.tick(1);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 4);
	} finally {
		git.restore();
		t.mock.timers.reset();
	}
});

test("branch, tool, and message refreshes coalesce into one queued follow-up", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const git = stubDeferredGit();
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 2);

		mounted.refreshBranch();
		mounted.refreshBranch();
		assert.equal(git.calls.length, 2);

		git.resolveRound(new Map([
			["status --porcelain", " M src/first.ts\n"],
			["diff HEAD --numstat", "1\t0\tsrc/first.ts\n"],
		]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 2);
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 4);

		await mounted.handlers.get("tool_result")({}, mounted.ctx);
		assert.equal(git.calls.length, 4);
		git.resolveRound(new Map([
			["status --porcelain", " M src/second.ts\n"],
			["diff HEAD --numstat", "2\t1\tsrc/second.ts\n"],
		]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 4);
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 6);

		await mounted.handlers.get("message_end")({ message: { role: "assistant" } }, mounted.ctx);
		assert.equal(git.calls.length, 6);
		git.resolveRound(new Map([
			["status --porcelain", " M src/third.ts\n"],
			["diff HEAD --numstat", "3\t1\tsrc/third.ts\n"],
		]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 6);
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 8);

		git.resolveRound(new Map([
			["status --porcelain", " M src/fourth.ts\n"],
			["diff HEAD --numstat", "4\t1\tsrc/fourth.ts\n"],
		]));
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		git.restore();
		t.mock.timers.reset();
	}
});

test("a queued refresh discards the older result", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const git = stubDeferredGit();
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		mounted.refreshBranch();

		git.resolveRound(new Map([
			["status --porcelain", " M src/stale.ts\n"],
			["diff HEAD --numstat", "1\t0\tsrc/stale.ts\n"],
		]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 2);
		t.mock.timers.tick(1_000);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(git.calls.length, 4);
		assert.doesNotMatch(mounted.renderer.render(120).join("\n"), /\(1\) \+1\/-0/);

		git.resolveRound(new Map([
			["status --porcelain", " M src/current.ts\n"],
			["diff HEAD --numstat", "7\t2\tsrc/current.ts\n"],
		]));
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree \(1\) \+7\/-2/);
	} finally {
		git.restore();
		t.mock.timers.reset();
	}
});

test("a failed git lookup leaves the footer renderable", async () => {
	const calls = [];
	const unhandledRejections = [];
	const onUnhandledRejection = (error) => unhandledRejections.push(error);
	const original = childProcess.execFile;
	childProcess.execFile = (file, args, options, callback) => {
		if (file === "git") calls.push({ file, args, options });
		const message = file === "git" ? "git unavailable" : "gh unavailable";
		queueMicrotask(() => callback(new Error(message), "", ""));
		return {};
	};
	syncBuiltinESMExports();
	process.on("unhandledRejection", onUnhandledRejection);
	try {
		const mounted = await mount();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.length, 2);
		assert.match(mounted.renderer.render(120).join("\n"), /feature\/worktree/);
		assert.deepEqual(unhandledRejections, []);
	} finally {
		process.off("unhandledRejection", onUnhandledRejection);
		childProcess.execFile = original;
		syncBuiltinESMExports();
	}
});

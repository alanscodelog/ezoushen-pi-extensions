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

for (const eventFirst of [true, false]) {
	test(`deadline refreshes stay serialized with ${eventFirst ? "event before timer" : "timer before event"}`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const git = stubDeferredGit();
		let mounted;
		try {
			mounted = await mount();
			git.resolveRound(new Map([
				["status --porcelain", " M initial.ts\n"],
				["diff HEAD --numstat", "1\t0\tinitial.ts\n"],
			]));
			await new Promise((resolve) => setImmediate(resolve));
			t.mock.timers.tick(100);
			await mounted.handlers.get("tool_result")({}, mounted.ctx);
			assert.equal(git.calls.length, 2);

			if (eventFirst) {
				t.mock.timers.setTime(1_000);
				await mounted.handlers.get("tool_result")({}, mounted.ctx);
				t.mock.timers.tick(0);
			} else {
				t.mock.timers.tick(900);
				await mounted.handlers.get("tool_result")({}, mounted.ctx);
			}
			assert.equal(git.calls.length, 4, "only one refresh starts at the deadline");
			git.resolveRound(new Map([
				["status --porcelain", " M deadline.ts\n"],
				["diff HEAD --numstat", "2\t0\tdeadline.ts\n"],
			]));
			await new Promise((resolve) => setImmediate(resolve));
			if (eventFirst) {
				assert.match(mounted.renderer.render(120)[0], /\(1\) \+2\/-0/);
			} else {
				assert.doesNotMatch(mounted.renderer.render(120)[0], /\(1\) \+2\/-0/);
			}
			t.mock.timers.tick(999);
			assert.equal(git.calls.length, 4, "the next interval has not elapsed");
			t.mock.timers.tick(1);
			assert.equal(git.calls.length, eventFirst ? 4 : 6, "only a newer event requires a follow-up");
			if (!eventFirst) {
				git.resolveRound(new Map([
					["status --porcelain", " M current.ts\n"],
					["diff HEAD --numstat", "9\t0\tcurrent.ts\n"],
				]));
				await new Promise((resolve) => setImmediate(resolve));
				assert.match(mounted.renderer.render(120)[0], /\(1\) \+9\/-0/);
			}
			t.mock.timers.tick(1_000);
			assert.equal(git.calls.length, eventFirst ? 4 : 6, "no unrequested refresh remains");
		} finally {
			mounted?.renderer.dispose();
			git.restore();
			t.mock.timers.reset();
		}
	});
}

for (const failedIndex of [0, 1]) {
	for (const siblingFails of [false, true]) {
		test(`a failed ${failedIndex === 0 ? "status" : "diff"} holds the refresh slot until its sibling ${siblingFails ? "times out" : "succeeds"}`, async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
			const git = stubDeferredGit();
			let mounted;
			try {
				mounted = await mount();
				assert.equal(git.calls.length, 2);
				git.calls[failedIndex].callback(new Error("git failed promptly"), "", "");
				await new Promise((resolve) => setImmediate(resolve));
				t.mock.timers.tick(1_001);
				await mounted.handlers.get("tool_result")({}, mounted.ctx);
				await mounted.handlers.get("message_end")({ message: { role: "assistant" } }, mounted.ctx);
				assert.equal(git.calls.length, 2, "pending sibling still owns the refresh slot");
				assert.match(mounted.renderer.render(120)[0], /feature\/worktree/);
				assert.doesNotMatch(mounted.renderer.render(120)[0], /\(1\) \+/);

				const error = siblingFails ? Object.assign(new Error("git timeout"), { killed: true }) : null;
				git.calls[1 - failedIndex].callback(error, "", "");
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(git.calls.length, 4, "one follow-up starts after both commands settle");
				for (const call of git.calls.slice(2)) {
					call.callback(null, call.args[0] === "status" ? " M recovered.ts\n" : "7\t2\trecovered.ts\n", "");
				}
				await new Promise((resolve) => setImmediate(resolve));
				assert.match(mounted.renderer.render(120)[0], /feature\/worktree \(1\) \+7\/-2/);
				t.mock.timers.tick(1_000);
				assert.equal(git.calls.length, 4, "failed rounds do not leave extra follow-ups");
			} finally {
				mounted?.renderer.dispose();
				git.restore();
				t.mock.timers.reset();
			}
		});
	}
}

test("a failed git pair holds the refresh slot while the PR lookup is pending", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const original = childProcess.execFile;
	const calls = [];
	childProcess.execFile = (file, args, _options, callback) => {
		calls.push({ file, args, callback });
		return {};
	};
	syncBuiltinESMExports();
	let mounted;
	try {
		mounted = await mount();
		assert.equal(calls.length, 3);
		calls[0].callback(new Error("status failed"), "", "");
		calls[1].callback(null, "", "");
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(1_001);
		await mounted.handlers.get("tool_result")({}, mounted.ctx);
		assert.equal(calls.length, 3, "the PR process still owns the refresh slot");
		calls[2].callback(null, "42", "");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.length, 6, "one follow-up starts after the PR process settles");
		for (const call of calls.slice(3)) {
			const output = call.file === "gh" ? "42" : call.args[0] === "status" ? " M recovered.ts\n" : "7\t2\trecovered.ts\n";
			call.callback(null, output, "");
		}
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(mounted.renderer.render(120)[0], /feature\/worktree \(#42\) \(1\) \+7\/-2/);
		t.mock.timers.tick(1_000);
		assert.equal(calls.length, 6);
	} finally {
		mounted?.renderer.dispose();
		childProcess.execFile = original;
		syncBuiltinESMExports();
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

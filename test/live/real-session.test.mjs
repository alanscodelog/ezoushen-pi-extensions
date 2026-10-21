// The end-to-end proof unit tests cannot give: install the four PACKED
// TARBALLS (not the working tree) into a scratch pi agent directory, run a
// real `pi --mode rpc` session against a stub OpenAI-compatible provider this
// test starts and stops itself on a free local port, and observe -- in the
// live session, not in a function call -- that the packages load in the
// documented order, resolve their settings, and act.
//
// Hermetic: no inference lane is contacted (only 127.0.0.1, an OS-assigned
// port), and this never touches `~/.pi/agent` -- `PI_CODING_AGENT_DIR` points
// pi at a fresh scratch directory for the run, removed afterwards.
//
// Slow by unit-test standards (spawns real `pi` subprocesses). Not part of
// the default `npm test` glob; run explicitly with `npm run test:live` or
// `node --experimental-strip-types --test test/live/real-session.test.mjs`.
// Requires the `pi` binary from PATH or `PI_BIN`; skips (does not fail) if
// pi cannot be found, since this drives a real external tool this package
// does not vendor.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startStubProvider } from "./stub-provider.mjs";
import { spawnPiRpc } from "./rpc-client.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES = ["prefix-stabilizer", "compaction-cache", "focus-mode"];
const PACKAGE_NAMES = {
	"prefix-stabilizer": "pi-prefix-stabilizer",
	"compaction-cache": "pi-compaction-cache",
	"focus-mode": "pi-focus-mode",
};

function resolvePiBin() {
	if (process.env.PI_BIN) return process.env.PI_BIN;
	try {
		return execFileSync("which", ["pi"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Pack all four extensions from the working tree and install the tarballs
 * (not the source directories) into a fresh `node_modules` under `agentDir`. */
function packAndInstall(agentDir) {
	const tarDir = mkdtempSync(join(tmpdir(), "pi-ext-live-tarballs-"));
	const tarballs = PACKAGES.map((pkg) => {
		const packed = JSON.parse(
			execFileSync(
				"npm",
				["pack", "--json", "--pack-destination", tarDir, join(repoRoot, "extensions", pkg)],
				{ encoding: "utf8" },
			),
		)[0];
		return join(tarDir, packed.filename);
	});
	execFileSync(
		"npm",
		["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", ...tarballs],
		{ cwd: agentDir, encoding: "utf8" },
	);
	rmSync(tarDir, { recursive: true, force: true });
}

function packagePathFor(agentDir, pkg) {
	return join(agentDir, "node_modules", PACKAGE_NAMES[pkg]);
}

/** Every environment fact a live run needs, isolated to this test: a scratch
 * agent directory, a stub provider, and no dependency on this machine's real
 * `~/.pi/agent`. */
async function setupScratchAgent(stubBaseUrl) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-ext-live-agent-"));
	packAndInstall(agentDir);

	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: "stub",
				defaultModel: "free-model",
				defaultProjectTrust: "never",
				// Small enough that three short padded turns already exceed it, so
				// `compact` has something to summarize instead of "session too small".
				compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 10 },
				// Load order is the contract under test: the stabiliser MUST precede
				// the compaction extension so it captures the already-normalised
				// payload as its `live` prefix (see both packages' READMEs).
				packages: PACKAGES.map((pkg) => packagePathFor(agentDir, pkg)),
			},
			null,
			2,
		),
	);

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					stub: {
						baseUrl: stubBaseUrl,
						api: "openai-completions",
						apiKey: "stub-key",
						compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						models: [
							{
								id: "free-model",
								name: "Free Model (stub)",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 32000,
								maxTokens: 4096,
							},
							{
								id: "metered-model",
								name: "Metered Model (stub)",
								reasoning: false,
								input: ["text"],
								cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
								contextWindow: 32000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			null,
			2,
		),
	);

	// F1's regression fixture: a settings file a session must survive, not just
	// a unit that calls resolveSettings() directly.
	writeFileSync(
		join(agentDir, "compaction-cache.json"),
		"{ this is not valid json, it is F1's regression fixture\n",
	);

	return agentDir;
}

function envFor(agentDir) {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		// The matcher this session's evidence hinges on: only free-model is
		// selected, so metered-model must decline via that named rule.
		PI_COMPACTION_CACHE_MODELS: '["stub/free-model"]',
	};
}

const RPC_ARGS = (model) => [
	"--mode",
	"rpc",
	"--provider",
	"stub",
	"--model",
	model,
	"--no-session",
	"--no-context-files",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--offline",
];

function notifyMessages(events) {
	return events
		.filter((e) => e.type === "extension_ui_request" && e.method === "notify")
		.map((e) => e.message);
}

function systemText(requestBody) {
	const first = (requestBody.messages ?? [])[0];
	return first?.role === "system" ? first.content : undefined;
}

/** A message's text content, whether it is a plain string or the
 * `[{type:"text",text:...}]` array shape. */
function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
}

const piBin = resolvePiBin();

test("packed tarballs, installed into a scratch agent directory, load and act in a real pi session", async (t) => {
	if (!piBin) {
		t.skip("pi binary not found on PATH or PI_BIN; cannot drive a real session");
		return;
	}

	const stub = await startStubProvider();
	const agentDir = await setupScratchAgent(stub.baseUrl);

	try {
		await t.test("free-model session: order, reporting, and the malformed-settings regression", async () => {
			const rpc = spawnPiRpc(piBin, RPC_ARGS("free-model"), envFor(agentDir));
			try {
				// Three real turns -- each completes despite the malformed global
				// compaction-cache.json (criterion 4), padded past compaction-cache's
				// own 40-char comparison-text floor so the later `compact` call can
				// match this conversation back into its captured `live` payload.
				await rpc.promptAndWaitIdle(
					"Say OK, and pad this message so the probe text length check passes reliably.",
					"p1",
				);
				await rpc.promptAndWaitIdle(
					"Say OK again, and pad this message so the probe text length check passes too.",
					"p2",
				);
				await rpc.promptAndWaitIdle(
					"Say OK a third time, padded once more so there is enough content to compact.",
					"p3",
				);

				// Criterion 1 (part 1): all three command-registering packages loaded
				// from the tarball install (not the source tree), with no load errors.
				// (prefix-stabilizer registers no command; its load is proven below by
				// its observable effect on the wire.)
				rpc.send({ id: "cmds", type: "get_commands" });
				const cmdsResponse = await rpc.waitFor((e) => e.id === "cmds" && e.type === "response");
				const commandsByName = Object.fromEntries(
					cmdsResponse.data.commands.map((c) => [c.name, c]),
				);
				for (const [cmd, pkg] of [
					["compaction-cache-status", "compaction-cache"],
					["exstats", "focus-mode"],
				]) {
					assert.ok(commandsByName[cmd], `missing command: ${cmd}`);
					assert.equal(
						commandsByName[cmd].sourceInfo?.path,
						join(packagePathFor(agentDir, pkg), `${pkg}.js`),
						`${cmd} did not load from its tarball install`,
					);
				}
				assert.equal(
					rpc.events.filter((e) => e.type === "extension_error").length,
					0,
					"an installed package failed to load",
				);

				// Criterion 4: the malformed global settings file degraded to
				// documented defaults and announced the parse failure exactly once,
				// in the session -- and every turn above still completed.
				const settingsWarnings = notifyMessages(rpc.events).filter((m) =>
					m.includes("compaction-cache.json"),
				);
				assert.equal(settingsWarnings.length, 1, "malformed-settings notice must appear exactly once");
				assert.match(settingsWarnings[0], /could not parse.*using defaults/);

				// Criterion 2: the reporting command names the matcher as the
				// deciding rule and each setting's provenance.
				rpc.send({ id: "status", type: "prompt", message: "/compaction-cache-status" });
				await rpc.waitFor((e) => e.id === "status" && e.type === "response");
				const statusMessages = notifyMessages(rpc.events).filter((m) =>
					m.startsWith("compaction-cache:"),
				);
				const statusText = statusMessages.at(-1);
				assert.match(statusText, /^compaction-cache: active for stub\/free-model/);
				assert.match(statusText, /rule: models matcher \(stub\/free-model\)/);
				assert.match(statusText, /models = \["stub\/free-model"\] \(environment: PI_COMPACTION_CACHE_MODELS\)/);
				assert.match(statusText, /enabled = true \(default\)/);

				// Criterion 1 (part 2): trigger compaction and prove the stabiliser
				// ran BEFORE the compaction extension captured its `live` prefix --
				// observed on the wire, in a real session, not by calling both
				// extensions' functions directly.
				rpc.send({ id: "c1", type: "compact" });
				await rpc.waitFor((e) => e.type === "compaction_end");

				const liveRequest = stub.requests.find(
					(r) => Array.isArray(r.body.tools) && r.body.tools.length > 0 && systemText(r.body),
				);
				const rewriteRequest = stub.requests.find(
					(r) =>
						Array.isArray(r.body.tools) &&
						r.body.tools.length > 0 &&
						(r.body.messages ?? []).some((m) => /structured context checkpoint/i.test(messageText(m.content))),
				);
				assert.ok(liveRequest, "no ordinary agent request was captured");
				assert.ok(rewriteRequest, "compaction-cache did not send its prefix-preserving rewrite");

				const liveSystem = systemText(liveRequest.body);
				const rewriteSystem = systemText(rewriteRequest.body);
				assert.equal(
					liveSystem,
					rewriteSystem,
					"compaction's rewritten request must reuse the stabiliser-normalised system prompt byte-for-byte",
				);
				// Default stablePath is ~/.pi/pi-home: prefix-stabilizer replaced the
				// real npm install path with it before compaction-cache ever saw the
				// payload -- proof the stabiliser ran first.
				assert.match(liveSystem, /\/\.pi\/pi-home\/docs/);
				assert.ok(
					!liveSystem.includes("node_modules/@earendil-works/pi-coding-agent"),
					"the real install path leaked through unnormalised",
				);
			} finally {
				await rpc.stop();
			}
		});

		await t.test("metered-model session: the decline is announced once, not once per request", async () => {
			const rpc = spawnPiRpc(piBin, RPC_ARGS("metered-model"), envFor(agentDir));
			try {
				await rpc.promptAndWaitIdle("Say OK, padded so the probe text length check passes.", "p1");
				await rpc.promptAndWaitIdle("Say OK again, padded so the probe text length check passes.", "p2");
				await rpc.promptAndWaitIdle("Say OK a third time, padded so there is enough content.", "p3");

				rpc.send({ id: "c1", type: "compact" });
				await rpc.waitFor((e) => e.type === "compaction_end");
				await rpc.promptAndWaitIdle("One more turn before a second compaction attempt.", "p4");
				rpc.send({ id: "c2", type: "compact" });
				await rpc.waitFor(
					(e) => e.type === "compaction_end" && rpc.events.filter((x) => x.type === "compaction_end").length >= 2,
				);

				const declineMessages = notifyMessages(rpc.events).filter((m) =>
					m.includes("stub/metered-model does not match any configured model pattern"),
				);
				assert.equal(
					declineMessages.length,
					1,
					"the decline must be announced exactly once across both compaction attempts, not once per request",
				);
				assert.match(declineMessages[0], /^compaction-cache inactive:/);
			} finally {
				await rpc.stop();
			}
		});

	} finally {
		await stub.close();
		rmSync(agentDir, { recursive: true, force: true });
	}
});

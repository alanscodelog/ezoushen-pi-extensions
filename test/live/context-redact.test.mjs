// The measured guarantee: install the packed tarball, run a real `pi --mode rpc`
// session against a stub OpenAI-compatible provider, and scan the session file
// afterwards. Unit tests prove each hook; this proves the carriers together, in
// the order a secret actually travels.
//
// Hermetic: only 127.0.0.1, an OS-assigned port, and a scratch agent directory.
// Skipped (not failed) when no `pi` binary is available.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnPiRpc } from "./rpc-client.mjs";
import { startStubProvider } from "./stub-provider.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANARY = "sk_" + "live_51H8xYzA2bC3dE4fG5hJ6kL7m";
const PLACEHOLDER = /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/;

function resolvePiBin() {
	if (process.env.PI_BIN) return process.env.PI_BIN;
	try {
		return execFileSync("which", ["pi"], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function setupAgent(baseUrl) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-redact-live-"));
	const tarDir = mkdtempSync(join(tmpdir(), "pi-context-redact-live-pack-"));
	const packed = JSON.parse(
		execFileSync("npm", ["pack", "--json", "--pack-destination", tarDir, join(repoRoot, "extensions", "context-redact")], {
			encoding: "utf8",
		}),
	)[0];
	execFileSync(
		"npm",
		["install", "--prefix", agentDir, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(tarDir, packed.filename)],
		{ encoding: "utf8" },
	);
	rmSync(tarDir, { recursive: true, force: true });

	mkdirSync(join(agentDir, "extensions"));
	const installed = join(agentDir, "node_modules", "pi-context-redact");
	symlinkSync(installed, join(agentDir, "extensions", "pi-context-redact"));

	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: "stub",
				defaultModel: "free-model",
				defaultProjectTrust: "never",
				packages: [installed],
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
						baseUrl: baseUrl,
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
						],
					},
				},
			},
			null,
			2,
		),
	);

	return { agentDir, secretFile: join(agentDir, "secret.txt"), writtenFile: join(agentDir, "env.sh") };
}

function envFor(agentDir) {
	return { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CONTEXT_REDACT_ENABLED: "true" };
}

function findSessionFile(agentDir) {
	const sessions = join(agentDir, "sessions");
	if (!existsSync(sessions)) return undefined;
	const files = readdirSync(sessions, { recursive: true })
		.filter((file) => typeof file === "string" && file.endsWith(".jsonl"))
		.map((file) => join(sessions, file));
	return files.sort().at(-1);
}

function sessionEntries(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("a stubbed session leaves no canary in model-facing rows; the disk and the ! residual are reported honestly", { timeout: 180_000 }, async (t) => {
	const piBin = resolvePiBin();
	if (!piBin) {
		t.skip("pi binary not found; set PI_BIN to run the live measurement");
		return;
	}

	let toolCallTurn = 0;
	let placeholderSeen;
	let secretPath = "";
	let writtenPath = "";
	const provider = await startStubProvider((request, requestNumber) => {
		const body = JSON.stringify(request.messages ?? []);
		const placeholder = body.match(PLACEHOLDER)?.[0];
		if (placeholder) placeholderSeen = placeholder;

		if (requestNumber === 1) {
			toolCallTurn += 1;
			return {
				finishReason: "tool_calls",
				steps: [
					{
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_read",
									type: "function",
									function: { name: "read", arguments: JSON.stringify({ path: secretPath }) },
								},
							],
						},
					},
				],
			};
		}
		if (requestNumber === 2) {
			toolCallTurn += 1;
			return {
				finishReason: "tool_calls",
				steps: [
					{
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_write",
									type: "function",
									function: {
										name: "write",
										arguments: JSON.stringify({ path: writtenPath, content: `STRIPE_KEY=${placeholder ?? "[missing]"}` }),
									},
								},
							],
						},
					},
				],
			};
		}
		// Final reply deliberately restates the raw canary, as a model that never
		// saw it redacted could not, to exercise the reply carrier.
		return { steps: [{ delta: { role: "assistant", content: `Deploy key is ${CANARY}` } }], finishReason: "stop" };
	});

	const { agentDir, secretFile, writtenFile } = setupAgent(provider.baseUrl);
	secretPath = secretFile;
	writtenPath = writtenFile;
	writeFileSync(secretFile, `STRIPE_KEY=${CANARY}\n`);

	const run = spawnPiRpc(piBin, ["--mode", "rpc"], envFor(agentDir));
	try {
		await run.promptAndWaitIdle(`Please deploy the key in ${secretFile}`, "req-1");
		run.send({ id: "bash-1", type: "bash", command: `printf %s '${CANARY}' | wc -c` });
		await run.waitFor((event) => event.id === "bash-1" && event.type === "response", 20_000);
	} finally {
		await run.stop();
		await provider.close();
	}

	try {
		assert.ok(toolCallTurn >= 1, "the stub provider never received a tool turn");
		assert.ok(placeholderSeen, "no placeholder reached the provider");

		const sessionFile = findSessionFile(agentDir);
		assert.ok(sessionFile, "no session file was written");

		const entries = sessionEntries(sessionFile);
		const rowKinds = [];
		let modelFacingCanaries = 0;
		let toolResultCanaries = 0;
		let residual = [];
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const message = entry.message ?? {};
			if (message.role === "bashExecution") {
				const text = JSON.stringify(message);
				if (text.includes(CANARY)) residual.push("bashExecution");
				continue;
			}
			rowKinds.push(message.role);
			const text = JSON.stringify(message);
			if (!text.includes(CANARY)) continue;
			if (message.role === "toolResult") toolResultCanaries += 1;
			else modelFacingCanaries += 1;
		}

		console.log(`context-redact session: ${entries.length} entries, roles ${[...new Set(rowKinds)].join(",")}`);
		console.log(`model-facing canary occurrences: ${modelFacingCanaries} (must be 0)`);
		console.log(`toolResult canary occurrences: ${toolResultCanaries} (must be 0)`);
		console.log(`residual (not hook-reachable): ${residual.length} bashExecution row(s)`);

		assert.equal(modelFacingCanaries, 0);
		assert.equal(toolResultCanaries, 0);
		assert.ok(placeholderSeen, "the stored rows should carry a placeholder");

		// The write path materialises the real value on disk, which is the one
		// channel restoration is scoped to.
		assert.ok(existsSync(writtenFile), "the write tool call did not run");
		assert.match(readFileSync(writtenFile, "utf8"), new RegExp(CANARY), "the written file lacks the real value");

		// The literal secret typed after `!` is the documented residual: Pi stores
		// that command without a rewriting hook. Report it; never claim clean.
		assert.ok(residual.length > 0, "expected the documented ! residual to be reported");
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

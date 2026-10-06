import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(packageRoot, "quick-cancel.ts"), "utf8");

const checks = [
	["absolute path", /(["'`])\/(?!\/)[^"'`\n]+\1/g],
	["home directory", /(?:~\/|\$HOME\b|\$\{HOME\}|\bhomedir\s*\(|\bprocess\.env\.HOME\b)/g],
	["host", /(?:https?|wss?):\/\/[^\s"'`]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b|\bhost(?:name)?\b\s*[:=]\s*(["'`])[^"'`]+\1/gi],
	["port", /\bport\b\s*[:=]\s*(?:\d{2,5}|["'`]\d{2,5}["'`])/gi],
];

test("source has zero unexplained machine-specific literals", () => {
	const hits = checks.flatMap(([category, pattern]) =>
		[...source.matchAll(pattern)]
			.map((match) => ({ category, value: match[0].trim() })));

	assert.deepEqual(hits, []);
	console.log("CLEAN SWEEP: 0 unexplained paths, home references, hosts, or ports");
});

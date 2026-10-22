import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repoRoot, "extensions", "context-redact");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const entry = join(packageRoot, manifest.pi.extensions[0]);

const EXPECTED_FILES = [
	"LICENSE",
	"README.md",
	"RULES.md",
	"context-redact.js",
	"package.json",
	"skills/redacted-values/SKILL.md",
	"vendor/GITLEAKS-LICENSE",
].sort();

test("manifest exposes pi-context-redact as a public pi package with Pi core as peer", () => {
	assert.equal(manifest.name, "pi-context-redact");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.publishConfig.access, "public");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies.typebox, undefined);
	assert.equal(
		Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@earendil-works/")).length,
		0,
	);
});

test("the bundled entry imports nothing outside the package", () => {
	const source = readFileSync(entry, "utf8");
	const specifiers = [...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/g)].map((match) => match[2]);
	const escaping = specifiers
		.filter((specifier) => specifier.startsWith("."))
		.filter((specifier) => {
			const destination = resolve(dirname(entry), specifier);
			const fromPackage = relative(packageRoot, destination);
			return fromPackage === ".." || fromPackage.startsWith(`..${sep}`);
		});
	assert.deepEqual(escaping, []);
});

test("the packed tarball ships exactly the declared files, installs, and loads in pi", async () => {
	const temp = mkdtempSync(join(tmpdir(), "pi-context-redact-pack-"));
	try {
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--pack-destination", temp, packageRoot], { encoding: "utf8" }),
		)[0];
		assert.deepEqual(packed.files.map((file) => file.path).sort(), EXPECTED_FILES);

		const agentDir = join(temp, "agent");
		const tarball = join(temp, packed.filename);
		execFileSync(
			"npm",
			["install", "--prefix", agentDir, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball],
			{ encoding: "utf8" },
		);

		const installed = join(agentDir, "node_modules", manifest.name);
		const extensionsDir = join(agentDir, "extensions");
		mkdirSync(extensionsDir);
		symlinkSync(installed, join(extensionsDir, manifest.name));

		const piRoot = realpathSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"));
		const loader = await import(pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href);
		const { extensions, errors } = await loader.discoverAndLoadExtensions([], repoRoot, agentDir);

		assert.deepEqual(errors, [], `loader reported errors: ${JSON.stringify(errors)}`);
		assert.equal(extensions.length, 1);
		assert.equal(realpathSync(extensions[0].path), realpathSync(join(installed, "context-redact.js")));
		for (const event of ["input", "tool_result", "message_end", "context_with_system", "tool_call"]) {
			assert.ok(extensions[0].handlers.has(event), `missing handler for ${event}`);
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("the README states the contract, the settings, the unmet path and the honest limits", () => {
	const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
	assert.match(readme, /^## External contract$/m);
	assert.match(readme, /^## Settings$/m);
	assert.match(readme, /^## If the contract is unmet$/m);
	assert.match(readme, /^## Known limitations$/m);
	for (const required of [
		"no network, no subprocess, no model call",
		"set -a; . ./.env; set +a",
		"Do not ask the user to paste",
		"protects the transcript and the model, never the disk",
		"! command",
	]) {
		assert.ok(readme.includes(required), `README is missing: ${required}`);
	}
});

test("the repository README lists the package and its install command", () => {
	const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
	assert.match(readme, /`pi-context-redact`/);
	assert.match(readme, /pi install npm:pi-context-redact/);
	assert.match(readme, /Nine extensions/);
});

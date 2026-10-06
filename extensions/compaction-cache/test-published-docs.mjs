import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoots = readdirSync(join(repoRoot, "extensions"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(repoRoot, "extensions", entry.name));

const forbiddenIdentifiers = [
	["machine absolute path", /\/Users\/[A-Za-z0-9._-]+\//i],
	["model name", /deepseek-v4\.1-flash/i],
	["serving host", /\b(?:dgx|gx10)\b/i],
	["private repository", /\b(?:dsv41-exl3-kit|local-llm|ochre|bifrost-web|stl10n-cmp)\b/i],
	["serving fork or branch", /\b(?:miaai|branch `?optimizations`?)\b/i],
	["fork environment variable", /\b(?:VLLM_)?PREFIX_CACHE_RETENTION_INTERVAL\b/],
	["private extension or install layout", /\b(?:ext-late|pi-goal-list-loop-audit|glla)\b/i],
	["serving port", /\b(?:1235|1239|1243|1244|3456)\b/],
];

const packageRequirements = {
	"pi-compaction-cache": [
		"| `enabled` | `true` |",
		"| `models` | `[]` |",
		"| `logPath` | `\"\"` |",
		"| `debug` | `false` |",
		"| `scope` | `\"boundary\"` |",
		"| `maxWords` | `1500` |",
		"each distinct decline reason once per session",
	],
	"pi-prefix-stabilizer": [
		"| `stablePath` | `$HOME/.pi/pi-home` |",
		"| `packagePathSuffix` | `node_modules/@earendil-works/pi-coding-agent` |",
		"| `createSymlink` | `false` |",
		"| `PI_PREFIX_STABILIZER` | enabled |",
		"| `PI_PREFIX_STABILIZER_LOG` | unset |",
		"Default installation performs no filesystem writes",
	],
	"pi-cmem": [
		"| `disabled` | `false` |",
		"| `capture` | `true` |",
		"| `inject` | `false` |",
		"| `workerHost` | `\"127.0.0.1\"` |",
		"| `workerPort` | `37777` |",
		"| `project` | `\"\"` |",
		"| `fallbackPath` | `\"\"` |",
		"an unreachable worker produces one warning",
	],
	"pi-focus-mode": [
		"`processKey`, `exchangeKey`, and `pickerKey`",
		"`ctrl+alt+e`, and `ctrl+alt+s`",
		"Missing usage fields are reported as zero",
	],
	"pi-interrupt-steer": [
		"| `key` | `ctrl+alt+enter` |",
		"`PI_INTERRUPT_STEER_KEY`",
		"kitty keyboard protocol",
	],
	"pi-prompt-drafts": [
		"| `key` | `ctrl+s` |",
		"`PI_PROMPT_DRAFTS_KEY`",
		"never sent on its own",
	],
	"pi-image-thumbnails": [
		"| `cols` | `10` | `PI_IMAGE_THUMBS_COLS` |",
		"| `rows` | `4` | `PI_IMAGE_THUMBS_ROWS` |",
		"no image is attached",
	],
	"pi-quick-cancel": [
		"| `key` | `ctrl+alt+x` |",
		"`PI_QUICK_CANCEL_KEY`",
		"returns the prompt to the editor while the first response is unfinished",
	],
};

function filesUnder(root) {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

/** The actual publish surface: every file `git` tracks, not just what `files` packs. */
function gitTrackedFiles(root) {
	return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
}

/**
 * Scan a file's path AND its contents. An identifier can leak through a file or
 * directory name alone -- runtime state an extension writes into the working
 * directory is named after the extension -- and a content-only scan reports clean
 * while that path sits in the published tree.
 */
function scanFile(hits, surface, pkg, relPath, text) {
	for (const [category, pattern] of forbiddenIdentifiers) {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		for (const match of relPath.matchAll(new RegExp(pattern.source, flags))) {
			hits.push({ surface, package: pkg, file: relPath, category, value: match[0], in: "path" });
		}
		for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
			hits.push({ surface, package: pkg, file: relPath, category, value: match[0], in: "contents" });
		}
	}
}

function packAll() {
	const temp = mkdtempSync(join(tmpdir(), "pi-extensions-published-docs-"));
	const packages = [];
	for (const packageRoot of packageRoots) {
		let packed;
		try {
			packed = JSON.parse(
				execFileSync("npm", ["pack", "--json", "--pack-destination", temp, packageRoot], {
					encoding: "utf8",
				}),
			)[0];
		} catch (error) {
			throw new Error(`npm pack failed for ${packageRoot}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const archive = join(temp, packed.filename);
		const extracted = join(temp, basename(packed.filename, ".tgz"));
		execFileSync("mkdir", [extracted]);
		execFileSync("tar", ["-xzf", archive, "-C", extracted]);
		packages.push({ name: packed.name, root: join(extracted, "package") });
	}
	return { temp, packages };
}

test("packed tarballs and git-tracked source contain no private deployment identifiers", () => {
	const { temp, packages } = packAll();
	try {
		const hits = [];
		for (const packed of packages) {
			for (const path of filesUnder(packed.root)) {
				scanFile(hits, "tarball", packed.name, path.slice(packed.root.length + 1), readFileSync(path, "utf8"));
			}
		}

		// The tarball is not the actual publish surface: it ships only *.js, README
		// and LICENSE, but pi's own docs tell users to review a package's source
		// before installing it, and that source is every file `git` tracks under
		// pi-extensions/. Scan that surface too. This file's own pattern list is
		// excluded -- it names the forbidden identifiers, it does not leak them.
		const selfPath = fileURLToPath(import.meta.url);
		for (const relPath of gitTrackedFiles(repoRoot)) {
			const path = join(repoRoot, relPath);
			if (path === selfPath) continue;
			scanFile(hits, "git-tracked", "(repo)", relPath, readFileSync(path, "utf8"));
		}

		assert.deepEqual(hits, []);
		console.log(`IDENTIFIER SCAN: ${packages.length} packed tarballs + git-tracked source, 0 matches`);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("every packed package documents its contract, settings, and unmet behavior", () => {
	const { temp, packages } = packAll();
	try {
		assert.equal(packages.length, 8);
		for (const packed of packages) {
			const readme = readFileSync(join(packed.root, "README.md"), "utf8");
			assert.match(readme, /^## External contract$/m, packed.name);
			assert.match(readme, /^## Settings$/m, packed.name);
			assert.match(readme, /^## If the contract is unmet$/m, packed.name);
			for (const required of packageRequirements[packed.name]) {
				assert.ok(readme.includes(required), `${packed.name}: missing ${required}`);
			}
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("compaction documentation preserves evidence without recommending a retention value", () => {
	const readme = readFileSync(join(repoRoot, "extensions", "compaction-cache", "README.md"), "utf8");
	assert.match(readme, /superseded/i);
	assert.match(readme, /132,?000[\s\S]{0,180}144\.26s[\s\S]{0,40}0%/i);
	assert.match(readme, /0\.61s[\s\S]{0,40}99\.95%/i);
	assert.match(readme, /34%[\s\S]{0,40}0 preemptions/i);
	assert.doesNotMatch(readme, /recommend(?:ed|ation)?[^\n]{0,80}\b128\b/i);
	assert.doesNotMatch(readme, /^\*\*Why 128\./m);
	assert.match(
		readme,
		/server-side retention[\s\S]{0,180}right value is governed by eviction\s+pressure[\s\S]{0,140}reader's own deployment/i,
	);
});

test("both prefix packages state their load order", () => {
	for (const name of ["prefix-stabilizer", "compaction-cache"]) {
		const readme = readFileSync(join(repoRoot, "extensions", name, "README.md"), "utf8");
		assert.match(readme, /Load `pi-prefix-stabilizer` before `pi-compaction-cache`\./);
	}
});

test("cmem documents its license, alternative, and shared namespace", () => {
	const readme = readFileSync(join(repoRoot, "extensions", "cmem", "README.md"), "utf8");
	assert.match(readme, /claude-mem is licensed under Apache-2\.0/);
	assert.match(readme, /@husniadil\/pi-mem/);
	assert.match(readme, /does not prefix project names with `pi-`/);
	assert.match(readme, /Pi, Claude Code, and Codex share one\s+repository namespace/);
});

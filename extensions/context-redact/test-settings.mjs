import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { resolveSettings } from "../../shared/settings.ts";
import { REDACT_SETTINGS } from "./context-redact.ts";

function fixture({ global = {}, project = {}, trusted = true, environment = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-context-redact-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(agentDir, "pi-context-redact.json"), JSON.stringify(global));
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "pi-context-redact.json"), JSON.stringify(project));
	return {
		root,
		context: { cwd, isProjectTrusted: () => trusted, hasUI: false },
		runtime: { agentDir, environment },
	};
}

function resolve(setup) {
	return resolveSettings("pi-context-redact", REDACT_SETTINGS, setup.context, setup.runtime);
}

test("documented defaults apply with default provenance", () => {
	const setup = fixture();
	try {
		const resolved = resolve(setup);
		assert.equal(resolved.enabled.value, true);
		assert.equal(resolved.tier.value, "balanced");
		assert.equal(resolved.scanBudgetMs.value, 1500);
		assert.deepEqual(resolved.enabled.provenance, { source: "default" });
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("agent, trusted project and environment win in order", () => {
	const setup = fixture({
		global: { enabled: false, tier: "strict" },
		project: { tier: "precision", scanBudgetMs: 400 },
		environment: { PI_CONTEXT_REDACT_TIER: "balanced" },
	});
	try {
		const resolved = resolve(setup);
		assert.equal(resolved.enabled.value, false);
		assert.equal(resolved.enabled.provenance.source, "global");
		assert.equal(resolved.tier.value, "balanced");
		assert.deepEqual(resolved.tier.provenance, { source: "environment", name: "PI_CONTEXT_REDACT_TIER" });
		assert.equal(resolved.scanBudgetMs.value, 400);
		assert.equal(resolved.scanBudgetMs.provenance.source, "project");
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("an untrusted project file is ignored", () => {
	const setup = fixture({ project: { enabled: false, tier: "strict" }, trusted: false });
	try {
		const resolved = resolve(setup);
		assert.equal(resolved.enabled.value, true);
		assert.equal(resolved.tier.value, "balanced");
		assert.deepEqual(resolved.enabled.provenance, { source: "default" });
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

test("a malformed tier falls back to the documented default", () => {
	const setup = fixture({ environment: { PI_CONTEXT_REDACT_TIER: "aggressive" } });
	try {
		assert.equal(resolve(setup).tier.value, "balanced");
	} finally {
		rmSync(setup.root, { recursive: true, force: true });
	}
});

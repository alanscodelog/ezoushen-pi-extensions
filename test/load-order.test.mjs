import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import compactionCache from "../extensions/compaction-cache/compaction-cache.ts";
import prefixStabilizer from "../extensions/prefix-stabilizer/prefix-stabilizer.ts";

const ORDERING_MESSAGE =
  "load-order contract: pi-prefix-stabilizer must run before pi-compaction-cache";
const README_REQUIREMENT =
  "Load `pi-prefix-stabilizer` before `pi-compaction-cache` so compaction captures the normalised provider payload.";
// prefix-stabilizer only treats an absolute, existing mention as an install
// root (see extensions/prefix-stabilizer's G1 fix), so this fixture's
// "volatile install path" has to actually exist on disk.
const VOLATILE_ROOT = mkdtempSync(join(tmpdir(), "pi-load-order-volatile-"));
mkdirSync(join(VOLATILE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"), {
  recursive: true,
});
const VOLATILE_PATH = join(
  VOLATILE_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "docs",
  "extensions.md",
);
const STABLE_PATH = "/stable/pi-home";
const CONVERSATION =
  "Keep the prefix byte-identical while compacting this sufficiently long conversation.";
const FREE_MODEL = {
  id: "test-model",
  provider: "test-provider",
  maxTokens: 32768,
  contextWindow: 262144,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function loadExtensions(order) {
  return order.map(({ name, activate }) => {
    const handlers = new Map();
    activate({
      on(event, handler) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerCommand() {},
    });
    return { name, handlers };
  });
}

async function dispatchProviderRequest(extensions, payload, ctx) {
  let currentPayload = payload;
  for (const extension of extensions) {
    for (const handler of extension.handlers.get("before_provider_request") ?? []) {
      const result = await handler(
        { type: "before_provider_request", payload: currentPayload },
        ctx,
      );
      if (result !== undefined) currentPayload = result;
    }
  }
  return currentPayload;
}

function livePayload() {
  return {
    model: FREE_MODEL.id,
    tools: [{ type: "function", function: { name: "read" } }],
    messages: [
      { role: "system", content: `Read Pi documentation at ${VOLATILE_PATH}` },
      { role: "user", content: CONVERSATION },
      { role: "assistant", content: "The prefix remains stable." },
    ],
  };
}

async function capturedCompactionPayload(order) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-load-order-agent-"));
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    stablePath: process.env.PI_PREFIX_STABILIZER_STABLE_PATH,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_PREFIX_STABILIZER_STABLE_PATH = STABLE_PATH;

  try {
    const extensions = loadExtensions(order);
    const captured = [];
    const ctx = {
      cwd: agentDir,
      isProjectTrusted: () => false,
      model: FREE_MODEL,
      modelRegistry: {
        complete: async (_model, _context, options) => {
          captured.push(await options.onPayload({ model: FREE_MODEL.id, max_tokens: 4096 }));
          return {
            content: [{ type: "text", text: "## Goal\nPreserve the prefix" }],
            stopReason: "stop",
            usage: { input: 1, output: 1 },
          };
        },
      },
      ui: { notify() {} },
    };

    await dispatchProviderRequest(extensions, livePayload(), ctx);
    const compaction = extensions.find(({ name }) => name === "pi-compaction-cache");
    const handler = compaction.handlers.get("session_before_compact")[0];
    await handler(
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-1",
          tokensBefore: 100,
          messagesToSummarize: [
            { role: "user", content: [{ type: "text", text: CONVERSATION }] },
          ],
          turnPrefixMessages: [],
          isSplitTurn: false,
          fileOps: { read: new Set(), edited: new Set(), written: new Set() },
          settings: { reserveTokens: 16384 },
        },
        reason: "manual",
        signal: undefined,
      },
      ctx,
    );
    assert.equal(captured.length, 1, "compaction did not expose one captured payload");
    return captured[0];
  } finally {
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.stablePath === undefined) delete process.env.PI_PREFIX_STABILIZER_STABLE_PATH;
    else process.env.PI_PREFIX_STABILIZER_STABLE_PATH = previous.stablePath;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function assertOrderingContract(payload) {
  const system = payload.messages.find(({ role }) => role === "system")?.content;
  assert.ok(String(system).includes(`${STABLE_PATH}/docs/extensions.md`), ORDERING_MESSAGE);
  assert.ok(!String(system).includes(VOLATILE_PATH), ORDERING_MESSAGE);
}

const STABILIZER_THEN_COMPACTION = [
  { name: "pi-prefix-stabilizer", activate: prefixStabilizer },
  { name: "pi-compaction-cache", activate: compactionCache },
];

test("compaction captures the normalised payload in the documented order", async () => {
  const captured = await capturedCompactionPayload(STABILIZER_THEN_COMPACTION);
  assertOrderingContract(captured);
});

test("the ordering check detects the reversed extension order", async () => {
  const captured = await capturedCompactionPayload([...STABILIZER_THEN_COMPACTION].reverse());
  assert.throws(
    () => assertOrderingContract(captured),
    new RegExp(ORDERING_MESSAGE),
  );
});

const readmes = [
  join(import.meta.dirname, "..", "extensions", "prefix-stabilizer", "README.md"),
  join(import.meta.dirname, "..", "extensions", "compaction-cache", "README.md"),
];// Both halves of the requirement, matched on substance rather than on one verbatim
// sentence: the directive naming the two packages in order, and the reason it matters.
// Asserting an exact sentence made this skip even once both READMEs said the right
// thing in their own words, which is a false negative on the criterion it guards.
const ORDER_DIRECTIVE = README_REQUIREMENT.slice(0, README_REQUIREMENT.indexOf(" so "));
const NORMALISE_BEFORE_CAPTURE = /normali[sz]e[^.]*before[^.]*captur/is;

test("both package READMEs state the ordering requirement", () => {
  for (const path of readmes) {
    assert.ok(existsSync(path), `missing README: ${path}`);
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes(ORDER_DIRECTIVE), `${path} does not state: ${ORDER_DIRECTIVE}`);
    assert.match(text, NORMALISE_BEFORE_CAPTURE, path);
  }
});

const repoRoot = join(import.meta.dirname, "..");
const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// `pi install git:github.com/ezoushen/pi-extensions` installs the repository as one
// package, and a git checkout has no built .js files, so the root manifest points at
// the TypeScript sources. Its order is the load order, which keeps the cache contract.
test("the repository root package declares every extension source in load order", () => {
  const declared = rootManifest.pi.extensions.map((entry) => ({ entry, path: resolve(repoRoot, entry) }));
  assert.deepEqual(
    declared.map(({ entry }) => entry),
    [
      "./extensions/prefix-stabilizer/prefix-stabilizer.ts",
      "./extensions/compaction-cache/compaction-cache.ts",
      "./extensions/focus-mode/focus-mode.ts",
      "./extensions/interrupt-steer/interrupt-steer.ts",
      "./extensions/quick-cancel/quick-cancel.ts",
      "./extensions/prompt-drafts/prompt-drafts.ts",
      "./extensions/image-thumbnails/image-thumbnails.ts",
      "./extensions/context-redact/context-redact.ts",
      "./extensions/footer/footer.ts",
    ],
  );
  for (const { entry, path } of declared) {
    assert.ok(existsSync(path), `manifest entry has no source on disk: ${entry}`);
  }
  const position = (packageName) => declared.findIndex(({ entry }) => entry.includes(`/${packageName}/`));
  assert.ok(position("prefix-stabilizer") < position("compaction-cache"), ORDERING_MESSAGE);
});

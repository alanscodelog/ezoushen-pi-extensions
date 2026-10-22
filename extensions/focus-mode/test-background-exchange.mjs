import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { registerExchangeStats } from "./focus-mode.ts";
import { ToolFoldModel } from "./src/tool-fold.ts";

initTheme("dark");

// Pi fires before_agent_start only for a submitted prompt. A run started by an extension
// message (a background-task notification) begins at agent_start, and its response must
// still end with an exchange card.
function mount() {
	const handlers = new Map(), entries = [], commands = new Map();
	registerExchangeStats({
		on: (name, handler) => handlers.set(name, handler),
		registerShortcut() {}, registerCommand: (name, value) => commands.set(name, value.handler), registerEntryRenderer() {},
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	}, ToolExecutionComponent, { agentDir: "/nonexistent", environment: {} });
	const ctx = { hasUI: true, cwd: "/nonexistent", model: { id: "test" }, isProjectTrusted: () => false,
		sessionManager: { getBranch: () => entries }, ui: { setStatus() {}, notify() {} } };
	handlers.get("session_start")({}, ctx);
	const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
	const answer = (timestamp, usage) => {
		const message = { role: "assistant", timestamp, content: [{ type: "text", text: "done" }], stopReason: "stop", usage };
		fire("turn_start", { turnIndex: 1 });
		fire("message_update", { message, assistantMessageEvent: { type: "text_delta" } });
		fire("message_end", { message });
		fire("turn_end", { message });
	};
	const cards = () => entries.filter((entry) => entry.customType === "exchange-stats").map((entry) => entry.data);
	return { fire, answer, cards, sessionstats: () => commands.get("sessionstats")("", ctx), close: () => handlers.get("session_shutdown")() };
}

const usage = (input, output, cost) => ({ input, output, reasoning: 0, cacheRead: 100, cacheWrite: 0, totalTokens: input + output + 100, cost: { total: cost } });

test("a run started by an extension message ends with its own exchange card", () => {
	const m = mount();
	try {
		m.fire("agent_start");
		m.answer(100, usage(10, 5, 0.01));
		m.fire("agent_end");
		m.fire("agent_settled");
		const [card] = m.cards();
		assert.ok(card, "the background-triggered run left no exchange card");
		assert.equal(card.turnCount, 1);
		assert.equal(card.input, 10);
		assert.equal(card.output, 5);
		assert.equal(card.cost, 0.01);
	} finally { m.close(); }
});

test("a mid-run steer keeps one card but starts a new fold segment", () => {
	const m = mount();
	try {
		m.fire("before_agent_start");
		m.answer(100, usage(10, 5, 0.01));
		// The steer arrives while the run is still open.
		m.fire("before_agent_start");
		m.answer(200, usage(4, 2, 0.01));
		m.fire("agent_end");
		m.fire("agent_settled");
		assert.equal(m.cards().length, 1, "a steer split the exchange card");
		assert.equal(m.cards()[0].promptCount, 2, "the card no longer counts both prompts");
	} finally { m.close(); }
});

test("beginSegment closes the fold tree at a mid-run prompt boundary", () => {
	const model = new ToolFoldModel(() => 0);
	model.beginExchange(1);
	model.ingest({ timestamp: 1, content: [
		{ type: "thinking", thinking: "first" },
		{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
		{ type: "text", text: "answer one" },
	] });
	model.endExchange(100);
	model.beginSegment();
	model.ingest({ timestamp: 2, content: [
		{ type: "thinking", thinking: "second" },
		{ type: "toolCall", id: "t2", name: "bash", arguments: {} },
		{ type: "text", text: "answer two" },
	] });
	model.endExchange(100);
	assert.match(model.progressLine(1), /Worked for/);
	assert.match(model.progressLine(1.5), /Worked for/, "the segment after the steer has no progress line");
	assert.equal(model.progressLine(1.5)?.includes("Worked for"), true);
});

test("a submitted prompt still makes exactly one card", () => {
	const m = mount();
	try {
		m.fire("before_agent_start");
		m.fire("agent_start");
		m.answer(100, usage(10, 5, 0.01));
		m.fire("agent_end");
		m.fire("agent_settled");
		assert.equal(m.cards().length, 1);
		assert.equal(m.cards()[0].promptCount, 1);
	} finally { m.close(); }
});

test("typed and background runs get separate, consecutive cards", () => {
	const m = mount();
	try {
		m.fire("before_agent_start");
		m.fire("agent_start");
		m.answer(100, usage(10, 5, 0.01));
		m.fire("agent_end");
		m.fire("agent_settled");
		m.fire("agent_start");
		m.answer(200, usage(20, 7, 0.02));
		m.fire("agent_end");
		m.fire("agent_settled");
		const cards = m.cards();
		assert.deepEqual(cards.map((card) => card.index), [1, 2]);
		assert.deepEqual(cards.map((card) => card.input), [10, 20]);
	} finally { m.close(); }
});

test("an exchange record and the session card carry the model time of its turns", () => {
	const m = mount();
	try {
		m.fire("agent_start");
		m.answer(100, usage(10, 5, 0.01));
		m.fire("agent_end");
		m.fire("agent_settled");
		const [card] = m.cards();
		assert.equal(card.modelMs, card.turns.reduce((sum, turn) => sum + turn.modelMs, 0));
		m.sessionstats();
		const session = m.cards().find((entry) => entry.kind === "session");
		assert.equal(session.modelMs, card.modelMs);
	} finally { m.close(); }
});

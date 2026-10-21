import assert from "node:assert/strict";
import test from "node:test";

import exchangeStats from "./focus-mode.ts";

function mount(model = { id: "pi-test-model" }) {
	const handlers = new Map();
	const entries = [];
	const statuses = [];
	let renderer;

	exchangeStats({
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerEntryRenderer(_type, entryRenderer) {
			renderer = entryRenderer;
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		registerCommand() {},
		registerShortcut() {},
	});

	const context = {
		hasUI: true,
		model,
		ui: { setStatus: (key, value) => statuses.push({ key, value }) },
	};
	return { handlers, entries, statuses, renderer: () => renderer, context };
}

const record010 = {
	kind: "exchange",
	index: 3,
	promptCount: 1,
	turnCount: 1,
	turns: [{
		index: 1,
		durationMs: 13_200,
		toolMs: 0,
		modelMs: 13_200,
		outputPerSec: 7 / 13.2,
		tools: [],
		input: 11,
		output: 7,
		reasoning: 2,
		cacheRead: 3,
		cacheWrite: 0,
		totalTokens: 18,
		cost: 0.0042,
	}],
	startedAt: Date.UTC(2026, 8, 24, 6, 18, 53),
	endedAt: Date.UTC(2026, 8, 24, 6, 32, 5),
	durationMs: 13_200,
	waitingMs: 0,
	toolMs: 0,
	model: "old-model",
	stopReason: "stop",
	input: 11,
	output: 7,
	reasoning: 2,
	cacheRead: 3,
	cacheWrite: 0,
	totalTokens: 18,
	cost: 0.0042,
};

/** One turn matching a card's own timing, so its rate comes from the card's numbers. */
const turnOf = (record) => [{ ...record010.turns[0], durationMs: record.durationMs - record.waitingMs, toolMs: record.toolMs,
	modelMs: record.durationMs - record.toolMs - record.waitingMs, output: record.output }];

function withLocalClock(now, timeZone, action) {
	const previousTimeZone = process.env.TZ;
	const previousNow = Date.now;
	process.env.TZ = timeZone;
	Date.now = () => now;
	try {
		assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, timeZone);
		action();
	} finally {
		Date.now = previousNow;
		if (previousTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = previousTimeZone;
	}
}

function renderEntry(mounted, data, width = 100) {
	const theme = {
		bg: (_name, value) => value,
		fg: (_name, value) => value,
		bold: (value) => value,
	};
	return mounted.renderer()({ type: "custom", customType: "exchange-stats", data }, { expanded: false }, theme)
		.render(width).join("\n");
}

function renderRows(mounted, data, width = 100) {
	return renderEntry(mounted, data, width).split("\n")
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
		.filter(Boolean);
}

function settleExchange(mounted, cost) {
	mounted.handlers.get("session_start")({}, mounted.context);
	mounted.handlers.get("before_agent_start")({}, mounted.context);
	mounted.handlers.get("turn_start")({ turnIndex: 1 }, mounted.context);
	mounted.handlers.get("turn_end")({
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { input: 11, output: 7, cost: { total: cost } },
		},
	}, mounted.context);
	mounted.handlers.get("agent_settled")({}, mounted.context);
	return mounted.statuses.at(-1).value;
}

test("a literal 0.1.0 exchange record renders its local finish time", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	const endedAt = record010.endedAt;
	const expectedTime = new Date(endedAt).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZone,
	});

	withLocalClock(Date.UTC(2026, 8, 24, 7), timeZone, () => {
		assert.deepEqual(renderRows(mounted, record010), ["⏱ 13.2s · " + expectedTime + " · old-model (in 11 · out 7 · 0.5 tps · cache 3 · $0.00420)"]);
	});
});

test("an exchange finished on an earlier local day includes the date", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	const endedAt = Date.UTC(2026, 8, 23, 15);
	const expectedDate = new Date(endedAt).toLocaleDateString(undefined, { dateStyle: "medium", timeZone });
	const expectedTime = new Date(endedAt).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZone,
	});

	withLocalClock(Date.UTC(2026, 8, 24, 7), timeZone, () => {
		assert.deepEqual(renderRows(mounted, { ...record010, endedAt }), ["⏱ 13.2s · " + expectedDate + " " + expectedTime + " · old-model (in 11 · out 7 · 0.5 tps · cache 3 · $0.00420)"]);
	});
});

test("old records without endedAt render and session cards keep the same one-line shape", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	withLocalClock(Date.UTC(2026, 8, 24, 7), timeZone, () => {
		const oldRecord = { ...record010 };
		delete oldRecord.endedAt;
		const exchange = renderRows(mounted, oldRecord);
		assert.deepEqual(exchange, ["⏱ 13.2s · old-model (in 11 · out 7 · 0.5 tps · cache 3 · $0.00420)"]);

		const session = renderRows(mounted, { ...record010, kind: "session", turns: [], modelMs: 13_200 });
		assert.deepEqual(session, ["📊 Session · 1 turn across 3 exchanges · old-model (in 11 · out 7 · 0.5 tps · cache 3 · $0.00420)"]);
	});
});

test("a free-model exchange card renders the requested metrics in parentheses", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	const record = {
		...record010,
		index: 1,
		promptCount: 1,
		turnCount: 3,
		durationMs: 799,
		toolMs: 150,
		waitingMs: 0,
		model: "ezoushen/ornith-1.5-35b-a3b-splash",
		input: 450,
		output: 29,
		reasoning: 45,
		cacheRead: 25_700,
		cacheWrite: 0,
		cost: 0,
		endedAt: Date.UTC(2026, 8, 24, 9, 47, 56),
	};
	record.turns = turnOf(record);

	withLocalClock(Date.UTC(2026, 8, 24, 11), timeZone, () => {
		assert.deepEqual(renderRows(mounted, record, 120), ["⏱ 799ms · 17:47:56 · ezoushen/ornith-1.5-35b-a3b-splash (in 450 · out 29 · 45 tps · cache 25.7k · $0)"]);
	});
});

test("exchange and session cards join their headline and metrics and wrap without truncation", () => {
	const mounted = mount();
	const timeZone = "Asia/Taipei";
	const record = {
		...record010,
		durationMs: 276_000,
		endedAt: Date.UTC(2026, 8, 24, 9, 20, 21),
		model: "glm-5.3-flash",
		input: 256_100,
		output: 6_200,
		cacheRead: 0,
		cacheWrite: 0,
		waitingMs: 0,
		cost: 0.0415,
	};
	record.turns = turnOf(record);
	const exchange = "⏱ 4m36s · 17:20:21 · glm-5.3-flash (in 256.1k · out 6.2k · 22 tps · $0.0415)";
	const session = "📊 Session · 8 turns across 3 exchanges · glm-5.3-flash (in 256.1k · out 6.2k · 22 tps · $0.0415)";

	withLocalClock(Date.UTC(2026, 8, 24, 10), timeZone, () => {
		assert.deepEqual(renderRows(mounted, record, 120), [exchange]);
		const wrappedExchange = renderRows(mounted, record, 60);
		assert.ok(wrappedExchange.length > 1);
		assert.equal(wrappedExchange.join(" "), exchange);

		const sessionRecord = { ...record, kind: "session", turnCount: 8, index: 3, turns: [], modelMs: 276_000 };
		assert.deepEqual(renderRows(mounted, sessionRecord, 120), [session]);
		const wrappedSession = renderRows(mounted, sessionRecord, 60);
		assert.ok(wrappedSession.length > 1);
		assert.equal(wrappedSession.join(" "), session);
	});
});

test("an exchange card puts waiting before total cost and omits folded metrics", () => {
	const mounted = mount();
	const record = {
		...record010,
		promptCount: 2,
		turnCount: 3,
		durationMs: 6_100,
		toolMs: 150,
		waitingMs: 500,
		input: 9_500,
		output: 234,
		reasoning: 45,
		cacheRead: 67_400,
		cacheWrite: 1_200,
		cost: 0.23456,
	};
	record.turns = turnOf(record);
	const rows = renderRows(mounted, record, 150);

	assert.equal(rows.length, 1);
	assert.match(rows[0], /old-model \(in 9.5k · out 234 · 43 tps · cache 67.4k \/ 1.2k written · waiting 500ms · \$0\.2346\)$/);
	for (const metric of ["in 9.5k", "out 234", "cache 67.4k", "waiting 500ms", "$0.2346"]) {
		assert.equal(rows[0].split(metric).length - 1, 1, `${metric} should appear once`);
	}
	assert.doesNotMatch(rows[0], /\b(?:turns?|prompts?|tools|thinking|total)\b/);
});

test("a session card uses the same metrics without active, turn or tool detail", () => {
	const mounted = mount();
	const record = {
		...record010,
		kind: "session",
		index: 3,
		waitingMs: 500,
		turns: [],
		modelMs: 12_700,
	};
	assert.deepEqual(renderRows(mounted, record, 140), ["📊 Session · 1 turn across 3 exchanges · old-model (in 11 · out 7 · 0.6 tps · cache 3 · waiting 500ms · $0.00420)"]);
});

test("the footer omits zero cost but keeps a positive cost", () => {
	const freeStatus = settleExchange(mount(), 0);
	const paidStatus = settleExchange(mount(), 0.0042);

	assert.doesNotMatch(freeStatus, /\$0/);
	assert.equal(paidStatus.match(/\$0\.00420/g)?.length, 1);
});

test("an exchange renders with only Pi-provided events and context", () => {
	const mounted = mount();
	mounted.handlers.get("session_start")({}, mounted.context);
	mounted.handlers.get("before_agent_start")({}, mounted.context);
	mounted.handlers.get("turn_start")({ turnIndex: 1 }, mounted.context);
	mounted.handlers.get("turn_end")(
		{
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: {
					input: 11,
					output: 7,
					reasoning: 2,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 18,
					cost: { total: 0.0042 },
				},
			},
		},
		mounted.context,
	);
	mounted.handlers.get("agent_settled")({}, mounted.context);

	assert.equal(mounted.entries.length, 1);
	assert.equal(mounted.entries[0].type, "exchange-stats");
	assert.equal(mounted.entries[0].data.output, 7);
	assert.equal(mounted.entries[0].data.cost, 0.0042);

	const rows = renderRows(mounted, mounted.entries[0].data);
	assert.equal(rows.length, 1);
	// Settled within the same millisecond: no model time, so no rate.
	assert.match(rows[0], /^⏱ .* · pi-test-model \(in 11 · out 7 · cache 3 · \$0\.00420\)$/);
	for (const expanded of [false, true]) {
		const colors = [];
		const theme = { bg: (_name, value) => value, fg: (name, value) => { colors.push(name); return value; }, bold: (value) => value };
		const lines = mounted.renderer()(mounted.entries[0], { expanded }, theme).render(100).join("\n");
		assert.match(lines, /pi-test-model \(in 11 · out 7 · cache 3 · \$0\.00420\)/);
		assert.doesNotMatch(lines, /#\s*1|expand|stop:|avg .* per turn/);
		assert.equal(colors.every((color) => color === "dim"), true);
	}
	assert.match(mounted.statuses.at(-1).value, /out 7/);
});

test("the exchange card shows the model display name, not the model id", () => {
	const mounted = mount({ id: "pi-test-model", name: "Pi Test Model" });
	mounted.handlers.get("session_start")({}, mounted.context);
	mounted.handlers.get("before_agent_start")({}, mounted.context);
	mounted.handlers.get("turn_start")({ turnIndex: 1 }, mounted.context);
	mounted.handlers.get("turn_end")(
		{
			message: {
				role: "assistant",
				stopReason: "stop",
				usage: {
					input: 11,
					output: 7,
					reasoning: 2,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 18,
					cost: { total: 0.0042 },
				},
			},
		},
		mounted.context,
	);
	mounted.handlers.get("agent_settled")({}, mounted.context);

	const rows = renderRows(mounted, mounted.entries[0].data);
	assert.match(rows[0], /\bPi Test Model \(in 11/);
	assert.doesNotMatch(rows[0], /pi-test-model/);
});

test("exchange card text rows use the theme's italic styling with their gray color", () => {
	const mounted = mount();
	const theme = {
		bg: (_name, value) => value,
		fg: (_name, value) => `\x1b[38;5;1m${value}\x1b[39m`,
		italic: (value) => `\x1b[3m${value}\x1b[23m`,
		bold: (value) => value,
	};
	const lines = mounted.renderer()({ type: "custom", customType: "exchange-stats", data: record010 }, { expanded: false }, theme)
		.render(100).filter((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
	assert.equal(lines.length, 1);
	for (const line of lines) {
		assert.match(line, /\x1b\[38;5;1m/);
		assert.match(line, /\x1b\[3m/);
	}
});

// Scan one row and mint stable placeholders.
//
// The shape of a decision, in order:
//
//   1. structural detectors (PEM, JWT, IBAN, Luhn, SSA, TOTP) -- self-proving,
//      so they are accepted without an entropy gate and win span conflicts.
//   2. the generated rule corpus, prefiltered by keyword and bounded in every
//      repetition. The captured value is the highest-entropy non-empty group,
//      because gitleaks' own rules disagree about which group holds the secret.
//   3. the allowlist, which is what lets the generic family run at a low
//      threshold: benign high-entropy shapes are named explicitly and left alone.
//   4. a context score for the generic family, the one whose precision depends
//      on surrounding words.
//
// The scan is pure: it takes text and options, returns rewritten text plus hits.
// State (salt, vault, counts) belongs to the caller, because the extension
// decides what a session keeps.
//
// Two rules shape this module:
//
//  - Fail closed. A scan that throws, overruns its wall-clock budget, or finds
//    more candidates than the ceiling throws `ScanError`; the caller withholds
//    the row. Returning a half-scrubbed row would read as a complete one, which
//    is the worst outcome a redactor can produce.
//  - Stable placeholders. The same value in the same session must yield the same
//    placeholder, or an edit to a line holding a real key stops matching the
//    file on disk.

import {
	GLOBAL_ALLOW_REGEXES,
	GLOBAL_STOPWORDS,
	RULES,
	type Rule,
} from "./rules.ts";
import { isAllowed } from "./allowlist.ts";
import { structuralHits } from "./structural.ts";

export type Tier = "strict" | "balanced" | "precision";

export type ScrubOptions = {
	/** Session salt: placeholders from another session restore nothing. */
	salt: string;
	tier: Tier;
	/** Entropy floor for the generic family. */
	minEntropy?: number;
	/** Wall-clock ceiling for one row. */
	budgetMs?: number;
	/** Candidate ceiling for one row; above it the row is withheld. */
	maxHits?: number;
	/** User patterns matched against a whole candidate value. */
	allowExtra?: readonly RegExp[];
	/** User force-redact patterns: a match here bypasses every gate. */
	deny?: readonly RegExp[];
	/** Rule ids switched off for the session. */
	disabledRules?: readonly string[];
};

export type Hit = {
	/** Placeholder label: `[REDACTED:<label>#<hash>]`. */
	label: string;
	start: number;
	end: number;
	value: string;
	/** Which detector produced it, for `/redact why`. */
	by: string;
};

export type ScrubResult = { text: string; hits: Hit[] };

export type ScanFailure = "budget" | "hits" | "detector";

/** The scan could not finish, so the row must not be used unscanned. */
export class ScanError extends Error {
	readonly failure: ScanFailure;

	constructor(failure: ScanFailure, message: string) {
		super(message);
		this.name = "ScanError";
		this.failure = failure;
	}
}

export const DEFAULT_BUDGET_MS = 1_500;
export const DEFAULT_MIN_ENTROPY = 3.2;
export const MAX_HITS = 512;
export const WITHHELD = "[redact withheld this content: the redactor failed while scanning it]";

/** Tier thresholds for the generic family's context score, in [0,1]. */
const TIER_THRESHOLD: Record<Tier, number> = {
	// A redactor's false positive costs a degraded-looking hash, not a lost task,
	// so the operating point sits far below a scanner's.
	strict: 0.15,
	balanced: 0.35,
	precision: 0.6,
};

/** Rows above this are scanned with the structural and generic families only. */
const FULL_SCAN_LIMIT = 60_000;

const GLOBAL_ALLOW = GLOBAL_ALLOW_REGEXES.map((source) => {
	try {
		return new RegExp(source, "i");
	} catch {
		return null;
	}
}).filter((re): re is RegExp => re !== null);

// --- primitives -------------------------------------------------------------

/** Shannon entropy in bits per character, over the value's own distribution. */
export function shannon(value: string): number {
	if (value.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const count of counts.values()) {
		const p = count / value.length;
		h -= p * Math.log2(p);
	}
	return h;
}

const BOOST = [
	"prod",
	"production",
	"live",
	"deploy",
	"secret",
	"token",
	"credential",
	"password",
	"private",
	"auth",
	"bearer",
	"apikey",
	"api_key",
];
const DAMP = ["example", "sample", "dummy", "fake", "fixture", "mock", "test", "docs", "readme", "placeholder", "lorem"];

/**
 * Confidence that a generic-family candidate is a real credential, in [0,1].
 *
 * Deliberately conservative in what it *suppresses*: a damping word lowers the
 * score, but the explicit allowlist is what actually lets a value through, so a
 * test fixture still gets redacted unless it is one of the named benign shapes.
 */
export function contextScore(text: string, start: number, end: number, value: string): number {
	let score = 0.45;
	const window = text.slice(Math.max(0, start - 80), Math.min(text.length, end + 40)).toLowerCase();
	for (const word of BOOST) if (window.includes(word)) score += 0.12;
	for (const word of DAMP) if (window.includes(word)) score -= 0.1;
	const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
	score += (classes - 1) * 0.08;
	if (value.length >= 32) score += 0.1;
	if (value.length >= 64) score += 0.05;
	return Math.max(0, Math.min(1, score));
}

// --- corpus -----------------------------------------------------------------

type Compiled = { rule: Rule; re: RegExp | null };

function compile(rules: readonly Rule[]): Compiled[] {
	return rules.map((rule) => {
		try {
			return { rule, re: new RegExp(rule.regex, `${rule.flags}g${rule.flags.includes("d") ? "" : "d"}`) };
		} catch {
			return { rule, re: null };
		}
	});
}

const COMPILED = compile(RULES);

/** keyword -> compiled rules, so a row only runs rules whose anchor it mentions. */
const BY_KEYWORD = new Map<string, Compiled[]>();
for (const compiled of COMPILED) {
	for (const keyword of compiled.rule.keywords) {
		const list = BY_KEYWORD.get(keyword);
		if (list) list.push(compiled);
		else BY_KEYWORD.set(keyword, [compiled]);
	}
}

const KEYWORDS = [...BY_KEYWORD.keys()];

function rulesForRow(size: number): Compiled[] {
	return size <= FULL_SCAN_LIMIT ? COMPILED : COMPILED.filter((c) => c.rule.kind !== "vendor-keyword");
}

/** Which detectors a row of this size will actually run (`/redact why`). */
export function detectorsFor(size: number): string {
	return size <= FULL_SCAN_LIMIT
		? `structural + ${RULES.length}-rule corpus + generic`
		: `structural + generic (row is ${size} chars, over the ${FULL_SCAN_LIMIT} full-scan limit)`;
}

/**
 * Pick the span to redact from one match: the highest-entropy non-empty group,
 * ties broken on length, unless the rule names its group explicitly.
 */
function chosenSpan(match: RegExpExecArray, rule: Rule): { start: number; end: number } | null {
	const indices = match.indices;
	if (!indices) return null;
	const declared = rule.secretGroup;
	if (declared !== null && declared > 0 && indices[declared]) {
		const span = indices[declared];
		return span ? { start: span[0], end: span[1] } : null;
	}
	let best: { start: number; end: number } | null = null;
	let bestScore = -1;
	let bestLength = -1;
	for (let i = 1; i < indices.length; i++) {
		const span = indices[i];
		if (!span || span[1] <= span[0]) continue;
		const value = match[0].slice(span[0] - (match.index ?? 0), span[1] - (match.index ?? 0));
		const score = shannon(value);
		const length = span[1] - span[0];
		if (score > bestScore || (score === bestScore && length > bestLength)) {
			best = { start: span[0], end: span[1] };
			bestScore = score;
			bestLength = length;
		}
	}
	if (best) return best;
	const whole = indices[0];
	return whole ? { start: whole[0], end: whole[1] } : null;
}

function fnv1a(input: string, basis: number): string {
	let h = basis >>> 0;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** 64 bits from two independent passes over `salt + value` and `value + salt`. */
function valueHash(salt: string, value: string): string {
	return fnv1a(salt + value, 0x811c9dc5) + fnv1a(value + salt, 0x7a3d1f29);
}

const PLACEHOLDER_RE = /^\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]$/;

/** True for a value that is already one of our placeholders (idempotence). */
export function isPlaceholder(value: string): boolean {
	return PLACEHOLDER_RE.test(value.trim());
}

export function placeholderFor(label: string, salt: string, value: string): string {
	return `[REDACTED:${label}#${valueHash(salt, value)}]`;
}

// --- scan -------------------------------------------------------------------

/** Self-proving evidence outranks a pattern, which outranks nothing else here. */
function rank(by: string): number {
	if (by === "deny") return 3;
	return by === "pem" || by === "jwt" || by === "luhn" || by === "iban" || by === "fica" || by === "base32" ? 2 : 1;
}

/**
 * Scan one string and return the rewritten text with every hit.
 *
 * Throws `ScanError` instead of returning partial work: a row that overruns its
 * budget or its candidate ceiling must not reach the model at all.
 */
export function scrub(text: string, options: ScrubOptions): ScrubResult {
	if (!text) return { text, hits: [] };

	const started = Date.now();
	const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
	const ceiling = options.maxHits ?? MAX_HITS;
	const threshold = TIER_THRESHOLD[options.tier];
	const minEntropy = options.minEntropy ?? DEFAULT_MIN_ENTROPY;
	const allowExtra = options.allowExtra ?? [];
	const disabled = options.disabledRules && options.disabledRules.length > 0 ? new Set(options.disabledRules) : null;
	const candidates: Hit[] = [];

	// 1. Structural: self-proving, so they bypass every gate except a disabled id
	// and the person's allowlist.
	try {
		for (const hit of structuralHits(text)) {
			if (disabled?.has(hit.by)) continue;
			if (isAllowed(hit.value, allowExtra)) continue;
			candidates.push({ ...hit });
		}
	} catch (error) {
		throw new ScanError("detector", `a detector failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (Date.now() - started > budget) {
		throw new ScanError("budget", `scan exceeded its ${budget} ms budget`);
	}

	// 1b. Force-redact patterns are detectors in their own right: a person who
	// says "always redact this" gets it even when no rule matches the value.
	const DENY_TOKEN = /[^\s"'`<>()[\]{},;]+/g;
	for (const pattern of options.deny ?? []) {
		const push = (start: number, end: number, value: string) => {
			candidates.push({ label: "USER_DENY", start, end, value, by: "deny" });
		};
		let scanner: RegExp;
		try {
			scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
		} catch {
			continue;
		}
		scanner.lastIndex = 0;
		for (;;) {
			const match = scanner.exec(text);
			if (!match) break;
			if (match[0].length === 0) {
				scanner.lastIndex += 1;
				continue;
			}
			push(match.index, match.index + match[0].length, match[0]);
		}
		// Value-anchored semantics: `^`/`$` bind to the token, so a whole-text
		// match cannot silently miss a value embedded in a URL or sentence.
		DENY_TOKEN.lastIndex = 0;
		for (;;) {
			const token = DENY_TOKEN.exec(text);
			if (!token) break;
			scanner.lastIndex = 0;
			for (;;) {
				const match = scanner.exec(token[0]);
				if (!match) break;
				if (match[0].length === 0) {
					scanner.lastIndex += 1;
					continue;
				}
				push(token.index + match.index, token.index + match.index + match[0].length, match[0]);
			}
		}
	}

	// 2. Rules, keyword-prefiltered.
	const lower = text.toLowerCase();
	const wanted = new Set<Compiled>();
	for (const keyword of KEYWORDS) {
		if (lower.includes(keyword)) {
			for (const compiled of BY_KEYWORD.get(keyword) ?? []) wanted.add(compiled);
		}
	}
	for (const compiled of rulesForRow(text.length)) {
		if (compiled.re === null) continue;
		if (disabled?.has(compiled.rule.id)) continue;
		if (compiled.rule.keywords.length > 0 && !wanted.has(compiled)) continue;
		if (Date.now() - started > budget) {
			throw new ScanError("budget", `scan exceeded its ${budget} ms budget`);
		}
		compiled.re.lastIndex = 0;
		for (;;) {
			const match = compiled.re.exec(text);
			if (!match) break;
			if (match[0].length === 0) {
				compiled.re.lastIndex += 1;
				continue;
			}
			const span = chosenSpan(match, compiled.rule);
			if (!span) continue;
			const value = text.slice(span.start, span.end);
			if (!value || isPlaceholder(value)) continue;
			if ((options.deny ?? []).some((re) => re.test(value))) {
				candidates.push({ label: compiled.rule.label, start: span.start, end: span.end, value, by: compiled.rule.id });
				continue;
			}
			if (isAllowed(value, allowExtra)) continue;
			if (GLOBAL_ALLOW.some((re) => re.test(value))) continue;
			if (GLOBAL_STOPWORDS.some((word) => value.toLowerCase() === word)) continue;
			// `minEntropy` must be able to raise a rule's own floor as well as lower
			// it: a rule carrying `entropy: 3.5` upstream does not stop being 3.5
			// because a person asked for 2.0, and asking for 4.0 must tighten it.
			const floor =
				compiled.rule.kind === "generic"
					? Math.max(compiled.rule.entropy ?? 0, minEntropy)
					: (compiled.rule.entropy ?? 0);
			if (floor > 0 && shannon(value) < floor) continue;
			if (compiled.rule.kind === "generic" && contextScore(text, span.start, span.end, value) < threshold) continue;
			candidates.push({ label: compiled.rule.label, start: span.start, end: span.end, value, by: compiled.rule.id });
		}
	}

	// 3. Resolve overlaps: self-proving first, then widest, then highest entropy.
	const ordered = candidates
		.map((hit, index) => ({ hit, index }))
		.sort((a, b) => {
			const rankDelta = rank(b.hit.by) - rank(a.hit.by);
			if (rankDelta !== 0) return rankDelta;
			const widthDelta = (b.hit.end - b.hit.start) - (a.hit.end - a.hit.start);
			if (widthDelta !== 0) return widthDelta;
			return shannon(b.hit.value) - shannon(a.hit.value);
		});

	const accepted: Hit[] = [];
	let overflowed = false;
	for (const { hit } of ordered) {
		if (accepted.some((other) => hit.start < other.end && other.start < hit.end)) continue;
		if (accepted.length >= ceiling) {
			overflowed = true;
			break;
		}
		accepted.push(hit);
	}
	if (overflowed) {
		throw new ScanError("hits", `row holds more than ${ceiling} candidates`);
	}
	if (accepted.length === 0) return { text, hits: [] };

	// 4. Replace earliest-first, rebuilding the row around each placeholder.
	accepted.sort((a, b) => a.start - b.start);
	const hits: Hit[] = [];
	let output = "";
	let cursor = 0;
	for (const hit of accepted) {
		const value = hit.value.trim();
		output += text.slice(cursor, hit.start) + placeholderFor(hit.label, options.salt, value);
		cursor = hit.end;
		hits.push({ ...hit, value });
	}
	output += text.slice(cursor);
	return { text: output, hits };
}

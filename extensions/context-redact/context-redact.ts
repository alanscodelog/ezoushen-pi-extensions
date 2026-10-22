/**
 * Pi context redaction.
 *
 * A typed secret becomes a placeholder before the model or the session file
 * sees it. Detection is local-only: no network, no subprocess, no model call --
 * a detector that transmits the value it hides would defeat itself.
 *
 * This first slice covers the prompt carrier and the structural detectors
 * (PEM blocks, JWTs, cards, SSNs, IBANs). Later slices add the rule corpus,
 * tool output, replies and injected context, restoration and guidance.
 */

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announce } from "../../shared/announce.ts";
import { resolveSettings } from "../../shared/settings.ts";
import { isPlaceholder, placeholderFor, ScanError, scrub, type Hit, type ScanFailure, type Tier, WITHHELD } from "./detection/scrub.ts";
import { RULES } from "./detection/rules.ts";

const CONFIG_NAME = "pi-context-redact";
const STATUS_KEY = "context-redact";

const SETTINGS = {
	enabled: {
		default: true,
		env: "PI_CONTEXT_REDACT_ENABLED",
		parseEnv: (value: string) => value === "true" || value === "1",
	},
	tier: {
		default: "balanced" as Tier,
		env: "PI_CONTEXT_REDACT_TIER",
		parseEnv: (value: string): Tier =>
			value === "strict" || value === "precision" || value === "balanced" ? value : "balanced",
	},
	scanBudgetMs: {
		default: 1_500,
		env: "PI_CONTEXT_REDACT_SCAN_BUDGET_MS",
		parseEnv: (value: string) => {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : 1_500;
		},
	},
	minEntropy: {
		default: 3.2,
		env: "PI_CONTEXT_REDACT_MIN_ENTROPY",
		parseEnv: (value: string) => {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : 3.2;
		},
	},
	disabledRules: {
		default: "",
		env: "PI_CONTEXT_REDACT_DISABLED_RULES",
	},
} as const;

/** Detector ids a person may switch off, beyond the generated corpus. */
const STRUCTURAL_RULE_IDS = ["pem", "jwt", "luhn", "iban", "fica", "base32", "url-userinfo", "basic-auth"] as const;
const RULE_IDS = new Set<string>([...RULES.map((rule) => rule.id), ...STRUCTURAL_RULE_IDS]);

type SessionState = {
	/** Per session, so a placeholder copied from another session restores nothing. */
	salt: string;
	/** Placeholder -> real value; only write-path tools ever read it. */
	vault: Map<string, string>;
	/** Hit counts by label. */
	counts: Map<string, number>;
	restored: number;
	withheld: number;
	/** `/redact on|off` override for this session. */
	enabled?: boolean;
	/** True until the next request has been told what a placeholder means. */
	noticeDue: boolean;
	/** Interception hooks that actually fired, for `/redact why`. */
	seen: Set<string>;
	/** Session overrides, all of which are reachable from `/redact`. */
	tier?: Tier;
	allow: RegExp[];
	deny: RegExp[];
	disabled: Set<string>;
};

function freshState(): SessionState {
	return {
		salt: randomBytes(16).toString("hex"),
		vault: new Map(),
		counts: new Map(),
		restored: 0,
		withheld: 0,
		noticeDue: false,
		seen: new Set(),
		allow: [],
		deny: [],
		disabled: new Set(),
	};
}

function report(state: SessionState, enabled: boolean, tier: Tier): string {
	const total = [...state.counts.values()].reduce((sum, count) => sum + count, 0);
	const byLabel = [...state.counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, count]) => `${label}×${count}`)
		.join(", ");
	const parts = [
		`${total} hidden${byLabel ? ` (${byLabel})` : ""}`,
		`${state.restored} restored`,
		`vault ${state.vault.size}`,
		`${state.withheld} withheld`,
		`tier ${tier}`,
		enabled ? "on" : "off",
	];
	return `context-redact: ${parts.join(" · ")}`;
}

const PLACEHOLDER_ANYWHERE = /\[REDACTED:[A-Z0-9_]+#[0-9a-f]{16}\]/g;

/** How many placeholders a tool argument tree carries (strings only). */
function placeholdersIn(value: unknown): number {
	if (typeof value === "string") return value.match(PLACEHOLDER_ANYWHERE)?.length ?? 0;
	if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + placeholdersIn(item), 0);
	if (value && typeof value === "object") {
		return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + placeholdersIn(item), 0);
	}
	return 0;
}

/**
 * Replace every placeholder the vault knows. A placeholder minted under another
 * session's salt is not in the vault and stays as it is: restoring nothing is
 * the safe outcome for a value this session never held.
 */
function rehydrateTree(value: unknown, vault: ReadonlyMap<string, string>): { value: unknown; restored: number } {
	if (typeof value === "string") {
		let restored = 0;
		const next = value.replace(PLACEHOLDER_ANYWHERE, (placeholder) => {
			const real = vault.get(placeholder);
			if (real === undefined) return placeholder;
			restored += 1;
			return real;
		});
		return { value: next, restored };
	}
	if (Array.isArray(value)) {
		let restored = 0;
		const next = value.map((item) => {
			const result = rehydrateTree(item, vault);
			restored += result.restored;
			return result.value;
		});
		return { value: next, restored };
	}
	if (value && typeof value === "object") {
		let restored = 0;
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			const result = rehydrateTree(item, vault);
			restored += result.restored;
			next[key] = result.value;
		}
		return { value: next, restored };
	}
	return { value, restored: 0 };
}

const SAFE_ROUTES =
	"Safe routes: (1) export the value in the launching shell before Pi starts (`set -a; . ./.env; set +a`) and reference it as `$NAME`; (2) run the command with `!` and that variable name; (3) write the value to a file with `write` or `edit` — placeholders in those arguments are restored — then source it. Do not ask the user to paste the secret, and do not invent a value.";

const GUIDANCE_NOTICE =
	"Redaction guard note: values in this conversation were replaced by [REDACTED:LABEL#hash] placeholders. A placeholder is not a value. Never ask the user to paste it back, never send it to a tool as if it were the secret, and never invent the missing value. " +
	SAFE_ROUTES +
	" In your reply, tell the user plainly that a credential was hidden and name the route that works; use the redacted-values skill for the full reasoning.";

export default function contextRedact(pi: ExtensionAPI): void {
	let state = freshState();
	/**
	 * Messages already scrubbed on their way into the transcript. Pi mutates the
	 * finalized message object in place, so the object identity survives; skipping
	 * these on every request keeps a long session from rescanning the whole
	 * transcript 220 rules at a time.
	 */
	const scrubbedMessages = new WeakSet<object>();

	const settingsFor = (ctx: ExtensionContext) => resolveSettings(CONFIG_NAME, SETTINGS, ctx);
	const enabledFor = (ctx: ExtensionContext) => state.enabled ?? settingsFor(ctx).enabled.value;

	const disabledFor = (ctx: ExtensionContext): string[] => {
		const configured = settingsFor(ctx).disabledRules.value.split(",").map((id) => id.trim()).filter(Boolean);
		return [...new Set([...configured, ...state.disabled])];
	};

	const scrubOptionsFor = (ctx: ExtensionContext) => {
		const settings = settingsFor(ctx);
		return {
			salt: state.salt,
			tier: state.tier ?? settings.tier.value,
			budgetMs: settings.scanBudgetMs.value,
			minEntropy: settings.minEntropy.value,
			allowExtra: state.allow,
			deny: state.deny,
			disabledRules: disabledFor(ctx),
		};
	};

	const refreshStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const total = [...state.counts.values()].reduce((sum, count) => sum + count, 0);
		ctx.ui.setStatus(STATUS_KEY, total > 0 ? `redact ${total}` : undefined);
	};

	const record = (hits: readonly Hit[]): void => {
		for (const hit of hits) {
			state.counts.set(hit.label, (state.counts.get(hit.label) ?? 0) + 1);
			// The vault key is derived the same way `scrub` wrote it, so restoration
			// matches the stored placeholder exactly.
			state.vault.set(placeholderFor(hit.label, state.salt, hit.value), hit.value);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		state = freshState();
		refreshStatus(ctx);
	});

	pi.on("input", (event, ctx) => {
		state.seen.add("input");
		try {
			// Settings resolution is inside the guard too: a handler that throws
			// lets Pi fall back to the raw text, which would send the secret it was
			// meant to hide.
			if (!enabledFor(ctx)) return undefined;
			const result = scrub(event.text, scrubOptionsFor(ctx));
			if (result.hits.length === 0) return undefined;
			record(result.hits);
			state.noticeDue = true;
			refreshStatus(ctx);
			return { action: "transform" as const, text: result.text };
		} catch (error) {
			const failure = error instanceof ScanError ? error.failure : "detector";
			state.withheld += 1;
			refreshStatus(ctx);
			announce(
				ctx,
				`context-redact withheld your prompt (${failure}): it was not sent rather than sent unscanned.`,
				"warning",
				`withheld-prompt-${failure}`,
			);
			return { action: "handled" as const };
		}
	});


/**
 * Tell the model what a placeholder means, on the turn it first sees one. The
 * note rides the system message so it is not mistaken for user content; when no
 * system message exists one is prepended.
 */
function appendGuidanceNotice(messages: MessageLike[]): void {
	const systemIndex = messages.findIndex((message) => message.role === "system");
	if (systemIndex === -1) {
		messages.unshift({ role: "system", content: GUIDANCE_NOTICE });
		return;
	}
	const system = messages[systemIndex];
	if (typeof system.content === "string") {
		messages[systemIndex] = { ...system, content: `${system.content}\n\n${GUIDANCE_NOTICE}` };
		return;
	}
	if (Array.isArray(system.content)) {
		messages[systemIndex] = {
			...system,
			content: [...system.content, { type: "text", text: GUIDANCE_NOTICE }],
		};
	}
}

/**
 * Withhold a message's scannable text while keeping every block the guard did
 * not own: dropping a `toolCall` block here would silently cancel the tools the
 * assistant asked for, which is not a safety win.
 */
function withholdMessage(message: MessageLike, failure: ScanFailure): MessageLike {
	const withheld = { type: "text" as const, text: `${WITHHELD} (${failure})` };
	const content = message.content;
	if (typeof content === "string") return { ...message, content: withheld.text };
	if (!Array.isArray(content)) return { ...message, content: [withheld] };
	const blocks = content.map((block) =>
		block?.type === "text" || block?.type === "thinking" ? withheld : block,
	);
	return { ...message, content: blocks };
}

type MessageLike = {
	role?: string;
	content?: string | Array<{ type?: string; text?: string; thinking?: string }>;
};

/**
 * Rewrite the text and thinking blocks of one message. Returns undefined when
 * nothing was redacted, so an ordinary message costs no allocation and no
 * replacement.
 */
function scrubMessageText(
	message: MessageLike,
	options: Parameters<typeof scrub>[1],
): { message: MessageLike; hits: Hit[] } | undefined {
	const content = message.content;
	if (typeof content === "string") {
		const result = scrub(content, options);
		if (result.hits.length === 0) return undefined;
		return { message: { ...message, content: result.text }, hits: result.hits };
	}
	if (!Array.isArray(content)) return undefined;

	const hits: Hit[] = [];
	const blocks = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			const result = scrub(block.text, options);
			hits.push(...result.hits);
			blocks.push(result.hits.length > 0 ? { ...block, text: result.text } : block);
		} else if (block?.type === "thinking" && typeof block.thinking === "string") {
			const result = scrub(block.thinking, options);
			hits.push(...result.hits);
			blocks.push(result.hits.length > 0 ? { ...block, thinking: result.text } : block);
		} else {
			blocks.push(block);
		}
	}
	if (hits.length === 0) return undefined;
	return { message: { ...message, content: blocks }, hits };
}

	pi.on("tool_result", (event, ctx) => {
		state.seen.add("tool_result");
		if (!enabledFor(ctx)) return undefined;

		const options = scrubOptionsFor(ctx);
		const hits: Hit[] = [];
		const content = [];
		try {
			for (const block of event.content ?? []) {
				if (block.type !== "text" || !block.text) {
					content.push(block);
					continue;
				}
				const result = scrub(block.text, options);
				hits.push(...result.hits);
				content.push(result.hits.length > 0 ? { ...block, text: result.text } : block);
			}
		} catch (error) {
			// Withhold the row whole: a partially scrubbed result would read as a
			// complete one. The tool's structured details still travel, because
			// dropping them breaks the caller for no safety gain.
			state.withheld += 1;
			refreshStatus(ctx);
			const failure = error instanceof ScanError ? error.failure : "detector";
			return {
				content: [{ type: "text" as const, text: `${WITHHELD} (${failure})` }],
				details: event.details,
				// `afterToolCall` takes usage only from the hook result, so a
				// redaction that omits it silently erases the tool's token usage.
				usage: event.usage,
			};
		}

		if (hits.length === 0) return undefined;
		record(hits);
		refreshStatus(ctx);
		return { content, details: event.details, usage: event.usage };
	});

	pi.on("message_end", (event, ctx) => {
		state.seen.add("message_end");
		if (!enabledFor(ctx)) return undefined;

		const options = scrubOptionsFor(ctx);
		try {
			const result = scrubMessageText(event.message as MessageLike, options);
			if (!result) {
				scrubbedMessages.add(event.message as object);
				return undefined;
			}
			scrubbedMessages.add(event.message as object);
			record(result.hits);
			refreshStatus(ctx);
			return { message: result.message };
		} catch (error) {
			// Fail closed: a reply that cannot be scanned must not be stored raw.
			state.withheld += 1;
			refreshStatus(ctx);
			const failure = error instanceof ScanError ? error.failure : "detector";
			return { message: withholdMessage(event.message as MessageLike, failure) };
		}
	});

	pi.on("context_with_system", (event, ctx) => {
		state.seen.add("context_with_system");
		if (!enabledFor(ctx)) return undefined;

		const options = scrubOptionsFor(ctx);
		const hits: Hit[] = [];
		const messages = [];
		let withheldHere = 0;
		for (const message of event.messages as MessageLike[]) {
			if (message && typeof message === "object" && scrubbedMessages.has(message)) {
				messages.push(message);
				continue;
			}
			try {
				const result = scrubMessageText(message, options);
				hits.push(...(result?.hits ?? []));
				messages.push(result?.message ?? message);
			} catch (error) {
				// One unscannable message is withheld visibly; the rest of the
				// request still travels, because dropping the whole transcript
				// would end the turn for a reason the model cannot see.
				withheldHere += 1;
				const failure = error instanceof ScanError ? error.failure : "detector";
				messages.push(withholdMessage(message, failure));
			}
		}
		if (hits.length > 0) record(hits);
		if (withheldHere > 0) {
			state.withheld += withheldHere;
			refreshStatus(ctx);
		}

		const noticeAdded = state.noticeDue;
		if (noticeAdded) {
			state.noticeDue = false;
			appendGuidanceNotice(messages);
		}

		if (hits.length === 0 && withheldHere === 0 && !noticeAdded) return undefined;
		return { messages };
	});

	pi.on("tool_call", (event, ctx) => {
		state.seen.add("tool_call");
		if (!enabledFor(ctx)) return undefined;

		const input = event.input as Record<string, unknown>;
		try {
			if (event.toolName === "edit" || event.toolName === "write") {
				// The one channel that gets a real value back: an edit to a line
				// holding a real key must still match the file on disk.
				const result = rehydrateTree(input, state.vault);
				if (result.restored === 0) return undefined;
				state.restored += result.restored;
				for (const key of Object.keys(input)) delete input[key];
				Object.assign(input, result.value as Record<string, unknown>);
				refreshStatus(ctx);
				return undefined;
			}

			if (placeholdersIn(input) === 0) return undefined;
			// Everything else is deliberately never rehydrated: a restored value in
			// `bash` or a fetch turns a placeholder into an exfiltration primitive.
			return { block: true, reason: `context-redact refused this ${event.toolName} call: its arguments carry [REDACTED:...] placeholders, which are not valid values. ${SAFE_ROUTES}` };
		} catch {
			// Fail closed: a guard that cannot decide must not let the call through.
			return { block: true, reason: `context-redact could not inspect this ${event.toolName} call's arguments, so it was refused. ${SAFE_ROUTES}` };
		}
	});

	pi.registerCommand("redact", {
		description: "Report, tune or disable context redaction for this session",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);
			const settings = settingsFor(ctx);
			const activeTier = state.tier ?? settings.tier.value;
			const compilePattern = (source: string): RegExp | undefined => {
				try {
					return new RegExp(source);
				} catch (error) {
					ctx.ui.notify(`/redact: invalid pattern (${error instanceof Error ? error.message : String(error)})`, "error");
					return undefined;
				}
			};

			switch (subcommand) {
				case undefined:
				case "":
					ctx.ui.notify(report(state, enabledFor(ctx), activeTier), "info");
					return;
				case "on":
					state.enabled = true;
					refreshStatus(ctx);
					ctx.ui.notify("context-redact on", "info");
					return;
				case "off":
					state.enabled = false;
					refreshStatus(ctx);
					ctx.ui.notify("context-redact off", "info");
					return;
				case "tier": {
					const value = rest[0];
					if (value !== "strict" && value !== "balanced" && value !== "precision") {
						ctx.ui.notify('/redact tier: expected strict, balanced or precision', "error");
						return;
					}
					state.tier = value;
					ctx.ui.notify(`context-redact tier ${value}`);
					return;
				}
				case "allow": {
					const source = rest.join(" ");
					if (!source) {
						ctx.ui.notify("/redact allow: a pattern is required", "error");
						return;
					}
					const pattern = compilePattern(source);
					if (!pattern) return;
					state.allow.push(pattern);
					ctx.ui.notify(`context-redact allow ${source}`);
					return;
				}
				case "deny": {
					const source = rest.join(" ");
					if (!source) {
						ctx.ui.notify("/redact deny: a pattern is required", "error");
						return;
					}
					const pattern = compilePattern(source);
					if (!pattern) return;
					state.deny.push(pattern);
					ctx.ui.notify(`context-redact deny ${source}`);
					return;
				}
				case "rule": {
					const action = rest[0];
					const id = rest[1];
					if (action === "list") {
						const off = [...state.disabled, ...disabledFor(ctx)];
						ctx.ui.notify(off.length > 0 ? `off: ${[...new Set(off)].sort().join(", ")}` : "no rules off");
						return;
					}
					if ((action !== "off" && action !== "on") || !id) {
						ctx.ui.notify("/redact rule: expected off <id>, on <id> or list", "error");
						return;
					}
					if (!RULE_IDS.has(id)) {
						ctx.ui.notify(`no such rule: ${id}`, "error");
						return;
					}
					if (action === "off") {
						state.disabled.add(id);
						ctx.ui.notify(`rule off: ${id}`);
					} else {
						state.disabled.delete(id);
						ctx.ui.notify(`rule on: ${id}`);
					}
					return;
				}
				case "why": {
					const seen = [...state.seen].sort().join(", ") || "none";
					ctx.ui.notify(
						`context-redact posture: ${enabledFor(ctx) ? "on" : "off"} · tier ${activeTier} · budget ${settings.scanBudgetMs.value} ms · entropy floor ${settings.minEntropy.value} · hooks seen: ${seen} · ${state.vault.size} in vault`,
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(`/redact: unknown subcommand "${subcommand}"`, "error");
			}
		},
	});
}

export { isPlaceholder };
export { SETTINGS as REDACT_SETTINGS };

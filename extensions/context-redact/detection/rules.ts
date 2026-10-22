// The rule corpus, as a module.
//
// `rules.generated.ts` is generated data: 220 rules with per-rule provenance,
// written by `tools/gen-rules.py` from gitleaks (MIT), never edited by hand.
// This file is the one place the engine reads "what rules exist", so a change to
// the accessor cannot hide a rule that lost its provenance.

import { RULES as GENERATED_RULES, type Rule } from "./rules.generated.ts";

export {
	CORPUS_SHA256,
	GLOBAL_ALLOW_REGEXES,
	GLOBAL_STOPWORDS,
	type Rule,
} from "./rules.generated.ts";

export { ALLOWLIST, isAllowed, type AllowEntry } from "./allowlist.ts";

export const RULES: readonly Rule[] = GENERATED_RULES;

/** The generated corpus size, for `/redact why`. */
export function ruleCount(): number {
	return GENERATED_RULES.length;
}

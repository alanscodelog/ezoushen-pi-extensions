# pi-context-redact

Replaces a typed secret with a stable placeholder before the model or the session
file sees it, and puts the real value back only where a file is written.

```
typed prompt  →  [REDACTED:RSA_PRIVATE_KEY#8f3c...]  →  model + session file
```

Requires Pi; no network, no subprocess, no model call on the detection path — a
detector that transmits the value it hides would defeat itself.

## What it does today

- **Prompts** — a typed secret becomes `[REDACTED:LABEL#hash]` before the prompt
  is queued; the session file and the model request carry the placeholder.
- **Rule corpus** — 220 rules generated from gitleaks (MIT, every repetition
  bounded, every rule carrying a provenance URL), the generic `keyword = value`
  shape with entropy and context scoring, tiers, and an allowlist that keeps git
  hashes, UUIDs, ARNs, emails, versions, digests and SSH public keys usable.
- **Structural detection** — PEM private keys (whole block), JWTs, card numbers
  (Luhn), SSNs, IBANs (mod-97), TOTP seeds, URL passwords and Basic-auth values:
  shapes that carry their own proof, so they need no entropy gate or keyword.
- **Tool output** — text from a file read, a shell result or an MCP result is
  rewritten before the model reads it and before it is stored; the tool's
  structured details still travel. `Bash` results are covered, and `Bash` never
  receives a real value back.
- **Replies and injected context** — an assistant reply that restates a secret is
  rewritten before it is stored; content Pi injects into the request (AGENTS.md,
  skill text, extension context) is scrubbed for that request even though the
  session never stores it.
- **A shipped skill** — `redacted-values` teaches the model what a placeholder is,
  how to tell you what happened, and which route works; the one-turn notice names
  it so the next reply guides you instead of stalling.
- **Restoration, and a refusal that tells you the way out** — the real value is
  restored only inside `write` and `edit` arguments, so an edit to a line holding
  a real key still matches the file on disk. Every other tool that receives a
  placeholder is refused instead of running with `[REDACTED:…]` as literal text,
  and the refusal names the safe routes. On the turn a prompt is redacted, the
  model is told what a placeholder is, not to work around it, not to ask you to
  paste the value, and which route works.
- **Fail closed** — a scan that throws or overruns its budget withholds the row
  (`/redact` reports how many) rather than sending it unscanned; a row above the
  candidate ceiling is withheld whole, never half-scrubbed.

## Commands

```
/redact            counts by label, vault size, withheld count, tier, on/off
/redact on|off     enable or disable scanning for this session
/redact why        posture: tier, budget, entropy floor, hooks that fired
/redact tier strict|balanced|precision   change the operating point
/redact allow <re> never redact values matching <re>
/redact deny <re>  always redact values matching <re>, outranking the allowlist
/redact rule off|on <id>   switch one shipped or structural detector off/on
/redact rule list  what is off, including `disabledRules` from settings
```

## External contract

- A typed secret in a prompt, in tool output, or restated in a reply reaches the
  model and the session file as `[REDACTED:LABEL#16hex]`; the real value appears
  in neither, and tool details survive the rewrite. Injected context is scrubbed
  on the way to the model.
- The same value in one session yields the same placeholder; another session's
  placeholder restores nothing.
- Detection is local-only: no network, no subprocess, no model call.
- A real value reaches only `write`/`edit`; every other tool carrying a
  placeholder is refused with the safe routes named.
- A scan that throws or overruns `scanBudgetMs` withholds the prompt (visible in
  `/redact`) instead of sending it unscanned.
- `/redact` reports counts and never a value; `/redact off` is a complete no-op.
- A rule or pattern control changes only that session: `allow`, `deny`, `rule
  off|on|list`, `tier`, with ids validated against the shipped corpus and the
  structural detectors (`no such rule` for a typo).

## Settings

Resolved in this order, later sources winning:

1. documented default
2. `<agent dir>/pi-context-redact.json`
3. `<project>/.pi/pi-context-redact.json`, only when the project is trusted
4. the environment variable

| setting | default | environment |
|---|---|---|
| `enabled` | `true` | `PI_CONTEXT_REDACT_ENABLED` |
| `tier` | `"balanced"` | `PI_CONTEXT_REDACT_TIER` |
| `scanBudgetMs` | `1500` | `PI_CONTEXT_REDACT_SCAN_BUDGET_MS` |
| `minEntropy` | `3.2` | `PI_CONTEXT_REDACT_MIN_ENTROPY` |
| `disabledRules` | `""` | `PI_CONTEXT_REDACT_DISABLED_RULES` |

## If the contract is unmet

The guard never substitutes silence for a failed scan. Check, in order:

1. `/redact` — `on`/`off` state, the withheld count, and counts by label. A
   withheld count above zero means a prompt was dropped rather than sent
   unscanned; the notice names the failure (`budget`, `hits`, `detector`).
2. The settings provenance named in `/redact` (tier and budget), and whether the
   project file was ignored because the project is untrusted.
3. If a value you expect to be hidden is not, report the miss with the value's
   shape and where it appeared; a missed shape is a detection gap, not a licence
   to disable the guard.

## Using a credential

Everything above keeps the model from holding a real value — which also means the
model cannot hand one to a command. A credential reaches the shell on one of three
paths:

1. **Export it before Pi starts.** `Bash` inherits the launching shell's
   environment; the model sees only the variable's name and runs `printf %s
   "$STRIPE_KEY" | wc -c`.
2. **`!` prefix.** A command typed with `!` runs in that same shell, so
   `!printf %s "$STRIPE_KEY" | wc -c` works without the value entering the
   conversation.
3. **Through a file an edit tool writes.** Have the model `write` the file you
   need using the placeholder (restoration happens there), then load it:
   `set -a; . ./.env; set +a`.

Three things these paths do **not** permit:

- `bash` never receives a real value. A literal secret typed into a command becomes
  a placeholder, and a call carrying a placeholder is refused.
- A credential that exists only in prompt text cannot be used by a command; it has
  to live in the environment already or be written to disk first.
- Do not ask the user to paste the value back. A pasted secret simply becomes a
  placeholder again, and the model still cannot use it.
- The file path 3 creates holds the real value in plaintext at rest. This guard
  protects the transcript and the model, never the disk: `chmod 600` the file, list
  it in `.gitignore`, and delete it when done.

## Known limitations

- A literal secret typed into a `! command` stays in the persisted bash-execution
  entry: Pi offers no rewrite hook for that carrier. It is counted and reported,
  never claimed clean.
- Detection is pattern-based. A bare prose password with no vendor shape and no
  keyword beside it can pass; a local classifier would be needed to reach it, and
  no weights ship because training would have to leave the machine.
- A placeholder minted in another session restores nothing here; a resumed older
  session shows its placeholders as text and refuses to use them.
- Scanning is bounded per row. A row that exceeds the budget or the candidate
  ceiling is withheld, so a very large file loses that row's content rather than
  sending it unscanned.

## Install

```sh
pi install npm:pi-context-redact
```

# pi-quick-cancel

Cancel a running turn, rewind the chat to before the prompt was sent, and put
the prompt back in the editor — a true unwind, so it is as if the prompt was
never submitted (except that it is waiting in the editor).

## Install

```sh
pi install npm:pi-quick-cancel
```

## What it does

The default shortcut is `ctrl+alt+x`. Pressing it while a turn is running
cancels the run (`abort()`), returns the prompt to the editor, and once the
aborted loop has settled, rewinds the session tree so the canonical chat
history ends just before the prompt: the user message and any assistant output
the run produced drop out of the context entirely — no matter how far the run
got before you pressed it.

When pi is idle there is nothing to cancel: the extension best-effort returns
whatever prompt it can to the editor, and otherwise reports "nothing to cancel".

### `/quick-cancel` — full-fidelity rewind

The shortcut rewinds the session data, but pi only rebuilds the *visible*
transcript through its tree-navigation flow, which lives on the command
context. For an immediate visual rewind (the aborted exchange disappears from
the transcript right away), run the `quick-cancel` command instead: it cancels
any in-flight run, waits for it to settle, and invokes pi's own tree
navigation — which rebuilds the transcript, restores the prompt to the editor,
and refreshes the agent context in one step. It also works while idle, to
rewind the last completed exchange.

### Why `ctrl+alt+x`

This extension registers its own shortcut that must actually fire. `escape` is
already pi's built-in interrupt, so binding this to it is **skipped by pi** — the
extension's handler would never be registered, and the shortcut would silently
do nothing. `ctrl+alt+x` avoids that: `ctrl`+`alt`+a letter is delivered as a
distinct escape sequence by terminals (so it does not collide with a free
letter, and is not stripped like `ctrl+shift+x` would be to `ctrl+x`). Bind
another key with the `key` setting if you prefer.

## External contract

One shortcut binds to the run (default `ctrl+alt+x`, or `key` /
`PI_QUICK_CANCEL_KEY`). While pi is not idle the handler calls `abort()` to stop
the turn and captures the prompt from `before_agent_start`. It restores the
prompt to the editor and, when the run settles, rewinds the session to just
before the prompt — the exchange leaves the canonical history, not just the
editor, so the next prompt is sent against the pre-prompt history.

The `quick-cancel` command performs the same rewind through pi's tree
navigation, which also rebuilds the visible transcript.

The terminal must actually send `ctrl+alt+x` for this shortcut to fire; a terminal
without the kitty keyboard protocol may send the legacy `ESC` sequence instead.

## Settings

Set `key` in `pi-quick-cancel.json` in the Pi agent settings directory, or use
`PI_QUICK_CANCEL_KEY`:

| setting | default | environment variable | purpose |
|---|---|---|---|
| `key` | `ctrl+alt+x` | `PI_QUICK_CANCEL_KEY` | Shortcut with one or more modifiers and a letter, digit, or named key. |

For example:

```json
{
  "key": "ctrl+alt+e"
}
```

## Limitations

Only the prompt **text** is returned to the editor. Any images that were
attached to the original prompt cannot be restored through the editor, so they
are not returned — re-attach them when you resend.

## If the contract is unmet

An invalid `key` falls back to `ctrl+alt+x` and warns once per session. If a key
is bound to a key pi already uses (such as `escape` or `ctrl+x`), pi skips the
extension's shortcut, so the shortcut never fires — pick a key that does not
conflict with a built-in, or use the `quick-cancel` command.

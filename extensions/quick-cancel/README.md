# pi-quick-cancel

Cancel a running turn, rewind the chat to before the prompt was sent, and put
the prompt back in the editor — a true unwind, so it is as if the prompt was
never submitted (except that it is waiting in the editor).

## Install

```sh
pi install npm:pi-quick-cancel
```

## What it does

Pressing the shortcut (or running `/quick-cancel`) does one thing, whether a
turn is running or the last one already completed: it cancels any in-flight
run, rewinds the session tree so the canonical chat history ends just before
the prompt (the user message and any assistant output drop out of the context
entirely), rebuilds the visible transcript, and puts the prompt back in the
editor. If you were typing a new prompt, that text is left untouched.

Mechanically: the shortcut dispatches the `quick-cancel` command, which waits
for the loop to settle and invokes pi's tree navigation on the prompt's
session entry — the only API surface that rebuilds the transcript.

### Why `ctrl+alt+x`

This extension registers its own shortcut that must actually fire. `escape` is
already pi's built-in interrupt, so binding this to it is **skipped by pi** — the
extension's handler would never be registered, and the shortcut would silently
do nothing. `ctrl+alt+x` avoids that: `ctrl`+`alt`+a letter is delivered as a
distinct escape sequence by terminals (so it does not collide with a free
letter, and is not stripped like `ctrl+shift+x` would be to `ctrl+x`). Bind
another key with the `key` setting if you prefer.

## External contract

One shortcut (default `ctrl+alt+x`, or `key` / `PI_QUICK_CANCEL_KEY`) and one
command (`/quick-cancel`), both driving the same rewind described above. An
invalid `key` falls back to `ctrl+alt+x` with a warning once per session.

The terminal must actually send `ctrl+alt+x` for the shortcut to fire; a
terminal without the kitty keyboard protocol may send the legacy `ESC`
sequence instead, which pi does not bind. Verified against one such runtime:
`alt+<letter>` (the classic `ESC`+letter meta form) fires fine, while
`alt+escape` arrives as an ambiguous double-`ESC` and cannot be bound at all.

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

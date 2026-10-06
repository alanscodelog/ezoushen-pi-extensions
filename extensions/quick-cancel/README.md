# pi-quick-cancel

Cancel a running turn and, while the first response is still unfinished, return
the prompt to the editor — so you never have to cancel by hand and then unwind
the transcript to recover the prompt.

## Install

```sh
pi install npm:pi-quick-cancel
```

## What it does

The default shortcut is `escape`, pi's built-in interrupt. Pressing it while a
turn is running cancels the run (the built-in interrupt does the same thing) and
then, depending on how far the run got, decides what to do with your prompt:

- **Nothing output yet, or the first response is still streaming** — the run was
  cancelled before it produced anything you would want to keep, so the extension
  returns the prompt to the editor. Edit it, resend it, or close the editor.
  No manual transcript navigation is required.
- **The first response has already fully streamed** — the prompt is already part
  of the transcript as context and there is output to preserve, so the extension
  just cancels the run and leaves the prompt where it is.

When pi is idle, there is nothing to cancel: the extension best-effort returns
whatever prompt it can to the editor, and otherwise reports "nothing to cancel".

If the first response produced no text (a still-streaming block, or a block that
ended without output), the run is treated as unfinished and the prompt is
returned. Once the first assistant block has fully ended, the prompt is treated
as finished output and only the run is cancelled.

The terminal must actually send `escape` for this shortcut to fire.

## External contract

One shortcut binds to the run (default `escape`, or `key` / `PI_QUICK_CANCEL_KEY`).
While pi is not idle the handler calls `abort()` to stop the turn and captures the
prompt from `before_agent_start`. It observes `message_start` and `message_end` to
detect when the first assistant response has fully streamed, and returns the prompt to the editor while the first response is unfinished. If that response has already
finished, the prompt already belongs to the transcript, so only the run is
cancelled and the prompt is left in the transcript.

## Settings

Set `key` in `pi-quick-cancel.json` in the Pi agent settings directory, or use
`PI_QUICK_CANCEL_KEY`:

| setting | default | environment variable | purpose |
|---|---|---|---|
| `key` | `escape` | `PI_QUICK_CANCEL_KEY` | Shortcut with one or more modifiers and a letter, digit, or named key. |

For example:

```json
{
  "key": "ctrl+shift+g"
}
```

The extension always calls `abort()` itself, so it works regardless of which
key it is bound to. Binding it to `escape` (the default) simply pairs it with
the built-in interrupt for a single-key cancel-and-return.

## Limitations

Only the prompt **text** is returned to the editor. Any images that were
attached to the original prompt cannot be restored through the editor, so they
are not returned — re-attach them when you resend.

## If the contract is unmet

An invalid `key` falls back to `escape` and warns once per session.

# pi-extensions

Seven extensions for the [pi coding agent](https://pi.dev), published from one
repository.

Two help long-running sessions reuse context. Four help you steer a run, see
what it cost, and keep a draft prompt safe. One puts images on the wire.

| package | what it does |
|---|---|
| [`pi-prefix-stabilizer`](extensions/prefix-stabilizer) | Keeps pi's system prompt byte-stable so a server's KV prefix cache survives across turns and resumes. Normalises the install path, sorts tools deterministically, and warns once when the prompt genuinely drifts. |
| [`pi-compaction-cache`](extensions/compaction-cache) | Makes `/compact` reuse that cache instead of re-prefilling the window from cold, by building the summarization request as a true prefix of the live conversation. |
| [`pi-focus-mode`](extensions/focus-mode) | Keeps the transcript focused by folding thinking and tool calls into progress lines and block titles, with exchange stats in the status line and summary card. |
| [`pi-interrupt-steer`](extensions/interrupt-steer) | Interrupts a running turn and sends the editor text as one new user message. |
| [`pi-quick-cancel`](extensions/quick-cancel) | Cancels a running turn and, while the first response is unfinished, returns the prompt to the editor. |
| [`pi-prompt-drafts`](extensions/prompt-drafts) | Ctrl+S draft queue for the prompt editor: save a draft with a keypress and get it back when your next prompt is sent, or with the same key. |
| [`pi-image-thumbnails`](extensions/image-thumbnails) | Image thumbnails for the prompt editor: pasted paths, `[Image #1]`, markdown, and `file://` URLs become real image blocks on send plus aspect-fill attachment thumbnails while you type. |

## Install

```sh
pi install npm:pi-prefix-stabilizer
pi install npm:pi-compaction-cache
pi install npm:pi-focus-mode
pi install npm:pi-interrupt-steer
pi install npm:pi-quick-cancel
pi install npm:pi-prompt-drafts
pi install npm:pi-image-thumbnails
```

Each package is independent. Install only what you want.

**One ordering rule, if you install both cache packages:** list `pi-prefix-stabilizer`
before `pi-compaction-cache` in your `packages` array. The stabiliser normalises the
provider payload, and the compaction extension captures that payload as its cache
prefix — reversed, the compaction extension captures a volatile prefix and silently
gets no cache hits at all. A repo-level test enforces this contract.

## Configuration

Every environment fact is a setting with a documented default. Nothing is hard-coded
to one machine, and nothing writes to your home directory unless you ask it to.

Settings resolve in this order, with later sources winning:

1. the package's documented default
2. the package's config file in your pi agent directory
3. the same file in `<project>/.pi/`, **only when the project is trusted**
4. the package's environment variable

Each value carries the source it came from, so a package can tell you not just what a
setting is but where it came from. See each package's README for its own settings table.

The config files are named per package — note that two of them do not follow the
package name:

| package | config file |
|---|---|
| `pi-prefix-stabilizer` | `pi-prefix-stabilizer.json` |
| `pi-compaction-cache` | `compaction-cache.json` |
| `pi-focus-mode` | `focus-mode.json` |
| `pi-interrupt-steer` | `pi-interrupt-steer.json` |
| `pi-quick-cancel` | `pi-quick-cancel.json` |
| `pi-prompt-drafts` | `pi-prompt-drafts.json` |
| `pi-image-thumbnails` | `pi-image-thumbnails.json` |

`pi-focus-mode` is the exception to step 4: its fold keys and `cursorMode` come only
from the file in your pi agent directory and their environment variables. Only
`summaryModel` also reads `<project>/.pi/focus-mode.json`, and only when the project
is trusted.

## Behaviour when something is missing

None of these six is correctness-critical, so none of them takes a session down. A
malformed settings file degrades to the documented defaults. An unreachable peer
service is reported, not fatal. Warnings are made **once** per session per distinct
reason — and when pi is running non-interactively, where there is no UI to notify,
they go to stderr instead of vanishing.

Silence is the failure mode these packages are built to avoid. If one of them decides
not to act, it says so.

## Development

```sh
npm install
npm run build     # esbuild, one bundled entry per package
npm test          # unit and contract tests
npm run test:live # drives a real pi session against the packed tarballs
```

The live suite starts its own stub provider on a local port and runs pi against a
scratch agent directory. It contacts no external service and does not touch your real
pi installation.

## Licence

MIT.

# pi-footer

A compact Pi footer showing the current directory, git branch and PR number, dirty-file counts, context usage, response speed, model display name, and other extensions' published status. Git status and PR lookups refresh in the background; the PR result, including no PR, is cached for the branch, and rendering reads cached state.

## Install

```sh
pi install npm:pi-footer
```

## Development

From this package directory, run its tests with:

```sh
node --test test/render.test.mjs
node --test test/git-status.test.mjs
node --test test/pr-lookup.test.mjs
node --test test/owner-status.test.mjs
```

## External contract

One status line, then one line per extension that publishes a status:

```
dir │ branch (#pr) (changed) +added/-deleted │ ██░░░░ 34% · 262k │ 27.4 tps │ Model
│ pi-lens · Searching the index
│ owner · Ready
```

- **Rendering never blocks the terminal.** `render()` returns strings built from cached state only. It launches no child process, so a slow `git` or `gh` cannot stall a redraw.
- **Every returned line fits the requested width.** The main line and each owner line are truncated to the width `render(width)` receives; content that does not fit is cut with `…` rather than allowed to overflow, because Pi's main-screen renderer rejects an over-width line.
- **Git and PR data arrive asynchronously.** `git status --porcelain` and `git diff HEAD --numstat` run through `execFile` with a 2500 ms timeout; `gh pr view` uses the same bound. Failures are swallowed and the footer keeps rendering its last known state.
- **Refreshes are serialized.** At most one refresh runs at a time, bursts coalesce into a single queued follow-up with a 1000 ms floor, and every request advances a generation counter so a stale result can never overwrite a newer one.
- **The PR number is cached per branch.** A "no PR" answer is remembered for that branch, so a normal refresh does not call `gh` again; only a branch change or a forced refresh re-asks.
- **Owner lines come from other extensions.** Each entry in `footerData.getExtensionStatuses()` renders as `│ label · text`, with continuation lines indented under the label. An extension that publishes nothing contributes no line.

## Settings

This package has no settings file and no configuration keys. It reads only what Pi and other extensions already expose.

## Limitations

- The footer shows whatever `footerData.getGitBranch()` reports; outside a git repository it shows the directory, context and model segments only.
- Speed is blank (`-- tps`) until the first turn has streamed enough output over enough elapsed time to compute a rate.
- A failed or unresponsive `git`/`gh` lookup keeps the last known values: previously fetched counts and PR numbers stay visible, and a segment is omitted only when no value was ever obtained. The footer itself keeps rendering throughout.
- There is no periodic refresh when nothing happens: git state updates when a turn or tool result ends, or on a branch change.

## If the contract is unmet

- **A line wider than the terminal, or a redraw that stalls:** the non-blocking guarantee is broken. Capture the session's width and the rendered line, then run `node --test test/owner-status.test.mjs` — the width suite fails if any returned line overflows.
- **Stale git data replacing newer data:** run `node --test test/git-status.test.mjs`; the coalescing and generation suites fail if two refreshes overlap or an invalidated result is published.
- **The same PR answer appearing after switching branches:** run `node --test test/pr-lookup.test.mjs`; the branch-cache suite fails if the per-branch cache is not cleared.
- **Owner lines missing or not indented:** run `node --test test/owner-status.test.mjs`.
- If the suites pass but the footer still misbehaves in a real session, the passing tests only narrow which paths were exercised: they do not show that this package is correct under every input or lifecycle (the suites drive mocked Pi contexts). Report the terminal width, the footer rows from the pane, the extension list Pi reports, and the event sequence that preceded the misbehaviour, so the cause can be located in this package or in its consumer.

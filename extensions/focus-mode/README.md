# pi-focus-mode

Show timing, token, cache, cost, and tool-use statistics for each Pi exchange.
Each run of thinking and tool calls between pieces of assistant text starts folded
as one process line, even when it spans assistant messages or turns. The line shows
thinking and tool counts as `◈ n` and `⚙ m`, plus total wall time, or the current
block and its live time while streaming. In the running exchange, a tool call that
has streamed but not yet started shows as `⚙ <tool> queued`. A call whose exchange
settled, or was restored, without a result shows `no result` in its title and no
live activity. At the next fold level, each block has a one-line title in stream order, with dim `├` and `└` guides under its process line and `│` continuing through rows with later siblings.

A mid-run follow-up (a steer) is a visual boundary: the fold tree before it closes and
the blocks after it start a fresh segment with their own progress line, while the exchange
card still counts both prompts.
While an exchange streams, assistant text stays visible. After it settles, an
exchange with a process and a trailing answer folds its processes and earlier
assistant text into one dim progress line at the first progress item. Opening that
line shows the process lines and earlier text beneath it, grouped by dim tree guides;
the trailing answer stays visible without a guide. Its `1 note` or `N notes` segment
counts interim text items and is omitted when there are none. An exchange without a
process or a trailing answer keeps its existing rows.
Tool titles show the argument, status, duration, and result line count. Thinking
titles show the trace's last complete sentence, or `Thinking` until one completes.
With `summaryModel` configured, a short model headline takes its place when ready;
the leading `≈` marks it as a summary. A failed or timed-out request returns to
the sentence fallback, on screen and in the saved entry, even after an earlier
model headline; it gives one warning per session.
The headline is shortened first to make room for duration and stats.
Titles also show elapsed time, thinking tokens and rate while streaming; a `~` marks
token estimates when the provider has not reported reasoning usage. Settled titles
show duration and word count. Opening a block keeps its title and shows Pi's native
output below it, two columns beneath its tree guide; a thinking block shows Pi's full trace
there, regardless of Pi's hide-thinking setting. Process lines, settled progress lines,
and block titles use the active Pi theme's dim color and italic style, except the line
selected by the transcript cursor, which uses the theme's accent color and stays
italic. Picker text and exchange card rows use the same dim italic style; the picker
border stays upright. Visible assistant text and opened native content keep Pi's own
styling.

Press `ctrl+alt+f` to toggle the latest process between its line and block titles.
Press `ctrl+alt+e` to toggle the latest exchange's progress line after it settles;
while it streams, the shortcut opens or folds all its processes. Press
`ctrl+alt+s` to open the picker; use Up/Down and Enter to toggle an exchange,
process, or block, and Escape to close it. The exchange row toggles settled progress
or the streaming processes. The picker marks open items; opening a block also opens
its process, while folding that block leaves the process open. These controls change
only the display. In fullscreen mode, left click a process line, progress line, or
block title to toggle it. Option+left-click a progress or process line toggles that
row and its direct children; on a block title it behaves like a plain click. A terminal
that swallows Option+click, for example to move the cursor, sends a plain click.
Hovering one of these rows brightens its text and puts it
on the theme's selection background, from the title after its tree guide to the right edge;
opened native output is not highlighted. The highlight follows the pointer across fold rows,
assistant text and the exchange card; it can stay on a row after the pointer
moves straight to Pi's own rows (a user message, the editor), until the pointer
next crosses the transcript. Terminal multiplexers that Pi runs in button-motion
mode (tmux, screen, zellij) send no hover events, so there is no highlight there.

An experimental transcript cursor is available with `cursorMode: true`. Press
`ctrl+alt+g` to enter it, Up/Down to move through progress and process lines and the
block titles of open processes, Enter to toggle the highlighted item, and Escape to
return to the editor. The selected title also appears in the status line, since
regular terminal scrollback can leave the highlighted line above the viewport.
Fullscreen Pi exposes scrolling by line, but its extension UI does not expose the
selected transcript row's position; the cursor therefore cannot scroll to it.

An **exchange** is one uninterrupted work span from a submitted prompt, or from a run
an extension message starts (a background-task notification, for example), until Pi has
nothing left to do automatically. Both kinds get the same card. A **turn** is one model response plus the tools it
invokes, so an exchange can contain several turns. The status line shows the current
or most recent exchange. Exchange and session cards are summary-only and show one
line when their content fits; at narrower widths Pi wraps the text without
truncating its numbers. The exchange line contains its duration, finish time when
the record has `endedAt`, and model, separated by `·`; its metrics follow the model
in parentheses after one space, separated by `·`. It does not include an exchange
number. The finish time uses the runtime default locale and local time zone in
24-hour `HH:MM:SS` style, with the date when that local date is not today. Records
saved by version 0.1.0 without `endedAt` omit the finish time. The session line keeps
its turn and exchange counts and follows the same model and metrics layout. Metrics
show input and output tokens, output speed as `N tps`, cache reads as `cache R` with `/ W written` when cache writes are
nonzero (or `cache W written` when there are writes but no reads), waiting time only
when nonzero, and total cost at the end even when it is `$0`. Output speed is output tokens
(thinking included) over model time, the sum of each turn's wall time less the tools it ran;
a session card sums the model time of its exchanges. It is omitted when there is no output
or no model time. Exchange entries from older versions get it from their turns; older session
cards and entries without turns did not record model time and show no rate. `cardFields` chooses which of these fields cards show (see Settings). Cards omit turns,
prompts, tools, thinking, and total-token details. Block titles carry individual
timing and count details.

Tool time is the union of tool spans, not their sum, so parallel calls are not counted
twice. Model time is estimated as turn wall time minus tool time. Output throughput is
calculated per turn, while cumulative cost and token fields use Pi's reported usage.
Run `/sessionstats` to append a cumulative session card showing totals across every exchange so far. Exchange entries retain block
durations, status, counts, and headlines outside model context. A model headline
that arrives after its exchange settles is saved in a separate, unrendered
`exchange-stats-headline` entry holding only the block id, headline and source, and
restore applies the latest one. On resume, reload,
or a branch switch, the extension rebuilds fold state from the active session
branch without sending historical thinking to the headline model. Older entries
without block statistics still show their card; their thinking titles use `—` for
unknown duration.

## External contract

Pi must emit its documented session, agent, turn, tool, and UI-prompt lifecycle events.
Display wrappers are installed at `session_start` and released at `session_shutdown`;
loading the extension without a session leaves Pi's component prototypes unchanged.
Overlapping extension instances share the wrappers until the last session releases them.
A tool row renders with the session that received its tool call id. An assistant
message renders with the session that received a message with its timestamp; when
several sessions did, with the one whose received thinking or tool calls match the
message. Sessions whose messages share a timestamp and identical content, or a
component built before any session received its message, use the latest session.
Tool folding uses Pi's `ToolExecutionComponent.render` interface from version 0.87.1.
Thinking folding uses `AssistantMessageComponent.updateContent` and Pi's
`message_update` events. Its clock starts at the first thinking delta and stops
at `thinking_end`, the first following non-thinking event, or message end,
whichever comes first. Streamed snapshots of one assistant message must retain
the same Pi message timestamp for the local clock to follow them.
Assistant messages should include usage and cost fields when the provider supports
them. Model headlines use Pi's configured provider; no separate endpoint is needed.

## If the contract is unmet

Missing usage fields are reported as zero for exchange totals; the extension does
not invent exchange token or cost data. Thinking estimates are explicitly marked
with `~`.
Missing lifecycle events produce an incomplete or absent span. When UI status is
unavailable, status updates are skipped. If custom-entry persistence is unavailable,
the live status can still update and the agent turn continues. If Pi no longer
provides the tool render interface, a single warning is shown and tool rows use
Pi's native renderer; exchange stats continue.
If Pi no longer provides the assistant content interface, a single warning is
shown and thinking uses Pi's native rendering.

The timings are measured locally, then saved in exchange entries. They do not
claim provider-side queue time, exclusive model compute time, or billing beyond
the usage object Pi received.

## Compatibility

Uninstall `pi-exchange-stats` before installing `pi-focus-mode`; both packages
must not be loaded together. The published `pi-exchange-stats@0.1.0` had no
settings or environment variables, so no settings migration is needed. Existing
sessions remain readable through their `exchange-stats` and
`exchange-stats-headline` entries. The `/sessionstats` command and `exchange` status
key stay unchanged.

## Settings

The optional `focus-mode.json` file in Pi's agent directory configures
`processKey`, `exchangeKey`, and `pickerKey`. Their defaults are `ctrl+alt+f`,
`ctrl+alt+e`, and `ctrl+alt+s`. The experimental `cursorKey` defaults to
`ctrl+alt+g`. Each key value must be a modified Pi key such as
`ctrl+alt+x` or `alt+enter`; an invalid value uses its default and produces one warning.
The matching environment variables are `PI_FOCUS_MODE_PROCESS_KEY`,
`PI_FOCUS_MODE_EXCHANGE_KEY`, `PI_FOCUS_MODE_PICKER_KEY`, and
`PI_FOCUS_MODE_CURSOR_KEY`. Set `cursorMode` to the boolean `true` in the same
file, or set `PI_FOCUS_MODE_CURSOR_MODE=true`, to register the cursor shortcut.
It is off by default. A project's `.pi/focus-mode.json` is not read for the keys
or `cursorMode`, even in a trusted project.

Set `summaryModel` to a `provider/modelId` registered in Pi's model registry.
It is off by default. Put it in `<agentDir>/focus-mode.json`, or in a trusted
project's `.pi/focus-mode.json`. For example:

```json
{ "summaryModel": "my-provider/my-headline-model" }
```

`PI_FOCUS_MODE_SUMMARY_MODEL` overrides the file setting. While thinking
streams, the extension sends at most the last 1,500 trace characters after about
400 new tokens or six seconds, and once more when the block ends. Requests use
reasoning off and a 32 token output cap. The model call never delays the turn or
the trace; with the setting absent or an unknown model, titles use the trace
sentence.

The summary model must honor Pi's reasoning `off` level. Set
`thinkingLevelMap.off` in that model's Pi `models.json` entry to the provider's
own value for disabling thinking. For a provider that uses `none`, for example:

```json
{ "thinkingLevelMap": { "off": "none" } }
```

Without it, a model may spend the 32 token cap reasoning and return no headline.

For a development install, do not load this package from a path whose
`node_modules` contains its own `@earendil-works/pi-*` packages. That path makes
the display patch land on those private component classes rather than the classes
used by the running Pi. Stage the built package files outside such a tree, or
`npm pack` this package and install the tarball with
`pi install npm:pi-focus-mode@file:/absolute/path/to/pi-focus-mode-0.1.0.tgz`.

Set `cardFields` to the fields exchange and session cards show. The fields are
`duration`, `finishTime`, `model`, `input`, `output`, `tps`, `cache`, `waiting`, and
`cost`; all are shown by default. Cards keep that order whatever order the list uses, and
a session card always keeps its session headline. Put it in `<agentDir>/focus-mode.json`
or a trusted project's `.pi/focus-mode.json`, for example:

```json
{ "cardFields": ["duration", "model", "output", "tps", "cost"] }
```

`PI_FOCUS_MODE_CARD_FIELDS` overrides the files with a comma-separated list, such as
`duration,tps,cost`. Unknown names are ignored with one warning; a list with no valid
name shows every field. A card whose chosen fields are all empty for it (a finish time on
an old entry, or waiting when there was none) shows its duration. The setting is read when a session starts, so run `/reload` after
changing it. It changes only how cards are drawn, so existing cards follow it too.

## Install and verify

```sh
pi install npm:pi-focus-mode
```

Submit a prompt that makes at least one tool call and produces thinking. While it
streams, check that process lines update and assistant text remains visible. After Pi
settles, check that one progress line covers the work before the final answer; open it
to see process lines and interim text grouped beneath it with tree guides, while the
final answer stays unmarked. Check that exchanges without a process or a trailing
answer stay unfolded. Check that the exchange card uses one line when it fits and
wraps without truncating numbers at narrower widths, with metrics in parentheses,
cost last and no expanded detail. Open a process to see individual block timings
and counts. Run `/sessionstats` and confirm the session card keeps its turn and exchange
counts, with metrics in parentheses and following the same metrics rules. To check
parallel-tool accounting, run two overlapping tools and confirm their union is not
larger than the exchange wall time.

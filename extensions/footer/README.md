# pi-footer

A compact Pi footer showing the current directory, git branch and dirty-file counts, context usage, response speed, and model display name. Git status refreshes in the background with added/deleted line counts; rendering reads its cached result.

## Install

```sh
pi install npm:pi-footer
```

## Development

From this package directory, run its tests with:

```sh
node --test test/render.test.mjs
node --test test/git-status.test.mjs
```

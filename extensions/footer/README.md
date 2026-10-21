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

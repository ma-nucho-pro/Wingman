# Contributing

## Setup

```bash
git clone https://github.com/ma-nucho-pro/Wingman.git
cd Wingman
npm test          # no install step: zero dependencies
```

## Running it locally

```bash
node bin/wingman.mjs --help
WINGMAN_HOME=/tmp/wm-test node bin/wingman.mjs init --yes --local --name scratch
```

Always set `WINGMAN_HOME` when experimenting so you do not disturb your real store.

## Tests

```bash
node --test test/*.test.js
```

Three suites:

- `unit.test.js` — redaction, identity, parsing, rendering. Pure functions, fast.
- `e2e.test.js` — the CLI as a real subprocess, including a two-machine sync simulation against a
  bare git repo standing in for GitHub.
- `regression.test.js` — bugs that were found and fixed. Every entry here is a real failure that
  shipped in a draft; none of them should be deleted.

Tests must never touch the real `$HOME` or the real `~/.wingman`. Both are overridden per test.

## Rules

- **Zero runtime dependencies.** Node stdlib and shelling out to `git` only. This is the single
  hardest constraint and it is not negotiable.
- **A hook may never fail an AI session.** Anything reachable from `--hook` mode exits 0.
- **Never write an unverified config schema.** If a tool's format cannot be confirmed, use an
  instructions file instead. Breaking someone's Codex is worse than a manual step.
- **Every device writes only to its own paths.** The conflict-free guarantee depends entirely on
  this. Any shared mutable file is a bug.
- **Redact before writing, never after.** Once a secret reaches git history it is effectively
  permanent.
- Comments explain *why*, not *what*.

## Pull requests

Include a test. If you fixed a bug, put the test in `regression.test.js` and make sure it fails
without your fix.

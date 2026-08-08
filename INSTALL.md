# Wingman installation — instructions for an AI agent

You are installing Wingman for a user. Follow these steps in order. After each step, run the
verification command and check the result before continuing. Do not improvise, do not skip
verification, and do not edit configuration files by hand — `wingman init` does all of that
correctly, including backups.

If a step fails, use the failure branch for that step. Do not continue past a failed step.

---

## Step 0 — Confirm the working directory

Wingman attaches context to a project, so you must be in the user's project folder.

```bash
pwd
```

If this is not the project the user wants, `cd` there first and ask them if you are unsure.

---

## Step 1 — Check Node.js

```bash
node --version
```

**Pass:** `v18.0.0` or higher.

**Fail — command not found, or version below 18:** stop and tell the user:

- macOS: `brew install node`
- Windows: `winget install OpenJS.NodeJS.LTS`
- Linux: https://nodejs.org/en/download/package-manager
- Any OS, version manager: https://github.com/nvm-sh/nvm

Do not attempt to install Node yourself unless the user asks. Wait for them to confirm, then
re-run this step.

---

## Step 2 — Check git

```bash
git --version
```

**Pass:** any version 2.x.

**Fail:** tell the user to install git from https://git-scm.com/downloads, then re-run this step.

---

## Step 3 — Run the installer

```bash
npx wingman-ai@latest init --yes
```

This is interactive-free and safe to run more than once. It will:

1. identify the project (by its git remote, or by asking for a name)
2. create the local memory store
3. pin a stable copy of the runtime so hooks keep working
4. set up GitHub sync if credentials are already present
5. configure whichever AI tools are installed
6. back up every file it touches before modifying it

**Verify:**

```bash
npx wingman-ai@latest status
```

**Pass:** the output shows a project name and a machine name.

**Fail — "Node too old":** go back to step 1.

**Fail — "git is not installed":** go back to step 2.

**Fail — anything else:** run `npx wingman-ai@latest doctor`, which names the specific problem and
its fix. Report that to the user verbatim rather than guessing.

---

## Step 4 — Check whether sync is on

Look at the `Sync` line from step 3's `status` output.

### If it says `on`

Sync is working. Skip to step 5.

### If it says `off (local only)`

This is not an error. Wingman is fully functional; it just is not sharing across machines yet.

Ask the user: *"Do you want your context available on your other computers? That needs GitHub."*

**If they say no:** skip to step 5. Everything works locally.

**If they say yes**, check for the GitHub CLI:

```bash
gh auth status
```

- **Exit code 0:** run `npx wingman-ai@latest connect` and go to step 5.
- **Not logged in:** tell the user to run `gh auth login --web` themselves, in their own terminal.
  You must not run it — it opens a browser and needs their interaction. When they confirm, run
  `npx wingman-ai@latest connect`.
- **`gh` not found:** give the install command for their platform, then the two commands above:
  - macOS: `brew install gh`
  - Windows: `winget install --id GitHub.cli`
  - Linux: https://github.com/cli/cli#installation

---

## Step 5 — Verify end to end

```bash
npx wingman-ai@latest doctor
```

Every line should be `✓`, or `!` on optional items such as the clipboard tool. A `✗` means
something needs fixing; the line beneath it says exactly what.

Then prove the round trip works:

```bash
printf '## Goal\nVerify Wingman is working.\n\n## Next concrete step\nNothing, this was a test.\n' \
  | npx wingman-ai@latest save --agent setup-check --title "Install verification" --stdin
npx wingman-ai@latest load
```

**Pass:** the output of `load` contains "Verify Wingman is working".

---

## Step 6 — Tell the user what changed

Report, briefly:

- the project name and machine name from `status`
- whether sync is on, and if so the repo name
- which AI tools were configured
- that tools other than Claude Code need one restart to pick up new commands

Then explain how they will use it:

- Claude Code loads and saves on its own; nothing to do.
- Other tools: say "load the Wingman context" or "save a Wingman handoff" and the agent runs it.
- For web chats: `wingman paste` to take context out, `wingman capture` to bring it back.
- On another computer: run the same `npx wingman-ai@latest init` there.

---

## Rules for you, the agent

- **Never** hand-edit `~/.claude/settings.json`, `~/.codex/AGENTS.md`, `~/.gemini/`, or
  `~/.cursor/mcp.json`. `wingman init` merges safely and takes backups. Editing them yourself is
  how setups get broken.
- **Never** run `gh auth login` on the user's behalf. It is interactive and needs a browser.
- **Never** report success without running the step 5 verification.
- **Never** put API keys, tokens, or passwords into a handoff. Wingman redacts what it recognises,
  but do not rely on that.
- If `doctor` reports a problem, quote its message to the user rather than paraphrasing. The
  message already contains the fix.

## Using Wingman during normal work

Once installed, at the start of a task:

```bash
wingman load
```

Read the output before doing anything else. It is established history: do not redo work described
there, and do not retry anything listed as a dead end.

When context is running low, when switching tools, or when stopping:

```bash
wingman save --agent <your-tool-name> --title "<short summary>" --stdin
```

Pipe Markdown with exactly these sections:

```
## Goal
## Current state          (branch, last commit, what passes, what fails)
## Decisions made         (and why)
## Dead ends              (tried, did not work, do not retry)
## Files touched
## Next concrete step     (specific enough to start immediately)
```

Write **state, not transcript**. 200-400 words. The code is already on disk; what is lost between
tools is the reasoning.

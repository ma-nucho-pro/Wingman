# How Wingman works, in plain language

## The problem in one sentence

Every AI tool has memory, but none of them remember **for each other**, and none of them remember
on your **other computer**.

## The idea

Think of a **group chat** between your computers and your AI tools.

- Everyone posts their own messages.
- Nobody edits anyone else's.
- But the conversation is **one thread** and everybody reads all of it.

That is Wingman. Each machine writes to its own mailbox; every machine reads the whole thread.

## The three things it does

**Save.** When you stop working, or run out of context, your AI tool writes a short summary: the
goal, the decisions, what was tried and failed, and the next step. Not the transcript — the
**state**. Your code is already on disk; what gets lost when you switch tools is the reasoning.

**Sync.** That summary goes to a **private** repo in **your** GitHub account, called
`wingman-memory`. There is no Wingman server, no account to create, nowhere else for it to go.

**Load.** Open any AI tool on any computer and Wingman hands it the whole thread. It starts caught
up.

## Why the hooks print nothing

Every agent disagrees about what a hook may print. Claude Code injects whatever comes out of
stdout. Gemini CLI demands strict JSON and **breaks on a single stray character**. Codex expects
its own envelope. Those formats also drift between releases.

So Wingman's hooks print **nothing at all**. They refresh `.wingman/CONTEXT.md`, and each tool's
own instructions file points at it:

```
Hook on startup  →  refreshes .wingman/CONTEXT.md  →  empty output
                              ↑
      CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules import it
```

Silence is the only output no parser can reject, so the hook cannot break your tool — now or three
versions from now.

Your own instructions in those files are preserved, backed up before being touched, and
`wingman uninstall` removes only Wingman's block.

Wingman also **never** writes to `~/.codex/config.toml`. That file holds your credentials and
provider settings; a bad write there would break far more than Wingman. It uses the dedicated
`hooks.json` file instead.

## How it knows which project is which

**In a terminal:** the folder you are in.

But the folder is named differently on each machine, so Wingman does not use the path — it uses
the **git remote**. `~/work/myapp` and `D:\projects\myapp-clone` are recognised as the same
project because both point at `github.com/you/myapp`. Nothing to configure. Folders without a git
remote get a name once.

**In a browser:** there is no folder, so the identifier **travels inside the text**. `wingman
paste` includes a hidden line:

```
wingman: a3f9c21b8e04-myapp
```

When you bring the reply back with `wingman capture`, Wingman reads that line and files it
correctly — even from a different folder, even days later.

## Why there are never git conflicts

Each machine writes only inside its own folder, with timestamped filenames no other machine can
produce:

```
projects/a3f9c21b8e04-myapp/
  journal/
    work-pc--3f2a/     ← only the work PC writes here
    home-pc--91cd/     ← only the home PC writes here
    laptop--b70e/      ← only the laptop writes here
```

Because two machines never touch the same file, git has nothing to merge. Two computers can push
in the same second and both writes survive.

Those folders are **mailboxes, not walls**. On read, Wingman merges everything into one thread
sorted by time.

The four-character suffix exists in case you name two machines the same. Even then, their folders
stay distinct and everything keeps working.

## When things go wrong

| Situation | What happens |
|---|---|
| No internet | Saves locally and queues. Pushes on the next command. |
| No GitHub connected | Runs in local mode. Tells you how to enable sync later. |
| GitHub down | Same as no internet. Nothing is lost. |
| Two processes at once | They take turns via a lock. Both entries survive. |
| The repo turned out public | **Refuses to push** and tells you how to fix it. |
| Something fails inside a hook | The hook still exits cleanly. Your AI session never breaks. |

## What it does not do

- **Does not read your code.** Only the summaries your AI tools write.
- **Does not touch your AI accounts.** It does not know which ChatGPT or Claude account you use.
- **Does not send anything to third parties.** Only to your private repo.
- **Does not track you.** Zero telemetry. Open source; read it.

## Secrets

Before writing any file, Wingman scans for API keys, tokens, passwords and private keys and
replaces them with `[redacted-by-wingman]`. Because this happens **before** the write, a secret
never reaches git history — which is where it would become permanent.

Not infallible. Do not paste secrets on purpose.

## The vault: when you do want a secret kept

Redaction protects the journal, which is pushed to GitHub and replicated across all your machines.
But sometimes you want your agents to see something sensitive **on this computer and nowhere else**.

```bash
wingman vault -m "The staging key is in 1Password under Acme."
```

That is injected into every agent on this machine and is **never committed and never synced**. It
lives in a folder outside the store, so no flag can push it by accident — there is simply no code
path that puts it in a commit.

Vault content is stored **exactly as written**, secrets included, because that is its purpose. There
are tests verifying it never appears in the store, in any commit, or in git history.

```bash
wingman vault           # show it
wingman vault --clear   # delete it
```

## Rolling checkpoints

If you wait until you run out of context to ask for a summary, it is already too late: the model you
need to write the summary is the one that can no longer answer.

So Wingman saves a small checkpoint every 20 minutes of active work, with no model call at all. It
reads from disk: the branch, the last commit, which files changed. Zero tokens, and there is always
something recent saved.

It does not replace a handoff written by the agent — that is far better, because the agent knows
*why* things happened — but it guarantees you are never left with nothing.

## Why plain text rather than encrypted

Because you can open the repo on your phone and read your context, `grep` for a decision from
three weeks ago, see the diff of what changed, and trust the tool because you can look at the
folder and see exactly what was stored.

Encryption protects against GitHub. But the repo is already private and yours, and losing the
passphrase means losing the memory permanently. If you genuinely need it, `--encrypt` is planned
for v1.1.

## The five commands that matter

```bash
npx wingman-ai@latest init   # once per machine
wingman load                 # see the context
wingman save                 # save a handoff
wingman paste                # take it to a web chat
wingman capture              # bring it back
wingman doctor               # what is missing, and how to fix it
```

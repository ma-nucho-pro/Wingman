# Security

## Reporting a vulnerability

Open a [security advisory](https://github.com/ma-nucho-pro/Wingman/security/advisories/new).
Please do not open a public issue for anything exploitable.

## Threat model

Wingman is a local CLI. It has no server, no accounts, and no telemetry. Its trust boundaries are:

| Boundary | What Wingman does |
|---|---|
| Your disk | `~/.wingman` is `0700`; journal entries are `0600` |
| Your GitHub | Writes only to a repo it has verified is **private** |
| AI providers | Never authenticates to any of them |
| Third parties | None involved |

## What is protected

**Secret redaction.** Every string is scanned before it is written, so a redacted secret never
reaches disk and therefore never reaches git history. Covered: GitHub tokens and PATs, OpenAI,
Anthropic, AWS, Google, Slack, Stripe, GitLab, npm, DigitalOcean and Hugging Face keys, JWTs,
PEM private key blocks, credentials embedded in URLs, and assignments to variables named like
credentials. Placeholders (`<your-key>`, `${VAR}`, `changeme`) are deliberately left alone.

**Public repo refusal.** Setup verifies repository visibility through the GitHub API and aborts if
the repo is public or if visibility cannot be confirmed. It never guesses.

**Config safety.** Files are backed up before modification, JSON is validated before writing, and
writes are atomic (temp file plus rename). Your own hooks and settings are merged, never replaced.

**Process safety.** Git runs with `GIT_TERMINAL_PROMPT=0`, `core.hooksPath=/dev/null`, and
signing disabled, so a hostile memory repo cannot execute code. No subprocess uses a shell with
interpolated user input.

**Hook safety.** Hook-mode commands always exit 0. A failure in Wingman can never break an AI
session.

## Known limitations

- **Redaction is pattern-based.** A novel credential format may slip through. Do not paste secrets
  into handoffs deliberately.
- **Plain text by default.** Anyone with read access to your private repo — including GitHub, and
  anyone you grant access to — can read your context. This is a deliberate trade for
  greppability, phone access, and auditability. `--encrypt` is planned for v1.1.
- **Credential reuse.** Wingman uses your existing `gh` or git credentials. It never stores,
  copies, or transmits them, but it does inherit their scope.
- **Local access.** Anyone with your unlocked user account can read `~/.wingman`. Use full-disk
  encryption.

## Auditing

Zero runtime dependencies, so there is no supply chain beyond Node itself. Roughly 2,500 lines you
can read in an afternoon. Start with `src/redact.js` and `src/store.js`.

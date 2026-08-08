---
description: Save a Wingman handoff for the next tool or machine
---

Write a handoff for whoever picks this project up next — a different AI tool, or you on another
computer. Use exactly these sections:

```
## Goal
## Current state          (branch, last commit, what passes, what fails)
## Decisions made         (and why)
## Dead ends              (tried, did not work, do not retry)
## Files touched
## Next concrete step     (specific enough to start immediately)
```

Write **state, not transcript**: 200-400 words. The code is already on disk; what is lost between
tools is the reasoning, not the diff. Never include API keys, tokens or passwords.

Then save it by piping that Markdown to:

```
npx -y wingman-ai@latest save --agent claude-code --title "<short summary>" --stdin
```

Confirm to the user what was saved and whether it synced.

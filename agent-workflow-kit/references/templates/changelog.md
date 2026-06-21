---
type: history
lastUpdated: {{DATE}}
scope: permanent
staleAfter: never
owner: none
maxLines: 700
---

# AI Session Changelog

> One entry per session. Newest at the top. Entries roll off to `history/recent.md` (WARM) then `history/YYYY-MM.md` (COLD) via the archive script.
> Heading format is load-bearing for rotation: `## YYYY.MM.DD — <title>`.

## {{DATE}} — Bootstrap

**Goal:** Initialise the AI-agent memory system.
**Changes:**
- Created `AGENTS.md` (entry point) + `CLAUDE.md` symlink.
- Created `docs/ai/` with the spec files + `pages/`.
- Installed the docs cap-validator / index-freshness / archive scripts + pre-commit hook.
- Recorded the real stack, scripts, and architecture into the relevant files.

**Quality gates:** n/a (no code changes).

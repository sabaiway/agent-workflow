---
type: reference
lastUpdated: {{DATE}}
scope: permanent
staleAfter: 30d
owner: none
maxLines: 300
---

# Known Issues

> Every bug we hit. Status, workaround, impact, plan. Avoids re-discovering pain.

When an issue is resolved, move its section under `## 🟢 Resolved` and REPLACE its
`- **Status:**` line with a line-leading ISO-dated `**Resolved:**` field — that one dated line is
what the archive script reads (the legacy `**Status:** ✅ FIXED (YYYY-MM-DD)` form is still read;
~~strikethrough~~ on the heading is optional decoration). Keeping an open `Status:` line next to a
dated `Resolved:` line refuses loudly. Write it like this:

```markdown
### ~~Issue-042 — Example resolved issue~~
- **Resolved:** 2026-01-15 — what fixed it ([[AD-NNN]])
- **Resolution:** the fix, one line
- **Commit:** abc1234
```

## 🔴 Open

### Issue-001 — {{Title}}
- **Discovered:** {{DATE}}
- **Status:** Open
- **Impact:** {{user-facing? dev-only? blocking?}}
- **Workaround:** {{if any}}
- **Plan:** {{next action}}
- **Related files:** `{{src/...}}`

## 🟢 Resolved

---

> Resolved issues older than the window are rotated to `history/issues-resolved.md` by the issue-archive script.

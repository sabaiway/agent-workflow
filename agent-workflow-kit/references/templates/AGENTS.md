# AI Agent Algorithm — {{PROJECT_NAME}}

> **Execution protocol for AI agents working on this project.**
> **This file is your entry point. Read it first, then follow the Memory Map.**
> `AGENTS.md` is the cross-agent standard — Codex / Cursor / Devin Desktop / Copilot read it natively. Tool-specific aliases (e.g. `CLAUDE.md` for Claude Code) are symlinks to this file — single source, no duplication.

---

## 🗣️ Communication language

> **Talk to the user in {{COMM_LANGUAGE}}** — every question, explanation, summary, and status update.
> Keep code, identifiers, file paths, shell commands, log output, and abbreviations in their **source language** — translating them breaks copy-paste, search, and tooling.
> This sets the **dialogue** language only — it does not translate the files in `docs/ai/` or this entry point, which stay in their source language (for cross-agent / cross-team portability).

---

## ✍️ Attribution

> **Agent attribution: {{AGENT_ATTRIBUTION}}** (chosen at setup).
> **off** → never attribute work to the agent, AI, or the model: no `Co-Authored-By` trailers, no "Generated with …" footers, no AI/agent/model mentions in code, comments, commit messages, PR titles/bodies, branch names, or docs. Author everything as the human.
> **on** → the agent may add its standard `Co-Authored-By` trailer / footer per your tooling defaults.
> Claude Code also honours `includeCoAuthoredBy` in `.claude/settings.json`; this block binds every agent for everything written by hand.

---

## 🧭 Memory Map

All project knowledge lives in `docs/ai/`. Layered, lazy-loaded context:

- **Always-loaded** — this file + [`docs/ai/index.md`](./docs/ai/index.md) (auto-generated navigator).
- **On-demand** — read a specific `docs/ai/` file only when its "Read When" applies.
- **Hierarchical** — subdirectory `AGENTS.md` files (with a `CLAUDE.md` symlink for Claude Code) load automatically when you work in that folder.
- **Archive** — `docs/ai/history/` (rolling: HOT changelog → WARM `recent.md` → COLD per-month).

| File | Read When... | Update When... |
|------|--------------|----------------|
| [`docs/ai/handover.md`](./docs/ai/handover.md) | **Start of every session** | End of session if context changed |
| [`docs/ai/active_plan.md`](./docs/ai/active_plan.md) | Picking next task | Completing a task |
| [`docs/ai/current_state.md`](./docs/ai/current_state.md) | Need system overview | After feature completion |
| [`docs/ai/technical_specification.md`](./docs/ai/technical_specification.md) | App overview & data models | Data-model changes |
| [`docs/ai/pages/index.md`](./docs/ai/pages/index.md) | Understanding a page | Page behaviour changes |
| [`docs/ai/architecture.md`](./docs/ai/architecture.md) | Understanding structure | Architecture changes |
| [`docs/ai/known_issues.md`](./docs/ai/known_issues.md) | Debugging | New issue discovered |
| [`docs/ai/decisions.md`](./docs/ai/decisions.md) | Considering alternatives | New ADR |
| [`docs/ai/changelog.md`](./docs/ai/changelog.md) | Reviewing history | After each session |
| [`docs/ai/env_commands.md`](./docs/ai/env_commands.md) | Need a command | Commands change |
| [`docs/ai/tech_reference.md`](./docs/ai/tech_reference.md) | Need a pattern | New reusable pattern |
| [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) | **Before any code change** | Protocol changes |

---

## 🚀 Session Protocols

Start-of-session, during-work, and task-completion procedures live in [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) §1. **Read it before any code change.**

<!-- workflow:methodology:start -->
<!-- workflow:methodology:end -->
<!-- workflow:orchestration:start -->
<!-- workflow:orchestration:end -->

---

## 🚫 Hard Constraints

| Rule | Enforcement |
|------|-------------|
| No `export default` (named exports only) | Linter |
| No `any` / no unsafe casts | Linter / type-checker |
| Functional style (no mutation in app code) | Linter |
| Interactive elements semantic (button/link, not div+onClick) | Linter / a11y |
| No hardcoded colors — design tokens only | Code review |
| No business logic in components → hooks/services | Architecture review |
| No changes without tests (TDD) | Required |
| Check page docs before changes; update them after | Process |
| Ask user before committing | Process |
| Every page has an HTML-validity / a11y E2E test | Required |
| **No silent failures** — structured logging on every rejected action | Required |

---

## 💡 Quick Commands

| Need | Command |
|------|---------|
| Dev server | `{{DEV_COMMAND}}` |
| All checks | `{{LINT}} && {{TYPECHECK}} && {{TEST}}` |
| E2E tests | `{{E2E_COMMAND}}` |
| Docs caps + index freshness | `{{DOCS_CHECK}} && {{DOCS_INDEX_CHECK}}` |
| Find pattern | `grep -r "pattern" src/` |

Full reference → [`docs/ai/env_commands.md`](./docs/ai/env_commands.md).

---

**Rule:** This file stays CONCISE (≤100 lines). Details go to `docs/ai/`. Never bloat this file.

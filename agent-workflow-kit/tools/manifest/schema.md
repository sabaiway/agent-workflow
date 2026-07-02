# `capability.json` — family manifest schema (schema 1)

Owned and shipped by the kit (the composition root). Every `agent-workflow` family member
ships a `capability.json` at its skill root. Detection is **declarative** (path/env fields, not
embedded shell — Windows-safe); the installer resolves path fields in Node (tilde + env
expansion), never via the shell. The validator is [`validate.mjs`](./validate.mjs).

## Fields

| Key | Type | Required | Notes |
|---|---|---|---|
| `family` | string | yes | must be `"agent-workflow"` |
| `schema` | number | yes | `1`. An unknown number → **unsupported** (not invalid). |
| `name` | string | yes | the skill name |
| `kind` | string | yes | one of `memory-substrate`, `methodology-engine`, `execution-backend`, `composition-root` |
| `version` | string | yes | must equal the authoritative version (below), unless `available:false` |
| `provides` | string[] | yes | subset of the **role vocabulary** |
| `roles` | object | yes | keys ⊆ `provides`; see *Roles* |
| `detect` | object | no | `installed` (skill on the machine) + `deployed` (substrate set up in cwd) |
| `install` / `uninstall` | object | no | `install.npm` is a package name, not a path |
| `cost` / `quota` / `provenance` | misc | no | informational |
| `available` | boolean | no | `false` = a declared-but-not-installed stub; skips fs/version checks |

## Role vocabulary

`context | plan | execute | review | probe | synthesize`. Every entry of `provides` and every
key of `roles` must come from this set, and **`provides` ⊇ `Object.keys(roles)`** (you may
advertise a capability without a callable role, but never the reverse).

### Roles

Each `roles.<role>` is an object:

- `cmd` (string, required) — the **PATH name** of the wrapper (e.g. `codex-review`). Not a repo
  path; not validated for existence.
- `source` (string, required) — the **in-skill script** backing `cmd` (e.g. `bin/codex-review.sh`).
  Repo-relative within the skill; **must exist**.
- `template` (string, optional) — an in-skill prompt/template path (e.g.
  `references/review-prompt.md`); repo-relative, **must exist**.
- `modes`, `output` (optional) — e.g. `["plan","code"]`, `"advisory"`.
- `contract` (object, optional; execution-backend bridges) — the machine-readable **driving
  contract** for a dispatchable recipe role (`review` / `execute`; the `probe` role carries none).
  Rides as a validator-tolerated extra field (format-checked by the bridge/kit drift-guard tests,
  not by `validate.mjs`), and is the single source the point-of-use advisor
  (`/agent-workflow-kit procedures`) and each wrapper's `--help` render verbatim:
  - `invocations` (string[], non-empty) — exact copy-pasteable invocation descriptors, one per
    mode/variant, incl. operand placeholders (`<plan-file>`, `[extra focus...]`).
  - `grounding` (string) — the grounding note (e.g. agy's `--facts @f` / `--decided @f` levers, or
    "automatic — …" when the wrapper grounds itself).
  - `flags` (string[], optional) — the closed per-mode flag descriptor set (closed-grammar
    wrappers only).
  - `continue` (string[]) — round-2 / resume invocation descriptors; `[]` when one-shot.
  - `passthrough` (object, optional) — the guarded `--` passthrough tiers:
    `{ policy: "guarded", blocked: string[], probeRelaxed: string[] }`, matching the wrapper's
    real case-arm patterns (pinned by the source-level reverse-guard test).

## Path-field rules (Windows-safe, traversal-safe)

- **No absolute paths**, **no `..` traversal**, **no unresolved placeholders** (`{{…}}` / `${…}`)
  in any field.
- `source`, `template`, `detect.installed.file` — repo-relative **within the skill**; must exist
  (skipped for `available:false` stubs).
- `detect.installed.default` — may be **home-relative** (`~/…`); resolved by the installer.
- `detect.deployed.file` — **project-relative** (e.g. `docs/ai/.memory-version`); format-checked
  only (it lives in the target project, not the skill).
- `detect.installed.env` — an **env var name**, not a path.

## Authoritative version

`version` is matched against `package.json` `version` where one exists, else the skill's
`SKILL.md` frontmatter `metadata.version` — so a bridge with no `package.json` cannot drift from
its `SKILL.md`. Skipped only for `available:false` stubs.

## Result classes

- **valid** — schema understood, all checks pass.
- **unsupported** — `schema` is a number this validator does not understand (forward-compat).
- **invalid** — schema understood but a check failed.

Runtime callers (the kit's memory detector) treat **unsupported and invalid alike — do not act**,
fall back to the bundled copy. Authoring/CI runs `validate.mjs --strict` and exits non-zero on
**unsupported or invalid**.

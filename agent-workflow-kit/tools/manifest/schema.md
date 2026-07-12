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
| `settings` | array | no | the bridge's **settings-file surface** (typed; see *Settings*). Unlike `contract`, a malformed entry **fails** `--strict`. |
| `networkHosts` | string[] | no | the backend CLI's **observed egress host families** (see *Network hosts*). A malformed list **fails** `--strict`. |
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

## Settings (bridges 2.3.0, D6 — manifest-as-source)

`settings` declares the bridge's host-level settings-file surface
(`${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf`). It is an **array** of
typed entries — a JSON object would silently dedupe duplicate keys under `JSON.parse` — and,
unlike `contract`, it is validated by `validate.mjs` itself: a malformed entry **fails**
`--strict` (the kit writer, the status renderers, and the wrapper shell constants all consume
this block). Each entry:

- `key` (string, required) — UPPER_SNAKE_CASE env-var name; unique across the array.
- `kind` (string, required) — `enum | integer | duration | boolean`.
  - `enum` → `values` (string[], non-empty, unique).
  - `integer` → `min` / `max` (safe integers, `min <= max`); values are decimal strings.
  - `duration` → the wrappers' shell duration grammar (`5m`, `30m`, `90s`): a unit suffix
    (`s|m|h|d`) is **required** — a bare integer is invalid — and **zero durations are
    rejected** (`timeout 0` would silently DISABLE a hard cap).
  - `boolean` → the pinned wire format `"0" | "1"` (exactly what the wrappers' env vars accept).
- `default` (string|null, **required property** — a missing key fails validation) — `null` = no
  file default, the wrapper built-ins apply (state them in `effect`); a non-null default must
  itself pass the kind's validation.
- `appliesTo` (string[], required) — the wrapper `cmd` names (from `roles.*.cmd` of THIS
  manifest) that APPLY the key. Every wrapper still RECOGNIZES the whole family registry (the
  union of both bridges' `settings` keys) and skips other wrappers' keys silently.
- `effect` (string, required) — what the knob does, incl. built-in defaults and any spend/risk
  caveat (the credit-rate caveat rides here for the tier knob).

Wrappers never parse JSON at run time: each carries its own shell registry/validation constants,
drift-guarded set-equal to this block by the bridge `bin/*.test.mjs` suites (help section keys,
`aw_settings_known` registry, `AW_SETTINGS_APPLIED` subset, `aw_settings_valid` typed arms).

## Network hosts (AD-044 Plan 4, consult-locked)

`networkHosts` declares the hosts the backend CLI is **observed** to contact (synthetic examples:
`*.api.backend.example`, `accounts.backend.example`; the real observed lists live in each bridge's
`capability.json`) — the **single documentation
source** for a hand-applied sandbox/network allowlist (session sandbox config, or a hand-pasted
`sandbox.network.allowedDomains` entry). Rules:

- Each entry is a bare dotted hostname or a `*.family` wildcard — never a scheme/path/port.
  Entries must be unique. A malformed list **fails** `--strict` (the entries are pasted verbatim
  into allowlist lines by the Recommendations advisor).
- **The kit never seeds these into settings** (bridge council 2026-07-11, both backends concur):
  a network pre-allow widens egress for **every** sandboxed command, so running the wrappers
  **outside** the sandbox (`sandbox.excludedCommands`, the `--bridge-tier` wiring) stays the
  primary lane; the hosts list exists for the **hand-apply** fallback under harness-managed
  sandboxes where settings-level exclusions are inert.
- Observed-minimal, honestly incomplete: a blocked host names itself at run time — extend the
  hand-applied list by hand; the manifest list records what was actually observed.

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

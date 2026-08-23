# Feature Specs

The durable per-feature CONTRACT layer of `docs/ai/`: what a feature accepts and returns, which
scenarios pin it, and — the core value — what is OUT of scope. A plan is the ephemeral delta; a spec
is the living, name-addressed WHAT; an ADR is the immutable, numbered WHY. Specs are not numbered.

The layer is a continuation of the family's own practice, not a methodology import: the existing
plan-approval checkpoint confirms a contract, the existing `maxLines` caps bound every file, the
existing `[[AD-NNN]]` convention links the why, and hidden mode covers the store with no new
machinery. **No new blocking checkpoints**: statuses are lifecycle markers, never approval gates.

## Where specs live

- `docs/ai/specs/`, inside the memory substrate, hierarchical by domain and feature slice, built for
  thousands of specs. The store root `docs/ai/specs/index.md` links up to `technical_specification.md`
  (the top spec stays the system root).
- Every folder's `index.md` lists ONLY its immediate children; there is no global per-spec index.
  The always-loaded navigator `docs/ai/index.md` carries ONE counted `specs/` row (specs / parts /
  indexes) generated from the store, so adding or removing a valid spec changes the navigator and the
  freshness gate sees it. A file the reader refuses keeps its own visible navigator row — never
  swallowed by the aggregate.
- "Well-formed" has ONE definition: the deployed reader `scripts/spec-schema.mjs`
  (`readSpecDocument(text, rel)`), read through by the navigator collapse and by the structural
  checker alike. It is pure text — it imports nothing, opens no file, and models no markdown code
  (a fence line refuses; a spec carries no code sample, so no line is ever ambiguous).

## The frozen schema

These values are frozen; the reader's `SPEC_SCHEMA` carries them and the canon test pins this file
against it.

- **Frontmatter**: the substrate six keys — `type: spec`, `lastUpdated`, `scope`, `staleAfter`,
  `owner`, `maxLines` — plus `kind`; the key set is CLOSED (an unknown or repeated key refuses).
  `status` and an integer `revision >= 1` ride ONLY on
  `kind: spec` (the contract root owns them); a `part` or an `index` carrying either REFUSES.
- **kind** — `index` | `spec` | `part` (the entity discriminant: an `index.md` with `kind: spec` is a
  promoted contract root, with `kind: index` a domain navigator).
- **status** — `draft` | `live` | `retired`. Transitions run forward only: draft -> live (the
  landing row of the approved plan) and live -> retired (the removal row), never backwards.
  `revision` increments by one per live contract change.
- **Caps and thresholds** — `maxLines: 80` on an index, `maxLines: 150` on a spec or a part. Fan-out:
  an index lists at most 30 immediate children; beyond that it subdivides along feature-slice /
  subdomain boundaries, never into arbitrary buckets. Promotion: a spec over its own `maxLines: 150`
  becomes `<slug>/index.md` (`kind: spec`) plus `part` files beside it — recursive, no depth limit.
- **slug** — the file stem of a flat spec, the folder name of a promoted root or a domain index:
  `^[a-z0-9]+(-[a-z0-9]+)*$`. Every path segment under the store is a slug.
- **Scenario line** — `- S<N> <name> :: <repo-relative test path> :: spec:<slug>/S<N>` or
  `- S<N> <name> :: unbound`; N runs contiguously from 1; the marker equals the line's own id.
- **`## Module`** — bullets of repo-relative paths: ONE `dir/` root OR a literal file list. `..`,
  an absolute path, a backslash, a glob, and a dir + file mix each REFUSE. A retired spec may carry
  `*(empty)*`.
- **`## Out of scope`** — at least one non-blank bullet, or exactly `*(empty)*` when the emptiness is a decision.
- An `unbound` scenario on a `live` spec is an advisory warning, never a refusal.

## Shape per kind

- **`index`** — frontmatter: the six keys + `kind: index` (+ `maxLines: 80`). Headings: `# <title>`,
  `## Children` — each immediate child exactly once as `- [name](./<child>.md)` or
  `- [name](./<child>/index.md)`, at most 30. No `status`, no `revision`, no `## Scenarios`,
  `## Out of scope`, `## Module` or `## Parts`. The store root additionally carries, before its
  first section, exactly the line `> Up: [technical_specification.md](../technical_specification.md)`.
- **`spec`** — frontmatter: the six keys + `kind: spec` + `status` + `revision` (+ `maxLines: 150`).
  File: `<slug>.md` (flat) or `<slug>/index.md` (promoted). Headings in order: `# Spec: <title>`,
  `## Contract`, `## Scenarios`, `## Out of scope`, `## Module`, optional `## Parts` (promoted roots
  only: each part exactly once as `- [name](./<part>.md)`), optional `## Links` (`[[AD-NNN]]`, page
  citations).
- **`part`** — frontmatter: the six keys + `kind: part` (+ `maxLines: 150`). File: `<name>.md` beside
  a promoted root. Heading: `# Part: <title>`. No `status`, `revision`, `## Scenarios`,
  `## Out of scope`, `## Module` or `## Parts` — the root owns them.

## Refusals

The reader names exactly one rule per defect. The repo-only fixture corpus carries at least one
refuse case per rule and an accept case per kind; a refuse fixture yields exactly its rule.

| Rule | Refuses |
|------|---------|
| `frontmatter` | no YAML frontmatter |
| `frontmatter-key` | an unknown key, a repeated key, or a line that is not `key: value` (the key set is closed; this ends the read) |
| `substrate-key` | one of the six substrate keys is missing |
| `type` | `type` is not `spec` |
| `kind` | `kind` missing or outside `index`, `spec`, `part` |
| `maxlines` | `maxLines` differs from the kind's frozen cap |
| `status` | a spec's `status` missing or outside `draft`, `live`, `retired` |
| `revision` | a spec's `revision` missing or not an integer >= 1 |
| `root-owns` | a part or an index carrying `status` or `revision` |
| `slug` | a path segment outside the slug pattern |
| `kind-path` | an index not named `index.md`, a part named `index.md` or placed at the store root, a contract root at the store root |
| `root-uplink` | the store root without the exact up-link line before its first section |
| `title` | the first heading is not the kind's title form, or a section opens before it |
| `section-missing` | a required section absent |
| `section-order` | the required and optional sections out of order |
| `section-forbidden` | a section the kind never carries |
| `fence` | a code fence line — a spec document carries no code sample; the reader models no markdown code |
| `children-link` | a `## Children` line that is not a child link to a slug |
| `children-duplicate` | a child listed twice |
| `fan-out` | more than 30 children |
| `scenario-line` | a `## Scenarios` line outside the scenario grammar |
| `scenario-number` | scenario ids not contiguous from 1 |
| `scenario-marker` | a marker whose slug or id differs from its own line |
| `scenario-path` | a binding's test path that is not a repo-relative file |
| `out-of-scope` | no non-blank bullet and not exactly `*(empty)*` |
| `module-line` | a `## Module` line that is not a `- <path>` bullet |
| `module-empty` | no module path and not exactly `*(empty)*` (a retired spec may carry the marker instead of a path) |
| `module-traversal` | a module path with `..` |
| `module-absolute` | an absolute module path |
| `module-backslash` | a module path with a backslash |
| `module-glob` | a module path with a wildcard |
| `module-mix` | neither ONE `dir/` root nor a literal file list |
| `parts` | `## Parts` on a flat spec, a malformed part link, or a part listed twice |

## Lifecycle, binding and approval

- **One entity.** A spec is the durable contract; the ephemeral plan is the delta vehicle; the spec
  revision lands with the code. There is no change-spec entity.
- **Governing specs are plural.** A plan cites ZERO (nothing spec-covered touched — legal during
  adoption), ONE or MANY governing specs — one per touched spec-covered slice; a shared-module change
  cites the specs of every slice whose contract it can alter.
- **Out of scope composes PER GOVERNING SLICE — there is no global union.** Each cited spec's
  exclusions bound only the work inside that slice, and the plan's non-goals restate them per slice.
  A cross-spec conflict is resolved by a spec REVISION BEFORE plan approval — never by silent
  precedence or review-time improvisation.
- **Every contract change is reviewable at plan review.** A NEW feature's draft spec is authored WITH
  the plan and exists AT review (a `create` ledger row); a plan that ALTERS a governed contract
  carries the proposed revision at review the same way (a `modify` row). Approval confirms the plan
  and every cited draft or revision atomically; the rows then land them. A contract is never
  "confirmed" before it is visible.
- **Test-as-spec binding is per scenario.** Every scenario names the test that pins it; a NEW
  scenario on a live spec is individually `unbound` until its test lands within the same plan — the
  spec's status never regresses for an extension. The binding is literal and language-agnostic: the
  marker `spec:<slug>/S<N>` must occur exactly once in the named file. The honest claim is an
  advisory structural pin; runnability and greenness stay the test suite's own gate.
- **Containment** is lexical AND realpath on every path-bearing field (bindings, child links, module
  roots). The reader judges the lexical half; realpath and symlink escapes are the structural
  checker's duty (`spec-check`, a later slice), together with marker existence and uniqueness, link
  resolution and the global invariants (slug uniqueness, module-root overlap, tree acyclicity) that
  only a full-tree sweep can prove.

## Precedence — feature spec and page spec

| Feature spec | Page spec | Governs |
|--------------|-----------|---------|
| present | present | the feature spec; `pages/<page>.md` is a subordinate view-layer document cited from it |
| absent | present | the page spec, as an ADOPTION SHIM — the citing plan states Out of scope + Revision inline |
| present | absent | the feature spec |

`PAGE_TEMPLATE.md` is not upgraded for this; the durable fix is authoring the feature spec through
the retroactive path below.

## Spec and code

- **A discoverable bijection.** The spec path mirrors the feature-slice path; a slug is IDENTICAL to
  the slice or module name for NEW and deliberately refactored slices. A LEGACY module keeps its
  existing name — the spec's declared module root IS the mapping, no rename ride-alongs; folder
  promotion keeps the slug. A module root is a DIRECTORY or a DECLARED FILE SET, so a file-based
  boundary binds without an architectural refactor.
- **Spec drives modular, feature-sliced architecture.** Code is organized by feature slice, not by
  technical layer; a spec's drill-down mirrors the slice's module boundaries; the pure rule / IO
  shell split is the default module anatomy, composing with the source-size practice (a module you
  can hold whole is the unit of review).
- **ONE dependency rule: the dependency graph is explicit and acyclic.** A slice depends on `shared`
  and on another slice's PUBLIC contract only when that edge is DECLARED in its spec; an undeclared
  cross-slice reach-in is refused at review.
- **Enforcement altitude, stated honestly.** This series the dependency and reach-in rules are
  REVIEW-level canon defaults for NEW and deliberately refactored slices — no machine enforcement
  (declared-edge fields, cycle checks, reach-in detection) ships; a legacy layered project is not
  rendered nonconforming and adopts per feature through the retroactive path.

## Spec and ADR

Complementary, never competing: an ADR is the immutable, numbered, chronological WHY; a spec is the
living, name-addressed WHAT. A spec cites its shaping ADRs in `## Links` via `[[AD-NNN]]`; an ADR
that changes a contract triggers a spec revision.

## Retroactive coverage

The onboarding path for an existing feature: read the code, author a `draft` spec from it (the
contract it actually keeps, the scenarios its tests already pin, the Out of scope its boundaries
imply), then human review promotes it to `live` through a plan. Used to dogfood the family's own
subsystems; a legacy module binds through a declared file set, never a refactor ride-along.

## Scale

The navigator walk is O(all docs) per pre-commit; the spec store joins it. The budget is a numeric
release gate: 1500 ms for both hook runs over a valid 1000-spec, 30-per-folder tree (the median of
three trials), measured by the repo's scale probe before every release of the checker — exceeding it
is fixed inside the walk (cheaper per-file work, early exits), never queued. The structural checker
is O(changed) by construction: it takes explicit spec paths, and `--all` is the explicit full sweep;
a git-derived "changed" lane is refused, because hidden mode ignores `docs/ai/**` and git would see
no spec at all.

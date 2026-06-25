# @sabaiway/agent-workflow-engine

**The canonical home of the `agent-workflow` planning methodology.** It owns the
methodology *text* — the Plan → Phase → Step vocabulary, the plan-file lifecycle
(`docs/plans/*.md`, ephemeral, never committed), the `queue.md` series index, the mandatory
final **Phase: Cleanup**, and the bounded methodology slot fragment the family kit injects
into a deployed project's `AGENTS.md`.

This is the **methodology engine** of the `agent-workflow` family — the canonical source the
rest of the family builds on. It is **content**, not a runtime: it reads nothing, writes
nothing, and mutates no project file. It deliberately **knows nobody else** in the family —
it only *provides* the methodology; the family composition root (`agent-workflow-kit`) is the
one that injects it. The kit currently consumes a **byte-identical, drift-guarded mirror** of
this canon bundled inside the kit; the live `kit → engine` read (and retiring that mirror)
lands in the next slice.

## Install

```bash
npx @sabaiway/agent-workflow-engine@latest init
```

Installs/refreshes the canon at `~/.claude/skills/agent-workflow-engine` (override with
`--dir <path>` or `AGENT_WORKFLOW_ENGINE_DIR`). `init` is additive — it never deletes your
files and never writes through a symlink. Re-running with `@latest` is how you refresh the
installed canon to the current version.

This is a **content** skill (`disable-model-invocation`): it is not a project deploy and is
not model-invoked. There is nothing to "run" inside an agent — installing it places the
methodology canon on disk for the family to read.

## Use

The methodology is consumed by the family composition root, not invoked directly. Day to day
you install and use the **kit** (`@sabaiway/agent-workflow-kit`), which injects the
methodology slot into your project's `AGENTS.md`. Install the engine standalone when you want
the canonical methodology reference on disk:

- [`references/planning.md`](references/planning.md) — the **full methodology**: the
  Plan → Phase → Step vocabulary, the plan-file lifecycle, the `queue.md` series index, the
  mandatory final **Phase: Cleanup**, and the plan-then-execute split.
- [`references/methodology-slot.md`](references/methodology-slot.md) — the **bounded**
  fragment the composition root injects into a deployed `AGENTS.md` (a short summary +
  pointer, kept under the entry point's line cap).

## What this package ships

`SKILL.md` (the canon overview + ownership rule), `references/` (the full methodology
reference + the bounded slot fragment), `capability.json` (the family manifest), and this
installer. It ships **no** family-wide tooling (the schema/validator/injection live in the
composition root) and mutates nothing — preserving "knows nobody".

## License

MIT — see [LICENSE](./LICENSE).

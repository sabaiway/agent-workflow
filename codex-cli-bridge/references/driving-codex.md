# How the main agent drives `codex`

`codex` is a **delegated-execution backend**: the main agent stays the orchestrator and hands codex a
bounded sub-task answered from the **ChatGPT subscription**. Codex has two modes here — a sandboxed
**executor** (`codex-exec`) and a read-only **reviewer** (`codex-review`). Treat all codex output as
**advisory**: the orchestrator owns the accepted edits, the verification, the commit, and the final
judgment.

## Delegation checklist

1. Decide the mode: `codex-exec` to *do* (edit the repo under the sandbox), `codex-review` to *judge*
   (advisory findings, no edits).
2. Run the wrapper from the **target project root** so codex auto-reads its `AGENTS.md` (the wrappers
   also preflight that a root `AGENTS.md` and a git work tree exist).
3. For an ad-hoc instruction, make it self-contained: codex cannot see your conversation — embed the
   goal, the relevant paths, the non-goals, and the expected result. The project's rules come from
   `AGENTS.md`.
4. Let codex run; then **review its diff yourself** and re-run the project's gates.
5. **Commit yourself** — codex never commits.

## Exec vs review

Use **`codex-exec`** when there is a concrete plan or focused instruction to implement, the project
declares Hard Constraints + gates in `AGENTS.md`, the work fits network-off `workspace-write`, and you
can review the resulting diff.

Use **`codex-review plan`** for a cold second opinion on a plan before executing it (risks, missing or
mis-ordered steps, scope creep, missing gates).

Use **`codex-review code`** for advisory, severity-tagged findings on uncommitted changes — including
when **untracked** files matter: the wrapper prompt tells codex to run `git status --short` and read
the contents of `??` files, because plain `git diff` omits them.

## Usage

```bash
codex-exec docs/plans/<slug>.md                  # drive a plan file
echo "apply review fix: tighten the guard in X, keep tests green" | codex-exec -
CODEX_MODEL=<slug> CODEX_EFFORT=high codex-exec <file>     # tune model/effort
codex-exec <file|-> -- --add-dir ../shared        # passthrough codex flags after `--`

codex-review plan docs/plans/<slug>.md            # critique a plan before executing it
codex-review code                                 # review the current working-tree diff
codex-review code "focus on the reducer and its tests"
```

`codex-exec` prepends an **orchestrator execution contract**: work in the current tree, never
git-write, obey the target `AGENTS.md`, self-review the diff (incl. untracked files), run the
project's declared gates (STOP if none are declared), don't commit, report blockers.

## Prompt shapes (for ad-hoc `codex-exec -` instructions)

Execution:

```text
Implement the change below from the current project root.
Respect root AGENTS.md, especially its Hard Constraints and declared gates.
Do not run git write commands. Do not commit.
If a dependency install, network call, missing gate set, or out-of-repo write is needed, STOP and report.

<the focused instruction + relevant paths>
```

The review prompt shapes are built into `codex-review` itself — you only pass `plan <file>` or
`code [focus]`; the wrapper supplies the severity-tagged-findings + verdict directive.

## Re-dispatch vs. fresh run

```bash
codex exec resume --last      # run codex DIRECTLY — not through codex-exec
```

Resume is **not** reachable through `codex-exec`: the wrapper's shape (fixed flags + a trailing `-`
that reads the prompt from stdin) can't host the `resume` subcommand, and the wrapper rejects
policy-affecting passthrough flags anyway. Run `codex exec resume` directly when you want to continue
a session without re-sending context — but note it runs **outside** the wrapper, so it does not
inherit the enforced sandbox/network/approval policy and **may not re-accept those flags**. Restate
the policy in the resumed instruction, or just start a fresh `codex-exec` run when the posture must be
guaranteed (see `sandbox-and-flags.md`).

## Escalation policy (edits, network, git)

- **Repo edits** are codex's job *inside* `codex-exec`'s workspace-write sandbox — but you **review the
  diff** before accepting/committing it. `codex-review` makes no edits at all.
- **New dependencies / network installs** are done by hand (exec has network OFF), then codex is
  re-dispatched.
- **Git writes** (branch/add/commit/stash/reset/checkout/tag/rewrite) are never delegated — the
  orchestrator commits after review. The execution contract forbids them.

## Handling output

codex output is advisory. Before acting:

- Re-run the project's gates yourself; don't trust a "green" claim you didn't see.
- Inspect the diff yourself; check edits against the project's `AGENTS.md` rules.
- Reject advice that conflicts with user instructions, repository rules, or security boundaries.
- Report uncertainty clearly, and summarise only verified claims back to the user.

# How the main agent drives `codex`

`codex` is a **delegated-execution backend**: the main agent stays the orchestrator and hands codex a
bounded sub-task answered from the **ChatGPT subscription**. Codex has two modes here — a sandboxed
**executor** (`codex-exec`) and a read-only **reviewer** (`codex-review`). Treat all codex output as
**advisory**: the orchestrator owns the accepted edits, the verification, the commit, and the final
judgment.

## Delegation checklist

1. Decide the mode: `codex-exec` to *do* (edit the repo under the sandbox), `codex-review` to *judge*
   (advisory findings, no edits).
2. Run the wrapper from the **target project root** so codex auto-merges its `AGENTS.md` (the wrappers
   also preflight that a root `AGENTS.md` and a git work tree exist, and fail fast before spending a run).
3. For an ad-hoc instruction, make it self-contained: codex cannot see your conversation — embed the
   goal, the relevant paths, the non-goals, and the expected result. The project's rules come from the
   already-merged `AGENTS.md`.
4. Let codex run; then **review its diff yourself** and re-run the project's gates.
5. **Commit yourself** — codex never commits (a git-write shim enforces it; see below).

## Quality-first: model & effort are pinned

Delegated codex work ALWAYS runs on the frontier model at max effort: `gpt-5.5` / `xhigh` are **pinned**
and a non-default `CODEX_MODEL`/`CODEX_EFFORT` is **refused** (exit 2). Do not try to "tune down" the
model or effort for a real run — the wrapper will stop you. Quota is metered in **messages** (rolling
5h + weekly), so economy comes from removing waste (clean capture, the precomputed review diff, resume),
never from a downgrade. The only opt-out is a throwaway, effort-independent probe: `CODEX_PROBE=1`
(loud) — never use its output as real work.

## Exec vs review

Use **`codex-exec`** when there is a concrete plan or focused instruction to implement, the project
declares Hard Constraints + gates in `AGENTS.md`, the work fits network-off `workspace-write`, and you
can review the resulting diff.

Use **`codex-review plan`** for a cold second opinion on a plan before executing it (risks, missing or
mis-ordered steps, scope creep, missing gates).

Use **`codex-review code`** for advisory, severity-tagged findings on uncommitted changes. The wrapper
**precomputes the whole change set** — repo map, `git status`, staged + unstaged diff, and the
**contents of untracked files** (binaries noted but skipped, symlinks shown as targets;
never-committable untracked paths — devices/FIFOs/sockets — excluded from the review domain
entirely) — and feeds it in, so codex does not burn a run roaming the filesystem to
rediscover it. A clean tree exits 0 *before* a run is spent. An oversized payload (over
`CODEX_REVIEW_MAX_TOTAL_BYTES`, default 1.5 MB) is written to a git-dir temp file and referenced by
path — never silently truncated. Set `CODEX_REVIEW_SCHEMA=1` to get findings back as a validated JSON
object (raw-text fallback on failure).

## Usage

```bash
codex-exec docs/plans/<slug>.md                  # drive a plan file
echo "apply review fix: tighten the guard in X, keep tests green" | codex-exec -
codex-exec <file|-> -- <extra codex flags>       # GUARDED passthrough AFTER `--` (policy/model/capture flags rejected; some relaxed only under CODEX_PROBE=1)

codex-exec --resume-last docs/plans/<slug>.md    # continue the last session, no re-send
echo "now do step 2" | codex-exec --resume <id> -

codex-review plan docs/plans/<slug>.md            # critique a plan before executing it
codex-review code                                 # review the current working-tree diff (precomputed)
codex-review code "focus on the reducer and its tests"
```

`codex-exec` prepends an **orchestrator execution contract**: work in the current tree, never
git-write, *obey* the already-merged `AGENTS.md` (Hard Constraints + declared gates), self-review the
diff (incl. untracked files), run the project's declared gates (STOP if none are declared), don't
commit, report blockers. It captures only codex's **final message** (`-o`; the JSON event stream +
reasoning are discarded to a trace) and, on a **non-resume** run, records the session id to
`${CODEX_SESSION_FILE:-./.codex-last-session}`.

## Resume — iterate without re-sending context

```bash
codex-exec --resume-last <plan-file|->     # session id read from the sidecar
codex-exec --resume <session-id> <file|->  # explicit session id
```

Resume continues the SAME codex session, so you avoid re-sending the original context. It runs through
the wrapper, which **re-establishes every invariant** (subscription-only `*_API_KEY` scrub,
`--ignore-user-config`, the pinned `gpt-5.5`/`xhigh`) and **restates the full posture via `-c`** —
because `codex exec resume` resets the sandbox/approval/network posture and rejects `-s`/`--add-dir`/`-C`,
the wrapper passes `-c sandbox_mode=workspace-write -c approval_policy=never -c
sandbox_workspace_write.network_access=false` explicitly. A resume takes no passthrough flags and an
empty resumed instruction is rejected. Prefer resume over re-dispatching a fresh run when you are
iterating on the same task; start a fresh `codex-exec` when the task changes.

## The commit boundary & the git-write shim

- **Repo edits** are codex's job *inside* `codex-exec`'s workspace-write sandbox — but you **review the
  diff** before accepting/committing it. `codex-review` makes no edits at all (read-only sandbox).
- **Git writes** (branch/add/commit/stash/reset/checkout/tag/rewrite) are never delegated. Beyond the
  prompt contract, `codex-exec` prepends a physical **git-write shim** to the codex subprocess's
  `PATH`: a `git` wrapper file that passes read-only verbs through to the real git and **blocks every
  write/unknown verb** (codex spawns `git` via `execve`, which bypasses shell functions, so the
  boundary must be a real executable; the real git path is baked into the shim, not exposed as an env
  var). `git config` is read-only too (blocked on a write flag or a `<name> <value>` set form). The
  orchestrator commits after review.
- **New dependencies / network installs** are done by hand (exec has network OFF), then codex is
  re-dispatched.
- **A hung run** is killed at `CODEX_HARD_TIMEOUT` (exec 3600s / review 1800s) and reported (exit
  124/137); raise it for a known-healthy slow run.

## Prompt shapes (for ad-hoc `codex-exec -` instructions)

```text
Implement the change below from the current project root.
Obey root AGENTS.md (already in your context), especially its Hard Constraints and declared gates.
Do not run git write commands. Do not commit.
If a dependency install, network call, missing gate set, or out-of-repo write is needed, STOP and report.

<the focused instruction + relevant paths>
```

The review prompt shapes are built into `codex-review` itself — you only pass `plan <file>` or
`code [focus]`; the wrapper supplies the assembled diff + the severity-tagged-findings + verdict
directive (or the JSON-schema directive when `CODEX_REVIEW_SCHEMA=1`).

## Handling output

codex output is advisory. Before acting:

- Re-run the project's gates yourself; don't trust a "green" claim you didn't see.
- Inspect the diff yourself; check edits against the project's `AGENTS.md` rules.
- Reject advice that conflicts with user instructions, repository rules, or security boundaries.
- Report uncertainty clearly, and summarise only verified claims back to the user.

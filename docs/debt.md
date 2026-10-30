# Debt queue

Rows queued out of a review round instead of folded. Each carries a stable id the flow store's
`queued` disposition binds to. A row leaves this file only when the work lands.

- **JEV-SANDBOXED-WRAPPER-NEEDS-NO-USER-STEP** — invariant: a delegated run reaches Jev with no hand settings edit by
  the user. Origin: on 2026-10-06 Claude Code 2.1.291 ran an agent's plain `codex-review` inside its sandbox although
  the project lists it in `excludedCommands`. The hosts closed with AD-172 (kit 14.24.0), the state dirs and the
  `<wrapper> *` exclusions with story S2 of BRIDGES-WORK-UNDER-THE-SANDBOX: `velocity-profile --bridge-tier` seeds
  the used bridges' hosts into `sandbox.network.allowedDomains` and their state dirs into
  `sandbox.filesystem.allowWrite` on the upgrade's chat yes (spec velocity-profile). What stays: the no-step route —
  a harness that keeps an excluded wrapper sandboxed still needs that consented step. The fix launches the wrappers
  outside the Bash sandbox (e.g. through the kit's MCP server), a story, since it routes around a sandbox an admin may
  mandate. Proof, the only one that closes the row: a sandboxed agent's plain `codex-review` gets a Jev answer with no
  settings step at all.
- **BRIDGE-TIER-FLAGLESS-READS-NO-MANIFEST-UNPINNED** — invariant: a flagless or `--kit-tools` velocity run reads no
  bridge manifest. Origin: spec velocity-profile S4 pins the manifest STOP only on `--bridge-tier`; the advisor's
  core plan has no catch (`agent-workflow-kit/tools/recommendations.mjs:446-449`), so a manifest read on every mode
  would turn a broken bundle into a crash there. Narrow fix: one cell running the flagless and `--kit-tools` writer
  over an unreadable bundle root with today's result. Raised by the S11 spec review (lens).
- **BRIDGE-TIER-ADVISOR-ON-WRONG-TYPED-NETWORK-KEY-UNPINNED** — invariant: a wrong-typed project network key or an
  unreadable manifest makes the Recommendations bridge-tier item a stated skip, never an offer the apply refuses.
  Origin: the shared velocity preflight takes no flag (`agent-workflow-kit/tools/velocity-profile.mjs:903`), so where
  the S11 network check lives decides the advisor's outcome (`recommendations.mjs:435-442,458-465`), and spec
  velocity-profile does not pin it. Narrow fix: one advisor cell over `allowedDomains: "<string>"` expecting the skip
  line. Raised by the S11 spec review (lens, round 2).
- **BRIDGE-TIER-S1-ZERO-HOSTS-COUNT-UNPINNED** — invariant: with no bridge placed a `--bridge-tier` run prints no
  `allowedDomains` count line. Origin: `agent-workflow-kit/tools/velocity-profile.test.mjs:1114` asserts no match on
  `entries: [1-9]`, which an `entries: 0` line passes; the code gates the three lines on `hostsToAdd +
  hostsAlreadyPresent` (`agent-workflow-kit/tools/velocity-profile.mjs:663`). Narrow fix:
  `assert.equal(listedHosts(r.stdout), undefined)`. Residual: not live, the line is not printed today. Raised by the
  S11 diff review (lens).
- **VELOCITY-PREFLIGHT-REFUSES-A-SETTINGS-AUTO-MODE** — invariant: a project whose settings run the harness in auto mode
  gets the apply ask rule like any other. Origin: the velocity preflight stops on any `permissions.defaultMode` outside
  `SAFE_DEFAULT_MODES` in either project settings file (`agent-workflow-kit/tools/velocity-profile.mjs:853`,
  `isUnsafeMode`), and the gate-hook preflight reads the same judgement through `resolveEffectiveMode`
  (`agent-workflow-kit/tools/gate-hook.mjs:289`), so admitting `auto` reaches beyond this writer. Narrow fix: none in
  story S7 of BRIDGES-WORK-UNDER-THE-SANDBOX (a non-goal of its plan); such a project's user takes the one plain step on
  each auto-mode refusal. Proof when one lands: a velocity apply on a project with `defaultMode: "auto"` seeds the rule
  and the gate-hook preflight's verdict on it is unchanged. Residual exposure, live and stated: that project never gets
  the rule; an `auto` in the user scope stops nothing.

- **JEV-KEY-IN-EVERY-DELEGATED-RUN** — invariant: a delegated run's environment carries no secret its task does not
  use. Origin: the shared key rule `aw_scrub_billing_keys` (every bridge wrapper, spec jev-every-run) passes
  `TYPESAFE_API_KEY` into every codex and agy run, its task needing Jev or not, and codex's server-side `web_search`
  reaches pages outside the permissions profile `jev` (P9), so the key sits beside a channel the profile does not
  bound (R2.17). Narrow fix: none today — the maintainer ruled Jev into every run (R1, R2, 2026-10-05), and both
  SKILL.md paragraphs state the residual. Proof when one lands: a run whose task names no Jev step sees no key, or a
  `web_search` run that cannot read the environment. Residual exposure, live and stated: a prompt-injected page
  reached through `web_search` could ask the delegate to send the key elsewhere; the profile refuses every host but
  `api.typesafe.ai` and `docs.typesafe.ai` for a command, not for the server-side tool. Raised by the S10 spec review.
- **JEV-S10-S23-TABLE-CELL-BLIND-SPOT** — invariant: no shipped bridge page states codex's network as forced off
  without naming the fallback. Origin: `agent-workflow-kit/test/jev-every-run.test.mjs:115`, `NETWORK_OFF` needs the
  word "network" beside OFF, so a Markdown table cell (`| OFF (we force it off) |` under a `Network?` column) never
  matches; the S10 diff review found such a row in `codex-cli-bridge/references/sandbox-and-flags.md` and fixed the
  text. Narrow fix: the S23 sweep also reads each table row with its column header. Proof: a cell `OFF` under a
  `Network?` header fails S23. Residual exposure, not live: no shipped page carries such a cell today. Raised by the
  review lens at the S10 diff review (2026-10-05).
- **JEV-S10-PROFILE-SUITES-UNDER-TMP** — invariant: the profile suites pass wherever the checkout lives. Origin:
  `codex-cli-bridge/bin/codex-exec-jev.test.mjs:16` and `codex-model-posture.test.mjs` build fixture repos under
  the checkout, so a checkout under `/tmp` takes the correct temp-root fallback and the profile cells fail. Narrow
  fix: place the profile fixtures by a temp-root-free path the suite chooses, or skip with a stated reason. Proof:
  the suites pass from a checkout under `/tmp`. Raised by codex at the S10 release review (2026-10-06).
- **JEV-S10-EXIT-72-DROPS-NESTED-SANDBOX-HINT** — invariant: a nested-sandbox failure always prints its recovery
  hint. Origin: `codex-cli-bridge/bin/codex-exec.sh:1707`, the exit-72 branch on `bwrap: execvp … Permission
  denied` returns before `aw_scan_nested_sandbox`, so the earlier diagnosis and its recovery lane are not printed.
  Narrow fix: run the nested-sandbox scan before the exit-72 return. Proof: a fake trace with that line exits 72
  and prints the recovery hint. Raised by codex at the S10 release review (2026-10-06).
- **CODEX-CATALOG-EMPTY-EFFORTS-REMEDY** — `codex-cli-bridge/bin/codex-exec.sh:1054` and
  `codex-review.sh:487` split the catalog parser's answer with `IFS=$'\t' read`; TAB is IFS
  whitespace, so an empty field collapses. An effective entry with `supported_reasoning_levels: []`
  sends `effort<TAB><TAB><slug><TAB><level>` and the refusal prints `offered: <slug>` and the remedy
  `CODEX_MODEL=<level>` / `CODEX_EFFORT=` (spec bridge-model S9 wants the default or one whole
  entry). The refusal itself is right. Narrow fix: a `\x1f` separator in the parser's join and the
  `IFS`, or an empty array read as unreadable like an absent one; one cell in
  `codex-model-posture.test.mjs`, mirrors synced. Raised by codex and the review lens at the S1 diff
  council (2026-10-03); the shape is one codex does not ship.
- **AGY-REVIEW-HARNESS-SANDBOX-LEAK** — `makeSandbox` in
  `antigravity-cli-bridge/bin/agy-review-harness.test.mjs:188` creates an `agy-review-test-*` dir
  under `tmpdir()` that nothing removes (the `after` hook at :161 removes only the shared root), so
  every suite importing it — `agy-model-posture.test.mjs:34` included — leaves one directory per
  cell. Narrow fix: create sandboxes under `SHARED_ROOT`, or register each `home` for removal in the
  harness. Raised by codex at the S1 diff council (2026-10-03).
- **CODEX-EXEC-ACCOUNTED-LANE-COMMENT** — the section comment at `codex-cli-bridge/bin/codex-exec.sh:682`
  says "everything below fires only for a NONCED run", but the catalog check (:998-1070) sits below it
  and runs on every invocation. Comment-only; move the catalog block above the section header or
  scope the sentence to the mint core. Found while folding the S1 diff council (2026-10-03).
- **POSTURE-READ-NUL-IS-SILENT** — `aw_read_posture` (the shared settings span, e.g.
  `codex-cli-bridge/bin/codex-exec.sh:279`, byte-identical in all four wrappers) reads the line with
  `grep "^${key}=" "$file"`; a NUL anywhere in the settings file switches GNU grep to binary mode, no
  line comes back, and the model key silently takes the default — spec bridge-model S17 wants a
  warning for a control byte. Narrow fix: a separate NUL check on the file before the read (bash
  drops NUL bytes in a command substitution, so the value screen can never see one) that warns once
  and keeps the default; a cell per bridge suite, the parity span kept byte-identical. Raised by codex at the S1 diff council round 2 (2026-10-03).
- **POSTURE-SUITES-ASSUME-TIMEOUT-BINARY** — `codex-cli-bridge/bin/codex-model-posture.test.mjs:13`
  and `antigravity-cli-bridge/bin/agy-model-posture.test.mjs:14` resolve only `timeout`; on a host
  with only `gtimeout` (macOS + coreutils) `REAL_TIMEOUT` is empty and the fake-timeout cells `exec ""`.
  Narrow fix: resolve `timeout || gtimeout` and skip the bounded-read cells when neither exists.
  Raised by codex at the S1 diff council round 2 (2026-10-03).
- **POSTURE-KIND-ADMITS-LINE-SEPARATORS** — the `posture` kind (`agent-workflow-kit/tools/manifest/validate.mjs:59`)
  refuses only edge whitespace, so `--set 'AGY_MODEL=Bogus<U+2028>X' --apply` passes; `KEY_LINE_RE`'s `(.*)$`
  (`bridge-settings-read.mjs:27`) cannot cross U+2028, the judgment then sees no key, judges the default and writes an
  unoffered model (the wrappers' `grep` reads it and refuse every run). Narrow fix: the kind refuses
  `[  ]`, and `KEY_LINE_RE` reads `([^\n]*)` as grep does; one S7 cell. Raised by the review lens at the
  S2 diff council (2026-10-03). Same class: `hasControlByte` (`bridge-settings-read.mjs:166`) misses NUL, so a
  hand-edited `CODEX_MODEL=x<NUL>` file line reads `[setting]`, prints the raw NUL and refuses a later
  `--set CODEX_EFFORT`, while the wrappers' grep sees a binary file and runs the default; fix `[\x00-\x1f\x7f]`
  for the posture lane (raised by the lens at round 2).
- **CATALOG-LOOKUP-PATH-DIFFERS-FROM-WRAPPER** — `agent-workflow-kit/tools/bridge-catalog.mjs:56` resolves `agy` on
  the caller's PATH only, while `agy.sh:66` and `agy-review.sh:567` put `$HOME/.local/bin` first: with `agy` only
  there the read-out says "not installed" and a set goes unchecked; a second `agy` earlier on PATH is read instead.
  The lookup also ignores PATHEXT, so a native-Windows `codex.cmd` reads "not installed". Narrow fix: for agy,
  prepend `$HOME/.local/bin` to the lookup and the child's PATH. Raised by the review lens at the S2 diff council.
- **CATALOG-BOUND-WAITS-FOR-CLOSE** — `bridge-catalog.mjs` settles a timed-out read only on `'close'`; a descendant
  that left the process group (setsid) and holds stdout survives both kills and the read never settles (the
  wrapper's `$(timeout …)` hangs the same way). Narrow fix: the SIGKILL timer also destroys `child.stdout` and
  finishes `unreadable`. Raised by the review lens at the S2 diff council.
- **CATALOG-EFFORT-PARSE-DIVERGES** — `bridge-catalog.mjs:31` adds `l.effort !== ''`, which the wrappers'
  `effortsOf` (`codex-exec.sh:1034`, `codex-review.sh:468`) lacks: an entry with an empty effort reads "efforts
  unknown" in the kit (a set goes unchecked) and a list in the wrapper. Narrow fix: one rule in all three copies.
  Raised by the review lens at the S2 diff council.
- **POSTURE-RENDER-FOLDS-WHITESPACE** — `agent-workflow-kit/tools/bridge-posture.mjs:21` shows a posture value
  through `oneLine()`, so a value with a non-breaking or doubled space renders like the offered default while the
  wrapper passes the raw string and refuses it. Display only. Narrow fix: show the raw value JSON-escaped when it
  differs from `oneLine(value)`. Raised by the review lens at the S2 diff council.
- **POSTURE-SNAPSHOT-DROPS-REFUSAL** — `agent-workflow-kit/tools/bridge-settings-read.mjs:260` keeps no note in the
  snapshot's posture rows, so a control-byte env `CODEX_MODEL` renders `model=none (environment)` while the
  wrappers refuse the run. Display only. Narrow fix: carry a refused flag and render the refusal; keep `none` for
  an explicitly empty `AGY_MODEL`. Raised by codex at the S2 diff council (2026-10-03).
- **POSTURE-KIND-HEADER-COMMENTS** — `agent-workflow-kit/tools/bridge-settings.mjs:7-8` and
  `agent-workflow-kit/tools/manifest/validate.mjs:39-42` say every value the writer accepts passes the wrappers'
  `aw_settings_valid`; for the `posture` kind that function has no case (`*) return 1`, `codex-exec.sh:211`, the
  span byte-identical in all four wrappers) — the wrappers read those keys through `aw_read_posture` (non-empty, no
  control byte). Comment-only, no run-time effect. Narrow fix: scope both sentences to the applied kinds and name
  `aw_read_posture` as the wrapper side of `posture`. Raised by the review lens at the S2 attestation round.
- **STORY-FLOW-STEP-FIELDS-EQUAL-FLOW-STEPS** — invariant: every field of `planning.md`'s `## The story flow`
  step list states no less than the contract part `docs/ai/specs/kit/tier/story-flow/flow-steps.md`. Origin:
  `agent-workflow-engine/references/planning.md:11-51` (records after the review, repair runs, "Bridges"). Narrow
  fix shipped in the S1 diff review round 1: the three sentences, red first in `story-flow-canon.test.mjs` (S1).
  Proof: that cell. Residual exposure, not live: a later edit of another field (Epic, Spec, Plan) drifting from
  flow-steps; the S1 cell checks field labels only. Raised by the review lens and codex (2026-10-04).
- **BRIDGE-SETTINGS-COMMENT-NAMES-THE-RETIRED-LENS-POSTURE** — invariant: no comment names a posture or module the
  kit has retired. Origin: `agent-workflow-kit/tools/bridge-settings.mjs:150` likens a preserved settings key to "the
  lens-region custom-edit posture", and `agent-workflow-kit/tools/script-priors.mjs:6` names "the lens-region idiom";
  the posture retired with story S7 of DISTRIBUTION-FILES-STAY-CURRENT and the module `lens-region.mjs` with kit
  20.0.0 (AD-216). Comment-only, no run-time effect. Narrow fix: drop the parenthetical and name the idiom by what it
  does. Raised by the S7 spec review; restated at the KIT-TEXT release.
- **STORY-FLOW-S5-DOCS-PATH-SELF-CHECK** — `agent-workflow-kit/test/template-region-parity.test.mjs:180` proves
  "reads nothing under docs/ai" only by its own source lacking the literal `docs/ai`; a path built from segments
  passes. Narrow fix: refuse any quoted `docs` path segment in the source. Raised by the review lens (2026-10-04).
- **PLAN-AUTHORING-STEP2-SUBAGENT-DRAFTS-THE-PLAN** — `agent-workflow-engine/references/procedures.md:31-33`: the
  Subagent author carrier "drafts the plan and any create / modify spec row", while `planning.md`'s Plan step
  names the orchestrator as the plan's maker. Narrow fix: the carrier drafts the contracts, the orchestrator the
  plan beside them; `procedures-canon.test.mjs:393` follows. Raised by the review lens (2026-10-04).
- **STORY-FLOW-CANON-TOKEN-CHECKS** — `agent-workflow-engine/test/story-flow-canon.test.mjs` checks S1-S3 by
  tokens: a second `Check:`, an eighth step bullet, "at least two" rounds or a plan review worded outside
  `/plan[- ]review/` (the lens suite's wider `PLAN_REVIEW_RE`) still pass. Narrow fix: compare normalized step
  blocks with literals, count the bullets, share the wider regex. Raised by codex and agy (2026-10-04). The same
  holds in `procedures-canon.test.mjs` S11 (`:433`, only the word maintainer: "a fold not accepted closes the
  review" passes), S12 (`:440`, "every member, the lens excluded" still matches), S15 (`:459`, a plan-mode bridge
  worded otherwise passes) and `lens-fragment.test.mjs` S4 (`:120`); invariant: each cell pins its normative
  clause as a normalized literal (the S5 method), never an added case. Raised by codex and the review lens at the
  S1-S3 diff review (2026-10-04).
- **STORY-FLOW-S3-CANON-RESIDUALS** — invariant: `procedures.md` names only steps the flow runs and every
  disposition the story-flow review-loop part gives. Origins and narrow fixes: (1) `agent-workflow-engine/references/
  procedures.md:101` step 2 still says "before `flow-writer adoption` on an armed flow" — drop the clause, keep the
  robustness-brief sentence; (2) `procedures.md:123-125` gives no route for a maintainer ruling that keeps a vetoed
  change — add the contract's sentence: the change commits only after a fresh grounded code-mode run of each
  vetoing bridge, the ruling in its decided register, returns ship-class; (3) `procedures.md:78-79` step 6 runs the
  readers sweep after the last round — the sweep runs over every name a fold changes before that fold's ask, and
  step 6 only checks the shape. Proof: one `procedures-canon.test.mjs` cell per item. Residual exposure, not live:
  (1) the conditional names a verb the flow never runs, the contract's stated flow-writer residual; (2)
  `commit-guard` refuses the veto receipt, so nothing commits unreviewed; (3) a row step 6 adds reaches the
  maintainer's approval and its code the diff review. Raised by the review lens at the S1-S3 diff review
  (2026-10-04).
- **STORY-FLOW-SPLIT-BRIEF-BASE** — invariant: every changed test path is listed, and a red run is owed only by a test
  whose change adds or tightens an assertion. Origin: `agent-workflow-engine/references/procedures.md:125-128` and
  the brief sentence of the contract part `review-loop.md` list tests from `git diff --cached --name-only <recorded
  tree>`, each with its red run, while a split (`planning.md:54-56`) records no tests-session tree. Narrow fix, canon
  and contract together: "...every test path shown by `git diff --cached --name-only <base>` (the tree the tests
  session recorded; for a split, the base of the diff) ..., each with its text before and after and its scenario
  line, and each that adds or tightens an assertion with its red run; ...". Proof: the procedures-canon S12 cell at
  `:440`, its two C1 patterns replaced by the new base and the red-run-on-an-added-or-tightened-assertion clause.
  Residual exposure, not live: a split adds no case, so its moved tests have nothing to prove red. Raised by the
  review lens at the S1-S3 diff review round 2 (2026-10-04).
- **STORY-FLOW-S2-CANON-TEST-PATTERNS** — `agent-workflow-engine/test/task-wave-canon.test.mjs`: the S11 pattern
  `/\brestore <oid> --nonce\b/` misses a nonced restore without the `<oid>` literal; `RETIRED_COMMANDS` refuses
  `dispatch open|return` but not a bare `dispatch` verb; `planning-canon.test.mjs` S7's ordered loop advances by
  the match start, not its end. Narrow fix: widen to `/\brestore\b.*?--nonce\b/`, add
  `/\bdispatch\s+(?!contract\b)/i`, advance past the match. Raised by agy at the S2 diff review (2026-10-04).
- **STORY-FLOW-S8-PROMPT-AND-ACCEPTANCE-CLAUSES** — `agent-workflow-engine/test/task-wave-canon.test.mjs:44-45,65`:
  the S8 prompt tokens (`prompt`, `one … row`, `file`) match anywhere in The task, so "one prompt file for the rows
  of a hand-out" passes; the acceptance pin matches "was interrupted or returned no edit" alone, so "is accepted:"
  passes. Narrow fix: `/The orchestrator writes one prompt file from one ledger row/` replaces the three tokens; pin
  the whole "A run whose tests answer otherwise, or that was interrupted or returned no edit, is not accepted:".
  Raised by the review lens and codex at the S2 diff review round 2 (2026-10-04).
- **SLOTS-NO-STEP-READS-STILL-RENDER-A-BRIDGE** — invariant: no surface renders a bridge run for a slot no flow
  step reads: `epic.review` (the lens reviews every epic whatever it resolves to, story-flow S15, S17) and
  `task.author` (the orchestrator writes each row's prompt, task-run). Origin: a silent `epic.review` takes the
  computed `reviewed` (`agent-workflow-kit/tools/recipes.mjs:265-266`), so `recipes --active-line` prints
  `epic.review = reviewed (computed default) → codex-review` (`recipes-shorthand.test.mjs:28`) and `status` prints
  `epic.review: reviewed (default)` (`family-registry.test.mjs:1114`); `orchestration-readme.mjs:74` and the seed
  `references/templates/orchestration.json:2` say it "is reviewed as soon as a review backend is ready"; the tier
  offer previews `epic.review = reviewed` (`tier-preview.test.mjs:92`; since KIT-DEFAULT-POSTURE S1 its
  `task.author` previews `subagent`, no bridge); a delegated
  `task.author` renders `→ codex-exec` in the active line (`recipes-shorthand.test.mjs:47`) and the codex-exec
  driving contract under `procedures task` (`procedures.mjs:168`, pinned by `procedures-roster.test.mjs:191`).
  Narrow fix: those surfaces render `epic.review` as the lens review and `task.author` as the orchestrator's prompt,
  and the README default sentence says so; the slot keys and accepted values stay. Proof: a recipes-shorthand cell,
  a procedures-roster cell and a tier-preview cell. Residual exposure, not live: display only, no step dispatches
  either slot. Recorded by the S3 spec review and the release copy pass (2026-10-04).
- **STORY-FLOW-S5-SPEC-REVIEW-MINORS** — nine minors of the S5 spec review round 2 (2026-10-05), none folded; each
  checked against the staged code. Live: (1) `agent-workflow-kit/tools/tier-guide-facts.mjs:194-196` carries only
  the row before the first gap, so prompts written in a batch get the stage line of the last row alone (agy); narrow
  fix: S4's stage line covers every LEDGER ROW (`git add` is idempotent), or guide-stages states the limit. (2)
  `tier-guide-facts.mjs:257-259`: an E3 or E4 epic without a leftover renders no action and no story while another
  epic has one, with no line saying why (lens); narrow fix: a fact naming the epic that holds the leftover. (3)-(5)
  `docs/ai/specs/kit/tier/tier-guide/index.md:110` (S6): "reaches the close" while the walk goes on to the close
  commit and the refused second close (agy); "write the file the stage names" while the landing and close-commit
  steps stage and commit (lens); the walk's own staging of the epic (`agent-workflow-kit/test/tier-walk-e2e.test.mjs:91,99`)
  is neither a printed tool step nor an authoring step (lens); narrow fix: S6 names the walk's end state, "carry out
  the write action the stage names", and admits the epic's staging under that write action. (6) `index.md:44` says
  the guide spawns only two git queries while S7 (`agent-workflow-kit/tools/tier-guide.test.mjs:101`) proves
  read-only by hashes alone, so a third query passes (lens); narrow fix: an S7 cell counting spawned git calls
  through a PATH shim, or the bullet drops the count. Not live after the cut (kept for the record): (7) a row on a
  git-ignored path outside `docs/ai/` (agy) is the stated limit of guide-stages's LEDGER ROWS; (8) the two-epic
  leftover printing the removal (lens): with the index differing the state carries no action and both entries
  none (`tier-guide-facts.mjs:218-225`); (9) E4 handing to E5 after the last removal (lens): E4 renders the
  leftover first, then the close (`tier-guide-facts.mjs:257`). Proof: one cell per live item in its suite.
  Known live exposure: for (1), a story whose prompts went out in one batch gets the stage line of its last row
  alone, so its one commit misses the earlier rows' paths unless they are staged by hand or the diff read catches
  them; the rest is display and contract wording; the walk and every guided line pass. Raised by agy and the review
  lens at the S5 spec review.
- **STORY-FLOW-S5-DIFF-REVIEW-TEST-PINS** — invariant: each tier-guide cell pins the exact actions its scenario
  states; the code is right today. (1) `agent-workflow-kit/tools/tier-guide.test/states.test.mjs:79`: the
  index-refusal cells exclude only the diff and commit commands, so a removal printed after a refused index read
  passes; fix: no action at all after a refused read. (2) `agent-workflow-kit/tools/tier-guide-facts.test.mjs:25`:
  `REMOVAL` never pins which prompts the removal names, so a removal naming "none on disk" beside a prompt on disk
  passes; fix: the named list per cell. (3) No cell stages a path that needs quoting, so an unquoted `row.path`
  (`tier-guide-facts.mjs:60-62`) passes; fix: one S4 cell with `src/my greet.mjs` (the stage line `git
  --literal-pathspecs add -- 'src/my greet.mjs'`). The sweep half landed at the release review: cell `S4-sweep`. Proof: each cell fails on the walk-around it names.
  Residual exposure, not live: the code quotes, filters and refuses as stated. Raised by codex and the review lens
  at the S5 diff review (2026-10-05).
- **STORY-FLOW-ADVISOR-ROUND-2-LABEL** — invariant: the advisor and the bridges state one round two (the canon's,
  `agent-workflow-engine/references/procedures.md:63-66`: every member gets the folded artifact whole, which a
  `--continue` delta cannot carry) and label
  `--continue` as the resume lane the fold ask rides. Origin: `agent-workflow-kit/tools/procedures.mjs:588` prints
  `round-2 delta (resume — never re-send the reviewed artifact):` over each bridge's `continue` descriptors;
  `agent-workflow-kit/README.md:240` and `agent-workflow-kit/tools/commands.mjs:211` repeat it; the label is the
  bridges' own too (`antigravity-cli-bridge/capability.json`, `bin/agy-review.sh`). Narrow fix, with a bridge release:
  the bridges' help and the advisor line read "resume lane (the same session: the fold ask, or a fold of code a bridge
  wrote; round two of a review is a fresh run over the folded artifact whole):", README and the catalog line "resume
  lane". Not folded alone: the wrapper's own `--help` heads the same descriptors `Round-2 / resume:` with "a
  continuation sends a small delta" (`antigravity-cli-bridge/bin/agy-review.sh:109-112`), so an advisor-only edit
  leaves the kit's bundled bridge naming a second round two. Proof: a procedures cell pinning the label beside a
  bridge help cell. Residual exposure, live, one run or one weaker round: an orchestrator following the label runs
  agy's round two as `--continue`; in the diff review its continuation receipt never satisfies `review-state`
  (`review-state.mjs:47-49`), so nothing commits unreviewed and one run is lost; in the spec review agy judges the
  delta against the round-one artifact it holds (`agy-review.sh:112`) while the other members read the folded
  artifact whole. Raised by the review lens at the release review (2026-10-05).
- **TIER-GUIDE-EPIC-REVIEW-AS-THE-LENS** — invariant: the guide renders the epic's review once per epic, before its
  first story, as the lens read; the user's own reading is the stated degrade when no lens runs
  (`agent-workflow-engine/references/planning.md:15-17`, `procedures.md:213-216`, kit `README.md:255`,
  `references/modes/agents.md:11`). Origin: `agent-workflow-kit/tools/tier-guide-facts.mjs:53`, rendered at `:167`
  and `:170` for every story without a plan: "read the review brief of the epic <path>; the solo review is the
  reading of it". Narrow fix, contract and code together (`guide-stages.md:114-116` and `tier-walk.md:69` pin the
  current wording): `:53` reads "read the review brief of the epic <path>: the review lens reads it, once per epic
  before its first story; in the solo walk you read it yourself and state that no lens ran", rendered only before
  the epic's first story. Proof: an S1 cell where a second story of the epic renders no review step. Residual
  exposure, live, display only: every story's first stage names the epic review a solo review instead of the lens
  read or its stated degrade, and each later story re-reads the brief; nothing commits on it. Raised by the review
  lens at the release review (2026-10-05).
- **TIER-GUIDE-ONE-RELEASE-OF-SEVERAL-STORIES** — invariant: the canon and the tier guide state one rule for stories
  of one release. Origin: `agent-workflow-kit/tools/tier-guide-facts.mjs:257-259` renders no other story while a
  landed story's leftover stands and prints its own `git commit` first (`:230-233`), while
  `agent-workflow-engine/references/procedures.md:115-117` and `:156` (contract `review-loop.md:24-25,90`) let
  stories of one release stage together and share one commit. Narrow fix, one of: `tier-guide.mjs:52` adds "(a
  release that stages several stories together is walked by the canon, not this guide)" with tier-guide S1 and its
  contract; or the canon scopes the several-stories release. Proof: the tier-guide S1 cell pins the sentence.
  Residual exposure, not live: a per-story commit from HEAD is legal under the canon, so a guided user never commits
  unreviewed; the guide only cannot walk the one-commit release. Raised by the review lens at the release review
  (2026-10-05).
- **INIT-DOCTOR-VERIFY-VERDICT-AFTER-INSTALL** — invariant: a doctor verify verdict printed after its
  `install completed` line is shown, never a failed apply (spec kit/install/init-project, "Order and consent").
  Origin: `agent-workflow-kit/tools/init-project.mjs` apply success test accepts only exit 0, or exit 5 with
  `install completed`; the verify lane can also end 3 (`renderOffer`, `autonomy-doctor.mjs:306`) or 6 after it.
  Narrow fix: a valid exit whose stdout carries `install completed` is applied-and-shown, with an S11 cell for exit 3
  after `install completed`. Proof: that cell. Residual exposure, not live: the install itself completed; only the
  later variants of that batch are left unapplied and named, and the next `init` previews them again. Raised by the
  review lens at the S13 diff review, round 1 (2026-10-07).
- **INIT-RECORD-READDIR-REFUSAL** — invariant: every read `init`'s consent record depends on fails into its named
  refusal (`not applied: <variant> — <path> could not be read: <code>`), never an uncaught throw. Origin:
  `agent-workflow-kit/tools/init-project.mjs` readEntries calls readdir with no catch; it runs from collectPaths in the
  mask scan (outside any try) and in takeRecord before its try, so a recorded directory lstat sees and readdir refuses
  (`EACCES`) ends `init` with a stack trace before the key line; two more callers, outside any try, read after an apply
  wrote: refreshWrites (`init-project.mjs:140`) reads a written directory, and runPass's restart check
  (`init-project.mjs:288`) runs collectPaths again after the batch. Narrow fix: readEntries answers `[]` when readdir
  throws, so the directory's own record key is named by the refusal before any preview; a batch cell with a mode-000
  `.claude/hooks`. Proof: that cell. Residual exposure, not live: the mask scan throws before any write; takeRecord
  can throw after the key line saved the key, or in the second pass after the first pass's applies; on refreshWrites
  the throw comes after that apply wrote and leaves the later variants unapplied and unnamed; on the restart check it
  comes after the batch and drops the restart line and the second pass; the read can fail in any repository git
  accepts, a mode-000 directory of the current user included. Raised by the review lens at the S13 diff review, round
  2 (2026-10-07).

- **INIT-LISTS-ONLY-USER-ITEMS-UNDER-ARGV-SELECTION** — invariant: `init` lists, besides its previewed variants, only
  the user-lane variants with no argv, never a pending chat item. Origin: under argv-presence selection every chat
  variant answers no argv (`agent-workflow-kit/tools/write-lanes.mjs:172`), so the spec init-project sentence "a
  pending variant with no argv is listed with its text" would list chat items (`init-project.mjs:185`, `:233-235`).
  Narrow fix: name the listed set in the root's Order-and-consent bullet. Raised by the S1 spec review (lens 12).
- **DANGER-CHECK-USAGE-EXITS-INCOMPLETE** — invariant: every malformed invocation of the danger check exits 2 with
  nothing read. Origin: the part apply-danger-check's exit table names no exit for a missing `--variant`, a missing
  `--cwd` or a relative `--claude-dir` (jev-skill rejects a relative dir, `agent-workflow-kit/tools/jev-skill.mjs:49-50`).
  Narrow fix: the three join exit 2 and S23. Raised by the S1 spec review (lens 14; agy round 2, minor 2).
- **DANGER-CHECK-DIGEST-BINDS-WRITTEN-BYTES-UNPINNED** — invariant: the bytes an apply writes are the bytes whose sha256
  the user saw. Origin: S22's real-apply cell compares settings diffs and changed paths, not the printed `writes: …
  sha256:` values with the written bytes (`agent-workflow-kit/tools/gate-hook.mjs:343`, `cheap-agents.mjs:203`), and no
  cell changes a planned file's content between check and apply. Narrow fix: compare the hashes, and one cell changing
  the content after the check expects exit 5 with nothing spawned. Raised by the S1 spec review (codex round 2, minor 2).
- **DANGER-CHECK-EXIT-3-SPAWNS-NOTHING-UNPINNED** — invariant: no exit of the danger check other than an equal digest
  spawns a writer. Origin: S23 names nothing spawned on 1, 2 and 5, not on 3 (a writer's dry-run refusal or a masked
  file). Narrow fix: S23 reads "1, 2, 3 or 5". Raised by the S1 spec review (agy round 2, minor 1).
- **DANGER-CHECK-TYPESAFE-PREFIX-LITERAL** — invariant: the danger check keeps the jev word-surface rule. Origin: the
  part prints `temporary: <parent>/.typesafe-ai.kit-tmp-*`; the prefixes are private to jev-skill.mjs (:22-23) and the
  surface rule (jev-guide S12, `agent-workflow-kit/tools/jev-guide.test/surface.test.mjs:18`, `:257`) refuses a line
  carrying the word outside a jev key or leaf. Narrow fix: derive the prefix from the `typesafe-ai` basename of
  skillTargets' path, or export the prefixes from the facts leaf. Raised by the S1 spec review (lens round 2, minor 5).
- **APPLY-SLOT-DIGEST-SUFFIX-QUOTING** — invariant: the slot's apply line ends in the literal ` --apply --expect
  <digest>`. Origin: the part write-lanes says each element after `node` passes through `quoteArg`, which would render
  `'<digest>'` (`<` and `>` are outside its safe set, `agent-workflow-kit/tools/jev-facts.mjs:16-17`). Narrow fix: quoteArg
  builds the check line; the suffix is literal. Raised by the S1 spec review (lens round 2, minor 6).
- **DANGER-CHECK-CREATED-DIR-TWO-PRINT-FORMS** — invariant: each path the check prints has exactly one line form. Origin:
  the part apply-danger-check prints a created directory as `writes: <dir>/ created` (scope bullet) while the result
  bullet prints "every other file or directory it would create or replace" as `writes: <path> sha256:<hex>`, so
  cheap-agents creating `.claude/agents` (`agent-workflow-kit/tools/cheap-agents.mjs:197`) matches both. Narrow fix: the
  result bullet reads "every other file, and each directory it fills whole". Raised by the S1 re-read (lens).
- **DANGER-CHECK-IN-INIT-READS-PROCESS-ENV** — invariant: `init`'s in-process check judges the environment its spawned
  writers get. Origin: `findOnPath` reads `process.env` (`agent-workflow-kit/tools/velocity-profile.mjs:241`) while
  init spawns writers with `deps.env` minus the GIT_* variables (`init-project.mjs:160`, `:337-339`); equal in
  production, different in every batch cell; outside a project the check of either Jev variant (`jev-skill` and, from
  story S17, the kit item `jev-skill.not-current`) has no root. Narrow fix: `checkApply` derives `findWrapper` and `env`
  from `facts.env` and takes root null for both Jev variants. Raised by the S1 spec review (lens 16).
- **JEV-CONNECT-USER-STEP-WIN32-QUOTING** — invariant: a user step printed for the user's own terminal is quoted for
  that terminal. Origin: the part write-lanes quotes the jev-connect user step with `quoteArg` on every platform, while
  on win32 the place is a PowerShell terminal and `connectLine` has a PowerShell form
  (`agent-workflow-kit/tools/jev-facts.mjs:17`, `:22-24`). Narrow fix: on win32 the user step uses `connectLine`'s form.
  Residual: native Windows is unmeasured. Raised by the S1 spec review (lens 17).
- **DANGER-CHECK-SCALAR-REMOVAL-CLASS** — invariant: a scalar key removed from the settings is classed by the default
  it falls back to. Origin: the part apply-danger-check classes list removals only; `classOf` classes every scalar
  removal as `nothing widened` (`agent-workflow-kit/tools/apply-danger-check.mjs:126`), so removing `sandbox.enabled:
  true` (the sandbox off by default) prints `nothing widened`, and autonomy-render's scope admits it (its value `true`).
  No harness writer removes a scalar today. Narrow fix: the table names scalar removals (`sandbox.enabled` and
  `sandbox.autoAllowBashIfSandboxed` removed: `prompts removed`; `permissions.defaultMode` removed: `nothing widened`)
  and a scope admits no scalar removal. Same class: an altered credentials entry (`sandbox.credentials.envVars`,
  `deny` changed to another mode) prints `nothing widened` beside its refusal (`apply-danger-check.mjs:144`, `:69`).
  Raised by the S1 code session's self-review; the credentials case by the S1 release lens; its line by the S6 re-check
  lens.
- **JEV-SKILL-BENEFIT-SAYS-YOU-RUN-IT** — invariant: no shipped benefit names who runs an item contrary to its lane.
  Origin: `BENEFITS['jev-skill']` ends `from one command you run` (`agent-workflow-kit/tools/recommendations.mjs:379`,
  pinned by `agent-workflow-kit/tools/jev-guide.test/offer.test.mjs:202`), while the offer is applied by the agent on
  the chat yes or by `init` on its y. Narrow fix: `one pinned verified copy per agent root, installed on your yes`.
  Residual, not live: only the offer shows it (the kit item has its own `VARIANT_BENEFITS` row) and no write decision
  reads it. Raised by the S17 diff review's copy pre-pass.
- **JEV-SKIP-CELLS-OMIT-THE-SILENT-ROWS** — invariant: the `NO_APPLY_LINE` skip shows only where a jev-skill arm would
  render. Origin: the tabbed-`CLAUDE_CONFIG_DIR` cells (`agent-workflow-kit/tools/jev-guide.test/copy.test.mjs:112-118`,
  `agent-workflow-kit/tools/jev-guide.test/offer.test.mjs:307-313`) use homes where an arm renders, so a probe calling
  `skillLine` (`agent-workflow-kit/tools/recommendations.mjs:1497`) before its gates (`:1490-1496`) passes them. Narrow
  fix: two cells, each `{ items: [], skips: [] }`: a tabbed `CLAUDE_CONFIG_DIR` whose own target
  (`homeTargets(home, tabbed)[1]`) and the Codex and Antigravity targets all hold the current pair, and a tabbed
  `CLAUDE_CONFIG_DIR` over a key-unset home with every target absent. Residual, not live: the probe orders its gates
  before `skillLine` today; no write decision reads the cells. Raised by the S17 diff review (lens round 1).
- **JEV-SKILL-PLACE-HINT-NAMES-A-DIGEST-LINE** — invariant: a hint telling the user to run "the apply" points to a line
  that runs on its own. Origin: `run the apply in <place>` on the harness jev-skill item
  (`agent-workflow-kit/tools/recommendations.mjs:1513`), whose apply line needs the check's digest
  (`agent-workflow-kit/tools/write-lanes.mjs:200`). Narrow fix: "run the check line, then the apply line with its
  digest, in <place>". Residual: a pasted `--expect <digest>` is a parse error in bash, zsh, fish and PowerShell;
  nothing runs. Raised by the S1 diff review (lens round 1).
- **DANGER-CHECK-DIGEST-OMITS-THE-ROOT** — invariant: the consent digest binds where the change lands. Origin:
  checkApply prints root-relative lines (`agent-workflow-kit/tools/apply-danger-check.mjs:314-334`), so two projects with
  identical planned lines share a digest. Narrow fix: a first line `root: <abs>` inside the digest (a spec line-format
  revision). Residual: needs the agent itself to reuse one project's digest on another; the check and apply lines
  carry the same `--cwd`. Raised by the S1 diff review (lens round 1).
- **ADVISOR-READINESS-RESOLVES-AGAINST-THE-CALLER-CWD** — invariant: one advisor render reads one readiness. Origin:
  the bridge tier reads `detectAtRoot` (a relative `CODEX_HOME` resolves against the project root), while the
  advisor's other readiness reads (`composeReadiness`, `agent-workflow-kit/tools/recommendations.mjs:559`) call
  `detectBackends` against the process cwd, so run from outside the root with a relative override the `review-recipe`
  item can disagree with the `bridge-tier` item. Narrow fix: those reads take `detectAtRoot(root, …)`. No write decision
  rides it. Raised by the S2 diff review (lens round 1).
- **DETECTOR-KEEPS-A-LITERAL-TILDE-OVERRIDE** — invariant: readiness and the state-dir resolver read one env override
  the same way. Origin: `resolveDir` returns a non-empty override as given (`agent-workflow-kit/tools/detect-backends.mjs:206-209`),
  so a literal `CODEX_HOME='~/.codex'` is probed as `<root>/~/.codex/auth.json` (codex reads `needs-credentials` and the
  tier skips it), while `resolveWritableDir` reads it under the home. Before S2 the same path resolved against the
  process cwd and failed alike. Narrow fix: expand a literal `~`/`~/…` override against the home before the probe.
  Raised by the S2 diff review (codex round 2).
- **RESEED-PRINTS-NO-CLASS-FOR-RE-ARMED-APPROVAL** — invariant: a check result names what a write turns back on. Origin:
  the kit items `gate-hook.not-current` and `state-block.not-current` (spec init-project, part hook-writers revision 8)
  write a wired hook's file with the kit's body and print only a `writes:` line, no class, though the written hook turns
  gate auto-approval, the read-lane compounds or the Stop check back on; the harness `gate-hook` placement over a wired
  entry prints the same form (`plannedChange` in `agent-workflow-kit/tools/apply-danger-check.mjs`). Narrow fix: a class
  suffix on a hook-file `writes:` line naming what the hook approves. Raised by the S6 spec review (lens round 1, m4);
  reworded to the kit hook items during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **GATE-HOOK-DIVERGED-UNWIRED-RECOVERY-SKIPS-THE-CHECK** — invariant: every recovery the kit prints for a harness
  write is a check line. Origin: the read-lane's printed recoveries in `agent-workflow-kit/tools/gate-hook.mjs` — the
  `--apply --read-lane` refusals of a stale, absent or unwired hook and the read-lane dry run's `STALE` and wiring
  lines — name the raw `gate-hook --apply` line (`applyGateHookCommand`), a hook-file write with no danger check that
  also wires an unwired hook (spec init-project, part hook-writers revision 8). Narrow fix: those lines name the check
  line of `gate-hook.not-current` over a wired hook and of `gate-hook` over an unwired one. Raised by the S6 spec review
  (lens round 1, m5); reworded to the read-lane's recoveries during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **S6-LIVE-ACCEPTANCE-RUNS-NO-STOP-HOOK** — invariant: a live acceptance proves the placed hook runs, not only that the
  item leaves the list. Origin: the S6 plan's live bullet (story S6 of BRIDGES-WORK-UNDER-THE-SANDBOX) checks that the
  next advisor run no longer lists `state-block`, never that the wired Stop hook fires. Narrow fix: start a new session in
  the scratch project and see the guard's warning on a control message that drops the closing block. Raised by the S6
  re-read (codex, minor 2).
- **STATE-BLOCK-POSTURE-NOT-IN-THE-CONSENT-ROUTE** — invariant: the user hears a placed hook's trust posture before the
  yes. Origin: `state-block-guard.md` asks to state the posture when asking consent, while the advisor shows only the
  closed set of posture notes (`RISK_NOTED_KEYS`, pinned at
  `agent-workflow-kit/test/recommendations-language-contract.test.mjs:126`) and `state-block` is not in it; story S6
  of BRIDGES-WORK-UNDER-THE-SANDBOX gives the item a chat-yes writer. Narrow fix: a one-line `state-block` posture note
  in `references/modes/recommendations.md` and its `RISK_NOTED_KEYS` entry. Raised by the S6 re-read (lens, m5).
- **STATE-BLOCK-HOOK-RESTATES-TWO-GATE-HOOK-REFUSALS** — invariant: one writer discipline, written once. Origin:
  `agent-workflow-kit/tools/state-block-hook.mjs:141-149` restates gate-hook's unsafe-mode refusal (`gate-hook.mjs:291-299`)
  and `:173-178` its stamp refusal (`gate-hook.mjs:332-337`), with gate-hook's error codes. Narrow fix: gate-hook exports
  the two refusals as helpers both writers call, and the S28 import cell names them. Raised by the S6 release copy pass
  (lens, F2).
- **SETTINGS-WRITE-FOLLOWS-A-LATE-LINK** — invariant: a writer's file write never follows a link planted after its
  preflight. Origin: the in-place `.claude/settings.json` write (`agent-workflow-kit/tools/gate-hook.mjs:359`,
  `agent-workflow-kit/tools/state-block-hook.mjs:193`) opens with a plain flag after an lstat-only preflight
  (`assertSettingsWritable`); story S6 closed the same window for the hook file (`writeHookFile`). Narrow fix: the
  settings write through `writeHookFile`'s replace flags (create `wx` when absent). Proof: a cell swapping the settings
  file for a link before the write, refused, the link target unchanged. Residual declared not live: the window is
  between two calls of one run, and only a process already able to write the project's `.claude/` can use it, so it
  widens nothing that process lacks; the same residual covers a hard link at the hook path and the same window over a
  parent directory (`.claude` or `.claude/hooks` swapped for a link between the preflight and the write, which the
  recursive `mkdir`, `wx` and `O_NOFOLLOW` do not see). Raised by the S6 diff review (codex round 1, M1, the
  generalization; lens round 2, M1, the parent directory and the hard link). Widened during the
  DISTRIBUTION-FILES-STAY-CURRENT S16 spec review: in both hook writers the re-read of the placed hook right before the
  settings write is an `lstat` then a plain read, so a link swapped in between the two is read through; over a hook the
  user wired nothing is wired, so the kit items `gate-hook.not-current` and `state-block.not-current` never reach that
  window.
- **HOOK-REPLACE-OPEN-BLOCKS-ON-A-FIFO** — invariant: a writer refuses a non-regular entry, never blocks on it. Origin:
  `writeHookFile`'s replace flags (`agent-workflow-kit/tools/gate-hook.mjs:147`, `O_WRONLY | O_NOFOLLOW | O_TRUNC`) block
  on a FIFO swapped in at the hook path after the preflight until a reader opens it, and the danger check's apply spawn
  has no timeout. Narrow fix: `O_NONBLOCK` on the replace flags and `ENXIO` in `LATE_CHANGE_CODES`, as the kit's
  no-follow reader does (`agent-workflow-kit/tools/fs-read-nofollow.mjs`). Raised by the S6 diff review (lens round 2, m1).
- **HOOK-REPLACE-REFUSES-WITHOUT-NOFOLLOW** — invariant: a harness item the advisor offers can be applied on every
  platform the kit supports. Origin: `writeHookFile` (`agent-workflow-kit/tools/gate-hook.mjs`) refuses an in-place
  replace where `fs.constants.O_NOFOLLOW` is absent (native Windows), so the kit items `gate-hook.not-current` and
  `state-block.not-current` over a differing file, and the harness `gate-hook` and `state-block` offers over a differing
  unwired one, stay pending there and never converge. Narrow fix: without `O_NOFOLLOW`, unlink the entry (which removes
  a link, never its target) and create the file exclusively (`wx`). Proof: the no-follow-absent cell applies and leaves
  a planted link's target unchanged. Raised by the S6 diff review (codex fold ask, C-M1 correction); reworded to the two
  kit items during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **STATE-BLOCK-HOOK-PRINTS-NO-HIDDEN-MODE-NOTE** — invariant: every `.claude/` placing writer names the hide-footprint
  reconcile. Origin: `agent-workflow-kit/tools/state-block-hook.mjs` prints only the hot-reload line after a write, while
  `gate-hook.mjs` adds the hidden-mode note; on a hidden deployment with no gate hook the placed `.claude/hooks/` shows in
  `git status` until the next upgrade. Narrow fix: the same note line after a state-block write and one sentence in
  `state-block-guard.md`'s writer list. Raised by the S6 diff review (lens round 1, m1).
- **STATE-BLOCK-HOOK-TAKES-NO-DRY-RUN-FLAG** — invariant: the hook writers share one flag grammar. Origin:
  `state-block-hook.mjs` `parseArgs` refuses `--dry-run` (`unknown argument`), which `gate-hook.mjs` accepts; the preview
  is already the default. Narrow fix: accept `--dry-run` and refuse it beside `--apply`, as gate-hook does. Raised by the
  S6 diff review (agy round 1, n1).
- **STATE-BLOCK-CONVERGES-ON-THE-WIRING-ALONE** — invariant: an item converges only when what it installs runs. Origin:
  `isStopHookWired` (`agent-workflow-kit/tools/state-block-hook.mjs`) matches the runtime name in a Stop entry's command
  and reads only the settings. From story S16 of DISTRIBUTION-FILES-STAY-CURRENT a wired entry with the kit file absent
  renders `state-block.not-current`, so one state stays: a Stop entry running another copy of the runtime (this
  repository runs the kit source) whose file is missing accepts the hook, the kit file is placed though that entry does
  not run it, and the entry errors at each turn end while no state-block item renders. Narrow fix: the probe reads the
  path the accepting entry runs and states a skip naming it when that file is absent; one cell for that state. Raised
  by the S6 release (session 51); narrowed during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **GATE-APPROVE-SUITE-COMMENT-NAMES-THE-RESEED-ARM** — invariant: a suite's comments describe the shipped behaviour.
  Origin: `agent-workflow-kit/test/gate-approve-hook.test.mjs:257-260` still describes the "marker-scoped reseed arm",
  which story S16 of DISTRIBUTION-FILES-STAY-CURRENT retires for `gate-hook.not-current`. Narrow fix: the comment names
  the kit item. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **HOOK-KEY-UNWIRED-READS-NO-DRY-RUN-UNPINNED** — invariant: an unwired hook's key renders its offer whatever the writer
  dry run would say. Origin: spec init-project S72 has no cell proving the dry run is not read while the hook is unwired
  — unwired beside a link at the kit hook path, an unsafe `permissions.defaultMode` or a malformed `hooks.PreToolUse`
  renders the offer, not a skip. Narrow fix: those three unwired rows in the S72 table of
  `agent-workflow-kit/tools/recommendations.test.mjs`. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **HOOK-KEY-STALE-STAMP-OVER-A-CURRENT-FILE-UNPINNED** — invariant: a stale stamp alone never renders a hook item or
  skip. Origin: spec init-project S72 pins the upgrade-first skip beside a planned file but no cell for a stale stamp over
  a current wired file rendering nothing (the agents precedent, S48). Narrow fix: one S72 row per key. Raised during the
  DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **INIT-PROJECT-R23-NAMES-GIT-HOOKS-WITH-NO-PASSAGE** — invariant: a part a revision names as following carries the
  passage it follows with. Origin: spec init-project revision 23 (its revision note and Links) names the part git-hooks
  among the parts that follow, though git-hooks carries one phrase of it and no revision-23 passage. Narrow fix: drop
  git-hooks from the revision-23 list, or give it the one passage. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S16
  spec review.
- **HOOK-WRITERS-STOPS-OMIT-AN-UNREADABLE-HOOK-FILE** — invariant: the part's STOP list is exact. Origin: spec
  init-project, part hook-writers, "Exactly the following stop either writer" omits a regular but unreadable kit hook
  file, which `planTarget`'s raw read (`agent-workflow-kit/tools/gate-hook.mjs`) throws on, both writers alike. Narrow
  fix: the list names it, and one cell per writer pins the refusal. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S16
  spec review.
- **HOOK-MD-CONSENT-STEPS-NOT-SCOPED-TO-AN-UNWIRED-HOOK** — invariant: a mode doc's consent steps apply only where a yes
  is asked. Origin: `agent-workflow-kit/references/modes/hook.md` consent steps 2 and 3 are not scoped to an unwired
  hook, so a wired hook whose file differs still reads as asking a yes; no S33 cell pins the scope. Narrow fix: the two
  steps open with the unwired case, and an S33 cell pins it. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S16 spec
  review.
- **HOOK-WRITERS-MASK-LIMIT-TOO-BROAD-FOR-GATE-HOOK** — invariant: a stated limit is true for each key it names. Origin:
  spec init-project, part hook-writers, Stated limits, "over an unwired one the offer renders and its check stops on that
  refusal", is too broad for the gate-hook key: with no declaration that key renders `gates-declaration` alone. Narrow
  fix: "the offer, where it renders, stops on that refusal at its check (exit 3)". Raised during the
  DISTRIBUTION-FILES-STAY-CURRENT S16 spec review.
- **GIT-HOOKS-INSTALLER-SKIPS-ON-ANY-REV-PARSE-FAILURE** — invariant: the hook installer skips only outside a git
  checkout. Origin: any non-zero `git rev-parse --git-path hooks` exit (dubious ownership, git absent) reads as "not a
  git checkout" and exits 0 (`agent-workflow-kit/references/scripts/install-git-hooks.mjs:60-63,179-182`): the
  `enforcement` scripts land, the item converges on Node evidence and no hook exists. Narrow fix: the installer skips
  on git's own not-a-repository answer alone and exits non-zero on every other failure. Residual: a deployed installer
  keeps the old bytes until the project's copy is replaced. Raised by the S8 spec consult.
- **GIT-HOOKS-INSTALLER-ROOT-IS-NOT-THE-WORK-TREE-TOP** — invariant: the installed hook runs from the root it was
  written for. Origin: the installer's root is its own location (`install-git-hooks.mjs:45`) while git runs the hook
  from the work-tree top, where its `node scripts/…` lines resolve (`:167-172`): a project root below the top (a
  monorepo subfolder) gets a hook that fails every commit of the enclosing repository. Narrow fix: the hook changes to
  the installer's root first, or the installer refuses a root that is not the top. Residual: as the row above. Raised by
  the S8 spec consult.
- **GIT-HOOKS-READER-ACCEPTS-ANY-MARKER-NAME** — invariant: the advisor reads a hook as managed only when the installer
  would rewrite it. Origin: the reader takes any `<name>:install-git-hooks.mjs` marker as `managed`
  (`agent-workflow-kit/tools/recommendations.mjs:891`) while the installer accepts only its own root's name
  (`install-git-hooks.mjs:47-57,188`): a renamed root gets a `commit-guard` item, and with no kit script left an
  `enforcement` item, whose every apply the installer refuses (the check's exit 6, the copies removed), offered again
  each run. Narrow fix: the reader derives the marker name as the installer does. Raised by the S8 spec consult.
- **GIT-HOOKS-INSTALLER-WRITES-A-SHARED-HOOKS-DIR** — invariant: a hook placed through the kit's route governs that
  project's own repository alone. Origin: the installer writes into the dir `git rev-parse --git-path hooks` reports, a
  global `core.hooksPath` included (`agent-workflow-kit/references/scripts/install-git-hooks.mjs:60-63,183`), and the
  hook's relative `node scripts/…` lines (`:167-172`) then fail every commit of each other repository using that dir;
  pre-existing (the hand step ran the same installer). Narrow fix: the advisor withholds both items, a skip naming the
  dir, when git's hooks dir lies outside both the work tree and `--git-common-dir`. Residual: bootstrap step 8 and the
  `upgrade.md:46` refresh run the check without the advisor's reader, so the narrow fix leaves those routes writing into
  a shared dir; the installer's own refusal of a hooks dir outside the repository closes it, with the installer rows'
  residual (a deployed installer keeps the old bytes). Raised by the S8 diff review (lens round 1, M2).
- **GIT-HOOKS-ROLLBACK-JUDGES-SCRIPTS-PER-PATH** — invariant: the rollback judges `scripts/` once, no-follow, before any
  path under it, against the directory this run's own mkdir created or found; any other answer (absent, another kind,
  another inode, a throwing lstat) removes nothing under it and names it; `scripts/` is removed only when this run's
  mkdir created it and it is empty. Origin: `rollBack` lstats each created path before judging the dir
  (`agent-workflow-kit/tools/git-hooks.mjs:85-87`), so a `scripts/` swapped for a regular file throws ENOTDIR out of
  `fail` and nothing is named; "this run created it" is the dry run's absence (`:67`), so an empty `scripts/` another
  process makes after the lstat, and this run fills, is removed (`:97-111`). Narrow fix: the leaf's own non-recursive
  mkdir before the first copy, its inode recorded, EEXIST meaning the dir is not this run's; the rollback judges the
  dir first and a throwing lstat names the path. Residual: a concurrent writer of the project's `scripts/` during the
  apply. Raised by the S8 diff review (codex round 1, m2; lens round 1, m3).
- **COMMIT-GUARD-OFFERED-OVER-A-LINKED-INSTALLER** — invariant: the advisor renders a harness item only where its
  writer's dry run admits the tree. Origin: `probeCommitGuard` tests the installer with `existsSync`
  (`agent-workflow-kit/tools/recommendations.mjs:928`), which follows a link; the leaf refuses a linked `scripts/` or
  installer (exit 3), so the item is offered every run and never applies. Narrow fix: lstat `scripts/` and the
  installer; another node kind is a skip carrying the leaf's refusal text. Raised by the S8 diff review (lens round 1,
  m1).
- **GIT-HOOKS-REFUSES-A-LINK-IT-NEITHER-WRITES-NOR-RUNS** — invariant: the dry run refuses another node kind only at a
  path it writes or runs. Origin: kinds are checked per bundled name before `deployed` is known
  (`agent-workflow-kit/tools/git-hooks.mjs:49-53`), so under deployed scripts a linked `scripts/<x>.test.mjs` refuses
  the refresh route (exit 3). Narrow fix: record kinds, compute `deployed`, then refuse only among the copies (when not
  deployed) and at the installer. Raised by the S8 diff review (lens round 1, m4).
- **UPGRADE-HOOK-REFRESH-NAMES-AN-UNRENDERED-LINE** — invariant: every route a mode doc names is a line the agent can
  run. Origin: `agent-workflow-kit/references/modes/upgrade.md:46` names "the `enforcement` check line" in a state where
  the advisor renders no `enforcement` item (deployed scripts). Narrow fix: name `apply-danger-check.mjs --variant
  enforcement` (+21 B against upgrade's full read set, now 2 B under 81920: a documented budget bump with it). Raised by
  the S8 diff review (lens round 1, m6).
- **ENFORCEMENT-NOT-OFFERED-ON-A-FRESH-CLONE** — invariant: a project whose kit scripts are tracked gets its pre-commit
  hook offered on every checkout. Origin: a fresh clone of an already-deployed project carries `scripts/*.mjs` in git, so
  `probeNodeEvidence` answers `deployed-node-scripts` and `enforcementOffer` returns false
  (`agent-workflow-kit/tools/recommendations.mjs:961-962`), `enforcementAdmits` is false, no hook is installed and no
  `enforcement` item renders; only the `commit-guard` item, where a final-capable gate declaration lets it render, names
  the missing hook. Narrow fix: under `deployed-node-scripts` with an `absent` pre-commit state, render the `enforcement`
  item through its refresh route (the leaf copies nothing and runs the project's installer). Residual: a clone with no
  final-capable gates gets no item at all. Raised by the S8 lens (residual), recorded at the S10 spec session.
- **VELOCITY-WRITER-IMPORT-CLOSURE** — invariant: a settings writer loads only the modules its own modes run. Origin:
  `agent-workflow-kit/tools/velocity-profile.mjs:18` imports the grant derivation from `worktrees.mjs`, so every
  velocity run (and `apply-danger-check.mjs:16`, which imports both) loads the whole worktrees tool: the writer's
  import closure went from 22 to 51 modules, its load from ~30 to ~90 ms (measured at the S10 tests session). Narrow
  fix: move `worktreesGrantDir`, `worktreesGrantHoldsHome` and the derivation they read into one leaf that
  `worktrees.mjs` re-exports, the three readers importing that leaf. Proof: a closure-count cell over the writer.
  Residual, not live: load time only; no output, write or refusal changes.
- **INIT-CONSOLE-Y-REJUDGES-ONE-FORM** — invariant: a console y's record never holds host state a written value
  resolves through. Origin: `init` re-judges only the forms `isRejudged` names (`worktrees-dir`, and from S11
  `footprint-global`: `agent-workflow-kit/tools/write-lanes.mjs:209`, `agent-workflow-kit/tools/init-project.mjs:277,290`);
  every other form applies the record taken at the preview, and `autonomy-render` writes or drops its credential
  denials by the `claude` version on PATH (`agent-workflow-kit/tools/velocity-profile.mjs:1469-1475`), pre-existing.
  Narrow fix (S10, S45 of init-project): the `rejudged` form property, the batch re-running a rejudged item's check
  just before its launch. Generalization: every form whose written value reads host state is rejudged, or its record
  carries that state. Residual: a `claude` upgrade between the preview and the y changes the credential block written.
  Raised by the S10 diff review; recorded at S11.
- **STATUS-AND-UNINSTALL-READ-THE-LEGACY-ATTRIBUTION-KEY** — invariant: every reader of the project's attribution choice
  judges the effective settings through `attributionHidesText`, the one predicate the `attribution` item converges on.
  Origin: `status` reads `includeCoAuthoredBy` alone (`agent-workflow-kit/tools/family-registry.mjs:552-562`, rendered
  at `agent-workflow-kit/tools/renderers.mjs:141-145`), and `uninstall` names only that key as the kit's edit
  (`agent-workflow-kit/tools/uninstall.mjs:768,778,781`), so the `attribution` object the item writes is reported as
  absent and is not named for removal. Narrow fix: both readers import `effectiveAttribution` and
  `attributionHidesText` from `agent-workflow-kit/tools/attribution.mjs`; `uninstall` names the `attribution` key too.
  Proof: a status cell and an uninstall cell over a settings file holding only the object form. Residual, not live:
  report text only; no write or refusal changes. A non-goal of S11 (in-session-writes, stated limits).
- **CONSENT-BINDS-EVERY-REPLACED-TREE** — invariant: every check line for a write that replaces an existing tree
  carries the replaced tree's digest, as a write over an existing regular file now does. Origin: the skill variants'
  `replace` writes print the new tree's digest alone (`agent-workflow-kit/tools/apply-danger-check.mjs:304-310`,
  `directory: true`). Narrow fix (S11): `checkApply` derives `replaces` for every write over an existing regular file,
  which binds the executor re-derive. Proof: a skill cell with two different installed trees giving two digests.
  Residual, not live: the replaced tree is the kit-vendored pinned copy no user authors, and the window is one
  check-to-apply. Raised by the S11 diff review (codex; the lens's replacement invariant).
- **FOOTPRINT-GLOBAL-ONE-GIT-ENV** — invariant: the `footprint-global` probe, its check, its apply and `init` ask git
  for `core.excludesFile` under one env, so they judge one file. Origin: in an agent session the probe, the check and
  its spawned apply read one ambient env and agree; under `init` the in-process probe reads `process.env`
  (`agent-workflow-kit/tools/recommendations.mjs:1620`) while its preview and `checkApply` use `spawnEnv =
  stripGitLocationEnv(...)` (`agent-workflow-kit/tools/init-project.mjs:362,219,223`), which drops every `GIT_` key,
  `GIT_CONFIG_GLOBAL` included (`agent-workflow-kit/tools/git-env.mjs:16`). Fix: init's probe and its check read one
  env — the probe reads the env it is handed (`deps.env`, not `process.env` at `recommendations.mjs:1620`) and init
  hands its probe and its check the same env — then one env derivation inside `planGlobalRemoval`
  (`agent-workflow-kit/tools/hide-footprint.mjs:391`, spec review-domain/hide-footprint) after a decision on whether
  `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_*` survive. Proof: init's queue probe and its check under a console env carrying
  `GIT_DIR` or `GIT_CONFIG_GLOBAL` plan the same file. Residual, not live (a console env carrying either, under
  `init` only): the item names a file A its probe judged while the check and the apply judge B; with no block in B the
  apply answers `nothing to change`, with a block in B the y removes B's block (the check shows it) and the item naming A
  is back on the next run, and with a block in B only `init` lists no item while the agent session does. Raised by the S11 diff review; cut from S9 by its spec
  review (codex, lens).
- **ADVISOR-WRITERS-PROFILE-GAP-ROW-FROM-REGISTRY** — invariant: the `profile-gap` row of
  `agent-workflow-kit/references/advisor-writers.md` names the writer of every `PROFILE_GAPS` entry
  (`agent-workflow-kit/tools/profile-gaps.mjs:246-253`), proven from the registry, not only from the entries a fixture
  renders. Origin: `agent-workflow-kit/tools/recommendations.test.mjs:3720-3775` compares the row with the rendered
  items' writers only, and `session-close-rules` never renders an item; the S54 clause of
  `docs/ai/specs/kit/install/init-project/index.md` ("for profile-gap every PROFILE_GAPS entry is covered") states this
  proof. Fix: the cell takes the expected set from the basenames of `PROFILE_GAPS.map((e) => e.apply(root))` and asserts
  it equals the row, keeping the rendered-union check. Proof: a fixture registry entry naming a new tool fails the cell.
  Residual, not live: today's row names `tier-preview.mjs` and `checker-gates.mjs`, every writer the four entries'
  applies use (the two rules-file entries and `rules-insert.mjs` retired with kit 20.0.0, AD-216). Raised by the S9
  diff review (lens).
- **USER-STEP-NAMES-KIT-DOC-RELATIVE** — invariant: a user step names a kit doc by a path the user can open from the
  project. Origin: the `gates-inert.unfillable` and `gates-inert.producer-unrecognized` steps
  (`agent-workflow-kit/tools/write-lanes.mjs:190-197`) cite `references/modes/gates.md`, a path inside the installed kit
  (bytes fixed by the advisor-writers part, D1). Fix: a later spec revision prints the resolved
  `<toolsDir>/../references/modes/gates.md`. Proof: a step cell asserting the printed path exists. Residual, not live: the
  agent presents the step and resolves the kit-relative `references/modes/` path, as every advisor note does. Raised by
  the S9 diff review (lens).
- **KIT-STAND-IN-COUNTS-IN-NO-VERDICT-CLASS** — invariant: the advisor's verdict never reads `nothing is broken` while
  a configured `subagent` slot degrades to `solo`. Origin: from story S15 `agents.not-current` renders in the base
  `executor-vehicle` arm's place over a missing or unusable executor in a placed component (spec carriers, part
  agent-files), and a kit item counts in no verdict class (`agent-workflow-kit/tools/recommendations.mjs:250-259`,
  `:1669-1670`); while its apply ends pending the verdict can read `nothing is broken`. From story S16 the kit items
  `gate-hook.not-current` and `state-block.not-current` count in no class either, so a wired hook whose file is absent or
  stale can read `nothing is broken` while its item stays pending (widened during the DISTRIBUTION-FILES-STAY-CURRENT S16
  spec review). From story S17 the kit item `jev-skill.not-current` counts in no class either, so an agent skill root
  absent or behind the pin beside a copy at a kit pin can read `nothing is broken` while its item stays pending.
  A fold that counted the stand-in as
  attention was tried at the S15 spec review and bred restatements (the mode doc's verdict paragraph, init-project S4 and
  S7, the item's label and sort), so it was withdrawn. Narrow fix: one design of the stand-in's class across the item,
  its label, its sort and the verdict paragraph. Proof: a verdict cell over that tree. Residual, not live: the kit route
  applies the item in the same upgrade, and a pending item is shown with its output. Raised by the S15 spec review
  (lens, round 2).
- **ROSTER-LENS-HAS-NO-RESERVED-FORM** — invariant: a user's own vehicle under `.claude/agents/` takes a name form no
  kit release ever takes. Origin: a review roster's lens member names `.claude/agents/<stem>.md`, its stem a slug with
  no dot (`agent-workflow-kit/tools/review-roster.mjs:8`), so a lens of the user's own in a review slot cannot take the
  reserved `.local` form, and a later release that bundles its stem writes over it with no question (spec carriers, part
  agent-files, stated limits). Narrow fix: the lens survey also reads `.claude/agents/<stem>.local.md` for a bare stem
  with no bundled template. Proof: a survey cell and a writer cell over that file. Residual, not live: no bundled name
  collides with a stem in use today. Raised by the S15 spec review (lens, round 1).
- **ROSTER-RENDERS-NAMES-A-MISSING-LENS-ITEM** — invariant: a spec names only advisor items the advisor renders.
  Origin: `docs/ai/specs/kit/review-roster/renders.md:71` and review-roster S9 describe a `review-lens` attention item
  for a missing roster-derived lens, while `agent-workflow-kit/tools/recommendations.mjs` has no `review-lens` key and
  `probeReviewRecipe` skips lens members. Narrow fix: drop the clause from renders.md and S9, or render the item.
  Proof: an advisor cell over a configured derived lens with no file. Residual, not live: from story S15 an accepted
  component places that lens through `agents.not-current`. Raised by the S15 spec session.
- **FAMILY-REGISTRY-COMMENT-SAYS-PRESERVED** — invariant: a code comment states what the code's writer does.
  Origin: `agent-workflow-kit/tools/family-registry.mjs:618-619` says a customized copy counts as placed because "the
  writer preserves it"; from story S15 the agents writer writes it current. Narrow fix: "(it exists; the agents writer
  writes it current)". Proof: none needed (comment). Residual, not live: the count is right. Raised by the S15 spec
  review (lens, round 2).
- **AGENTS-DIR-MASK-READ-TWO-WAYS** — invariant: the advisor and the danger check read `.claude/agents` itself alike.
  Origin: the advisor reads a device-node mask at an absent `.claude/agents` as absent and renders the `agents` offer,
  while the check's `assertDirSafe` (`agent-workflow-kit/tools/cheap-agents-read.mjs:95`) exits 3 "exists but is not a
  directory"; S15 exempts only paths under the folder. Narrow fix: the check prints `masked: .claude/agents` for the
  agent variants and exits 3 as for a masked settings file. Proof: a check cell over that mask. Residual, not live:
  predates S15 and sits inside the unmeasured single-file binds of init-project's stated limits. Raised by the S15 spec
  review (lens, round 2).
- **RULES-RECORD-REPLACE-DROPS-A-NEWER-KITS-ENTRIES** — invariant: an older kit never deletes a newer kit's record
  entries. Origin: the record writer replaces an unreadable record (project-rules revision 2), and `parseRecord` reads
  a theme outside the registry as unreadable (`agent-workflow-kit/tools/project-rules/rules-check.mjs:57`), so an
  older kit's upgrade would replace a record holding a theme only a newer kit knows; one theme exists today. Narrow
  fix: replace as absent only for the other parse failures, keeping such entries. Raised by the S2 spec review (lens).
- **PROJECT-RULES-DOOR-DRAGS-THE-WRITER-GRAPH** — invariant: a read-only consumer of the project-rules registry or
  check imports no writer. Origin: `agent-workflow-kit/tools/project-rules/index.mjs` re-exports `ensureRules` beside
  `THEMES` and `checkRules` (project-rules revision 2), so a read-only tool importing the door would breach
  `agent-workflow-kit/test/read-graph-purity.test.mjs:79-82`; no read-only consumer exists before story S5. Narrow fix
  in S5: a read door beside the op entry. Raised by the S2 spec review (lens).
- **RULES-TEMPLATE-EDIT-WITHOUT-ITS-PRIOR-UNPINNED** — invariant: a release that changes a theme template appends the
  outgoing body to the prior catalog. Origin: nothing reds when `agent-workflow-kit/references/rules/project-layout.md`
  changes without a catalog entry, so the upgrade of every deployment of the previous release would print the
  replaced line for an unknown body, naming the local file as the route for a rule nobody wrote. Narrow fix: the
  priors suite pins the current template's sha256; it lands before any change of a theme template. Raised by the S2
  spec review (lens).
- **BOOTSTRAP-RULES-FAILED-LINE-UNSTATED** — invariant: every command a deploy step runs says what its failure means
  for the next step. Origin: bootstrap's step 10 runs the rules op (project-rules revision 2) and relays its line, but
  does not say whether a `rules: failed` line stops the stamp (`agent-workflow-kit/references/modes/bootstrap.md:37-49`).
  Narrow fix: one clause, "a failed line is relayed with its cause and the stamp still follows; the next upgrade lays
  the theme". Raised by the S2 spec review (lens, round 2).
- **BOOTSTRAP-RULES-COMMAND-NOT-SPAWNED** — invariant: the command a mode doc prints is the command a test runs.
  Origin: project-rules S25 pins that bootstrap's step 10 carries the rules run, while S23 spawns its own command, so
  a typo in the documented flag passes both. Narrow fix: S25 extracts the step-10 command by pattern and spawns it on
  the S23 fixture, as `agent-workflow-kit/test/fallback-bootstrap.test.mjs:26-30` does for step 7. Raised by the S2
  spec review (lens, round 2).
- **RULES-ENSURE-SUITE-MISSES-THREE-WRONG-WRITES** — invariant: each write decision of the rules op has a cell that
  fails on the tempting wrong code. Origin: `agent-workflow-kit/tools/project-rules/rules-ensure.test.mjs:220-233`
  never reads the kit file a pending run seeds or refreshes, `:274-285` loses a seed race only to other bytes, and no
  cell injects two themes, so a skipped pending kit write, a stop on a same-bytes race and a last-theme-only token
  pass. Narrow fix: assert the kit bytes in the non-dry pending cells, a same-bytes `loseSeed` cell for the kit and the
  effective file, and two-theme cells (`deps.themes` plus a second template in `makeKit`) for the survey stop, the
  cross-theme token and the one replace line. The code is correct today. Raised by the S2 diff review (lens).
- **RULES-RECORD-NOT-UTF8-HAS-NO-WRITER** — invariant: every record the check reports as unreadable on a regular file
  has a writer that replaces it. Origin: `agent-workflow-kit/tools/fs-read-nofollow.mjs:89` answers `error` for
  invalid UTF-8, so the upgrade fails `unexpected-error` (`agent-workflow-kit/tools/project-rules/rules-ensure.mjs:35`)
  and `--record` refuses with the false `is not a regular file` (`agent-workflow-kit/tools/project-rules/rules-record.mjs:41`).
  Narrow fix: past `wrongNode`, read an `error` record as unreadable and replace it, the message naming the reader's
  code; a spec edit to rules-ensure. Raised by the S2 diff review (lens).
- **ROUTER-BUDGET-LITERALS-COPIED-IN-THE-RECOMMENDATIONS-SUITE** — invariant: each router byte budget is written once,
  in `BUDGET` of `agent-workflow-kit/test/router-contract.test.mjs`. Origin:
  `agent-workflow-kit/test/recommendations-language-contract.test.mjs:775,858,915,976,1220` copy 52224, so a
  documented bump of `routerPlusMode` leaves five stale pins. Narrow fix: move `BUDGET` into a small data module both
  suites import, and read it there. Raised by the S3 spec review (orchestrator self-review).
- **SPEC-STORE-REFUSAL-WRITES-NOTHING-UNPINNED** — invariant: a `--write-baseline` run that meets a spec store present
  but not a directory refuses, exit 1, and leaves the config byte-unchanged. Origin: spec source-size S29 (revision 3)
  states the refusal; the S5 plan's T3 names a `--check` cell over a symlinked store and no writer cell proving
  nothing is written. Narrow fix: one layout-check cell running `--write-baseline` over a symlinked `docs/ai/specs`,
  asserting exit 1 and the config's bytes unchanged. Raised by the EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S5 spec
  review (lens, re-read).
- **GIT-HOOK-GUARD-PATH-ACCEPTS-SHELL-ACTIVE-BYTES** — invariant: the path a hook line runs is the file it names. Origin:
  the installer's `--commit-guard` writes `node "<abs>" --check` for any resolved path, so a path carrying `$`, a
  backtick, `"` or a backslash is expanded by the shell inside the quotes and the hook runs another command, while the
  reader still reads the line as armed (`install-git-hooks.mjs:98,173`). Not folded in S6: the two new flags refuse such
  a path, and the guard keeps today's behaviour byte for byte so the tests deployed beside the prior installer stay
  green. Narrow fix: the guard flag adopts the same one safe shell representation, its test cells updated in the same
  memory release. Raised by the EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S6 spec review (codex, round 1).
- **HOOK-CHECKS-RENDERS-WHILE-ITS-CHECK-REFUSES** — invariant: an offered item's check can succeed. Origin: with the
  rules line armed and the layout record declined, `hook-checks` still renders (its render condition counts a
  `source-size.layout` item in the same run) while its dry run has nothing to plan, exit 3, every run — harmless, a
  refusing check leaves the item pending. Narrow fix: that exit-3 line names the `source-size.layout` item as the step
  that comes first. Raised by the EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S6 spec review (lens, round 2).
- **LINKED-WORKTREE-COMMIT-STOPS-IN-THE-HOOK** — invariant: a commit from a linked worktree passes the deployed hook.
  Origin: measured 2026-10-20 on a deployment with the 8.3.0 bundle, a commit from a linked worktree stops at the hook's
  docs index check; behind it, the deployed `migrate-gates.test.mjs:467-469,488-491` and
  `migrate-gates-branches.test.mjs:134-135,291` run `git init` under the hook's inherited `GIT_DIR` and then write under
  their temp root's `.git`. Narrow fix: each deployed suite strips the hook's inherited git variables, and the index check
  is judged in the linked tree. Residual, live: every commit from a linked worktree of a deployment stops. Raised by the
  EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S9 spec review (lens, round 1).
- **S71-MODE-CHECK-FAILS-WHERE-CHMOD-IS-IGNORED** — invariant: the installer's deployed suites pass inside the hook on
  every filesystem a temp dir can sit on. Origin: the S71 commit helper asserts the local file it wrote with mode 0644
  carries no executable bit (`agent-workflow-memory/references/scripts/install-git-hooks-repo-exec.test.mjs:154`); on a
  filesystem that ignores chmod and reports every file executable (WSL DrvFs without metadata) that assertion fails,
  and under `set -e` the deployed suite stops every commit. Narrow fix: the cell skips the mode assertion when a chmod
  it just made does not read back, keeping the file at 0644 where the filesystem honours it. Residual, not live where
  the temp dir is a POSIX filesystem or Windows (which reports no exec bits). Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S1 diff review (lens, round 1).
- **SCRIPTS-REREAD-THROW-DROPS-THE-PARTIAL-NOTE** — invariant: a scripts or specs op that stops partway names every
  file it already wrote. Origin: an absent file that appeared before its create-only write is re-read with a plain
  `read` in both ops (`agent-workflow-kit/tools/distribution-files/scripts.mjs:115`,
  `agent-workflow-kit/tools/ensure-specs.mjs:109`); a file removed or turned into a directory in between throws, which
  reaches the CLI as `unexpected-error` without the lines naming the files already written. Narrow fix: each re-read
  caught, the op failing `race-unresolved` with its lines and partial note. Residual: a window inside one write, the
  writer re-checking the node after EEXIST (`atomic-write.mjs`); no write decision changes. Named by the
  DISTRIBUTION-FILES-STAY-CURRENT S3 plan; S14 moved the specs op's re-read here when it took the scripts op's rule.
- **FOREIGN-SPECS-NAME-THE-RETIRED-REPLACE-STEP** — invariant: no live spec sentence names a retired module or step.
  Origin: `docs/ai/specs/kit/repo-search.md:27` says the kept-aside writer imports `RESERVED_DIR`, and
  `docs/ai/specs/memory/standalone-scripts.md:118` names the composition root's "one yes", both retired by story S14
  of DISTRIBUTION-FILES-STAY-CURRENT (`kept-aside.mjs` deleted, no upgrade yes for a kit file). Narrow fix: each
  owning spec's next revision drops the clause. Residual, not live: no code or shipped text follows either sentence.
  Named by the DISTRIBUTION-FILES-STAY-CURRENT S14 plan.
- **SPECS-WRITE-LOOP-REPEATS-THE-SCRIPTS-LOOP** — invariant: one write loop and one partial note serve both ops that
  write kit files by the one rule. Origin: `agent-workflow-kit/tools/ensure-specs.mjs:78` (`partialNote`) and `:93`
  (`writeAll`) repeat `agent-workflow-kit/tools/distribution-files/scripts.mjs:94` and `:100` but for the store root's
  create-only branch, while distribution-files revision 7 limits the index to four exports. Narrow fix: a revision of
  distribution-files exports the loop and the note through the index, the store root handed in as one more create-only
  target. Proof: S1, S2 and S7 of that spec pass unchanged over the shared loop. Residual, not live: both copies compose
  the same lines from the same fates, so no write decision differs. Raised by the S14 diff review (self-review).
- **ENFORCEMENT-COPY-PLACES-AN-INSTALLER-BESIDE-A-KEPT-SUITE** — invariant: no git-hook writer places an installer
  beside suites of another release. Origin: the `enforcement` copy is create-only per file
  (`agent-workflow-kit/tools/git-hooks.mjs:161-162`), so a writer run over a `scripts/` holding an older
  `install-git-hooks.test.mjs` and no Node-evidence script, the installer included (the suites are not Node evidence),
  places the current installer beside the kept suite, which may fail inside the hook. Not folded in S9: since S9
  `hook-checks` no longer writes the installer and cannot introduce this mismatch. Narrow fix: the `enforcement` dry
  run refuses over a kept member of `INSTALLER_SET` and names the upgrade, whose scripts op makes the set current.
  Proof: an `enforcement` cell over a `scripts/` holding only the 8.3.0 suite. Residual, not live through the advisor,
  which offers the item only over a `scripts/` holding no bundled basename (`recommendations.mjs:1052-1055`): only a
  direct `git-hooks --enforcement` run meets it. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S9 spec review.
- **GIT-HOOK-INSTALLER-ABSENT-LINE-NAMES-NO-ROUTE** — invariant: every refusal of a git-hook writer names a route that
  works. Origin: the `commit-guard` and `hook-checks` dry runs refuse with `<installer> is absent — nothing here places
  the hook installer` (`agent-workflow-kit/tools/git-hooks.mjs:128,165`), naming no step. Narrow fix: end the line
  with the upgrade route when `scripts/` holds a kit script, else name the `enforcement` item when `enforcementAdmits`
  holds (`agent-workflow-kit/tools/recommendations.mjs:1061`), else the user's own step. Proof: one cell per arm over
  an absent installer. Residual, not live through the advisor: its skip lines for both items already name the
  `enforcement` item or the user's own step (`recommendations.mjs:984,1013`), so only a direct writer run meets the
  bare line. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S9 spec review.
- **HOOK-RULES-LINE-WAITS-FOR-AN-ENGINE-THEME** — invariant: the `hook-checks` item arms the rules line whenever
  `--check` would pass. Origin: the item arms it only when every theme answers `current`
  (`agent-workflow-kit/tools/git-hooks.mjs:112-113`), while `--check` also passes on `absent`; from KIT-TEXT S1 the
  engine-homed `lens` theme stays `absent` until an engine that supplies it is installed. Narrow fix: arm when every
  theme is `current` or `absent` and at least one is `current`. Residual exposure, live but truthful: the item says
  `lens: absent` and the line arms after the engine refresh the upgrade's not-laid line names. Raised by the KIT-TEXT
  S1 spec review (lens).
- **RULES-RECORD-VOUCHES-NO-PRECEDENCE-LINE** — invariant: a recorded effective rules file opens with the kit's
  precedence line. Origin: from KIT-TEXT S1 every theme template opens with `PRECEDENCE_LINE` and an agent's merge
  keeps it, but `--record` checks only the digests and the frontmatter (spec project-rules, part rules-record), so a
  merged effective file without the line is recorded `current`. Narrow fix: the record writer refuses a merged
  effective file whose first non-blank line after the title is not the constant. Residual exposure, live: an agent
  reading such a file misses which copy governs. Raised by the KIT-TEXT S1 spec review (lens).
- **KIT-BLOCK-FENCE-HIDES-ITS-MARKERS** — invariant: the kit block's finder never inserts a second block and never
  names fewer marker lines than the file shows. Origin: from KIT-TEXT S1 a fence hides a marker line when a later
  line closes it (spec entry-pointers, "Two marker lines"), so a stray opener above the block closed by a later code
  block hides both markers (absent, a second block inserted at the start), and an opener inside the block closed
  after it hides the end marker (a refusal naming one line). Likelihood low: the block is inserted at line 1 and stays
  there. Fix direction, to weigh when taken: name every fenced marker line in the refusal's line; treating a fenced
  marker line as blocking an insert also refuses a file that only quotes the markers in a sample, a new upgrade STOP,
  so the taker weighs that against the silent duplicate insert. Raised by the KIT-TEXT S1 spec review (lens).
- **PUBLISH-PACK-RACES-THE-BRIDGE-FIXTURES** — invariant: the kit's publish test step passes whatever order its suites
  run in. Origin: `agent-workflow-kit/bin/install.test.mjs:704` runs `npm pack` over the kit folder while the codex
  bridge suites (`bridges/*/bin/*.test.mjs` in `.github/workflows/_publish-one.yml:171`) create and delete fixture
  repos under `bridges/codex-cli-bridge/node_modules/.aw-fixtures/`; a file removed mid-walk fails the pack with
  ENOENT. The kit 20.0.0 publish run 40652332877 failed on it, and the re-dispatch passed. Narrow fix: the bridge
  suites build their fixtures under the OS temp folder, never inside the package. Residual exposure, live: a release
  publish fails at random and needs a hand re-run. Raised at the KIT-TEXT release.
- **CI-FLOOR-RUNS-TESTS-BEFORE-THE-ROOT-HOOK-ENDS** — invariant: every suite passes on the Node floor CI pins.
  Origin: on Node 22.0.0 (`.github/workflows/ci.yml:43`) the file-level async `before` of
  `agent-workflow-kit/test/tier-walk-e2e.test.mjs:146-152` is not awaited past its first `await`, so the `seeded`
  fixture and both `texts` are undefined when the tests read them (CI run 40652297583: 14 suites, TypeError on
  `records`); Node 24 passes. CI has been red on every release push since kit 19.1.0; only this cause was read.
  Narrow fix: build every fixture synchronously before the first `await`, or move the hook into a `describe`. Residual
  exposure, live: CI is red on main, so a real floor regression is not seen. Raised at the KIT-TEXT release.
- **CI-GLOBS-MISS-THE-NEW-SUITE-FOLDERS** — invariant: CI and the publish step run every tracked suite the local gate
  runs. Origin: `.github/workflows/ci.yml:68-71` and `_publish-one.yml:171` name fixed-depth globs, so
  `agent-workflow-kit/tools/transition/*.test.mjs` and `agent-workflow-kit/tools/project-rules/*.test/*.test.mjs`
  (KIT-TEXT S1, S2) never run there; the gate's `tools/**` runs them. Narrow fix: name both folders in both lists.
  Residual exposure, live: the transition module ships with its suites run only locally. Raised at the KIT-TEXT release.
- **BRIDGE-REVIEWS-CANNOT-CARRY-A-LARGE-RELEASE-DIFF** — invariant: a council code review of a release's staged diff
  runs with no host change. Origin: the KIT-TEXT diff (139 files, 1.09 M characters) passed codex's 1 048 576-character
  input only through the host setting `CODEX_REVIEW_MAX_TOTAL_BYTES` (a file the sandbox cannot write, set with the
  maintainer's consent), and agy's code mode refused it (`AGY_REVIEW_MAX_TOTAL_BYTES=240000`), so agy read it in four
  diff-mode parts and its code-mode receipt was a recorded degrade. Fix direction: the wrapper picks the file transport
  when the inline payload passes the model's own input cap; the review-state gate accepts a grounded diff-mode receipt
  set that covers the whole staged diff. Residual exposure, live: every large release review needs a consent or a
  degrade. Raised at the KIT-TEXT release.

- **KIT-FOLDER-GONE-RECORD-BRINGS-THE-SPLIT-FOCUS** — invariant: a review-focus line asking to confirm a decomposition
  prints only where one happened. Origin: spec source-size S54 (revision 8, KIT-SCRIPTS S1): a `baseline` or
  `layout.directories` record keyed under `scripts/agent-workflow` reads gone (`entry-gone`, `dir-gone`), a lowered kind
  (`agent-workflow-kit/tools/source-size-judge.mjs:37`), so a check that stops nothing adds `SPLIT_QUALITY_FOCUS`
  (`agent-workflow-kit/tools/source-size-report.mjs:213-215`) as S43 already spares the store record. Fix direction: the
  gone records under the kit folder join the store record's no-focus arm. Residual exposure, NOT live in S1: no
  deployment holds the folder; S4 first makes the state. Raised at the KIT-SCRIPTS S1 spec review (lens, round 1).

- **KIT-FOLDER-SPEC-R8-WORDING-MINORS** — invariant: every sentence of spec source-size revision 8 is true of the code
  and pins one order. Origin: the lens, round 2 of the KIT-SCRIPTS S1 spec review, four minors: (1) S55 and the judge
  part count "tracked matches" before the kind filter (`agent-workflow-kit/tools/source-size-scope.mjs:101`, `:103`,
  `:112`), so a root with kit-folder files plus a symlinked `.mjs` outside it falls under neither note; state it as "a
  scope that judges no file only because the folder is taken away" and "a root that judges no file yet would judge one
  inside the folder"; (2) S52 and the judge part leave the kit-folder line's place against the empty-root notes open —
  the code prints it before them (`source-size-check.mjs:363-364`, `source-size-report.mjs:207-208`): add "and before any
  empty-root note"; (3) the Contract bullet's "every run that judges the tree" covers `--adopt`, which prints no note
  (`source-size-check.mjs:286`): name the three modes; (4) the judge part's "a usage, config, enumeration or scope error
  judge nothing" is false for the `--override` equality stop (`:159`, `:165`): "they and a usage … error print none".
  Fix direction: the four text replacements, in the spec's next revision. Residual exposure, NOT live: specs only.

- **KIT-COMMAND-MIGRATE-GATES-MINORS** — invariant: the migration's reading of a matched customized gate is pinned,
  and its output never reads as done while a line asks for a hand. Origin: the lens, round 1 of the KIT-SCRIPTS S3
  diff review: `agent-workflow-memory/references/scripts/gates/migrate-gates.mjs:365` (`!deadTool`) and `:373` have
  no red test — the S9 dead-tool fixture is a compound cmd that is never matched — and spec S6 names no exception for
  a matched gate the rules hold customized (id `unit-tests`, a dead-tool flag); `:558-563` print "nothing to migrate
  — … already final-run-capable" above REPOINT or kit-not-current WARNING lines. Fix direction: one `main()` case for
  a matched customized gate (no SWITCH, its CUSTOMIZED line and recovery, one REPOINT) with one S6 sentence through a
  spec revision and its review; the no-op line takes the "the warnings below still need a hand" variant when repoints
  or withheld gates exist. Residual exposure, NOT live: unreleased.

- **KIT-TEXTS-GUARD-QUOTED-NAME** — invariant: the kit-texts guard flags a refused command name however the text
  quotes it. Origin: codex, the KIT-SCRIPTS S6 code review (verdict ship, one minor):
  `scripts/testing/kit-texts.test.mjs:25` (`RUN_RE`) captures no name after a quote, so
  `node scripts/agent-workflow/run.mjs "check-docs-size"` is spared although the command refuses it, exit 2; proved
  by a probe of the regex, and no packed text holds a quoted name today. Fix direction: read a name in single, double
  or back quotes, with a Markdown and a JSON case in the suite, through a script-family revision of S12 and its
  review. Residual exposure, NOT live: unreleased, no current hit.

- **GIT-HOOKS-LIMIT-2-NAMES-THE-OLD-FAILURE** — invariant: the part git-hooks' stated limit (2) describes what a hook
  below the work-tree top does. Origin: the KIT-SCRIPTS S4 spec review's last re-read (lens) — kit-command revision 2
  runs the five kit lines behind a test of `scripts/agent-workflow/run.mjs` from the work-tree top, so a project root
  in a monorepo subfolder now commits with those checks skipped and a line naming a fix (merge or upgrade) that does
  not apply, while limit (2) (`docs/ai/specs/kit/install/init-project/git-hooks.md:54`) still says such a hook fails
  every commit. Narrow fix: limit (2) states the skip, its line and that neither named fix applies there.

- **KIT-SCRIPTS-S4-MOVE-MINORS** — invariant: every line the move prints is true of the tree it judges, and a removal
  runs only on proof that the kit folder holds the replacement through plain folders. Origin: round 1 of the
  KIT-SCRIPTS S4 diff review (codex ship, lens ship, each with minors), all in
  `agent-workflow-kit/tools/distribution-files/retired.mjs` unless named: (1) `:31` the suite line prints
  `node --test scripts/<file>` unquoted, so a name holding a space splits (codex); (2) `:46` reads git's exit 128 as
  "outside a git work tree", false under a refused (dubious-ownership) repository (codex); (3) `:13,58,83` `isRegular`
  lstats only the leaf, so a replacement under a linked `docs-size/` or `spec-schema/` folder counts as standing, and
  the scripts op's `FOLDERS` (`scripts.mjs:38`) leaves those folders out (lens); (4) `:51` a dry run of a hidden
  deployment whose kit folder does not exist yet prints the commit line — probed: with `/scripts/agent-workflow/` in
  the exclude, `git check-ignore -q scripts/agent-workflow` exits 1 while the folder is absent and 0 with a trailing
  slash (lens); (5) `:16-21,71-77` an unreadable bundled body is named as the flat file's read error (lens; the code
  record's own note); (6) `agent-workflow-memory/references/scripts/gates/kit-command-gates.mjs:28` `CHECK_FILE`
  admits only `\s"';&|<>()` after a file name, so a backtick or a comma after it gets no repoint line, while spec
  kit-command says only "standing whole" (lens, nit); (7) `retired.test.mjs:256-271` the failed-specs cell stays green
  with the `!result.failed` filter (`ensure-configs.mjs:151`) removed, since a failed outcome carries no
  `placedScripts` (lens, nit); (8) `move.integration.test.mjs:12` imports `KIT_COMMANDS` and never uses it (agy,
  nit). Narrow fixes: (1) quote the path with the kit's shell quoting; (2) name exit 128 as not
  confirmed with git's message; (3) lstat each folder of the replacement path; (4) ask about
  `scripts/agent-workflow/` with the trailing slash, a dry-run hidden cell red first; (5) read the bundle outside the
  flat file's `try` or name the bundled path; (6) add the backtick and comma or state the follow set in the spec;
  (7) a failing specs outcome that carries `placedScripts`; (8) drop the import. Residual exposure, NOT live: unreleased (RELEASE HOLD
  until KIT-SCRIPTS S7).

- **PLAN-SHAPE-GATE-READS-NO-WAIVER** — invariant: a plan-shape finding the maintainer waived for one plan does not
  block that plan's commit. Origin: `agent-workflow-kit/tools/plan-shape.mjs:17` (`MAX_LEDGER_ROWS` 25, no waiver
  path); the KIT-SCRIPTS S4 plan carried 55 rows under the maintainer's waiver, the gate stayed red, and
  `commit-guard --check` refuses any red final receipt — met by the S6 landing and the S4 diff review. Narrow fix
  taken: the finished, reviewed plan renamed to the scratch form before `--final` (the maintainer's choice, option
  1), its only findings the waived cap and T43's `story-owns`. Fix direction: a recorded waiver in a strict config
  that plan-shape reads, through a spec and its review. Residual exposure, NOT live: one plan, already reviewed.

- **KIT-READMES-PROMISE-DEPLOYED-SUITES** — invariant: no kit text says the deployed `scripts/` carries or runs
  suites. Origin: the lens, round 1 of the KIT-SCRIPTS S6 diff review (verdict ship, one minor, outside the diff):
  `agent-workflow-kit/README.md:125` and `README.md:151` call the deployed `scripts/` and hook "(dependency-free,
  `node --test`)", `agent-workflow-kit/README.md:291` says "enforcement scripts (`node --test`, …)", while spec
  script-family keeps every suite off the deployed role and the hook runs no suite. The kit-texts guard reads path and
  command forms only, so it cannot see these lines. Narrow fix: drop `node --test` in the three places, keeping
  "dependency-free", in story S7 before the held release. Residual exposure, NOT live: unreleased (RELEASE HOLD until
  KIT-SCRIPTS S7).

## Closed

- **KIT-COMMAND-S4-SPECS-NAME-THE-COMMAND** — invariant: every sentence of the specs S4 revises is true of the tree
  with the stable kit command in it. Raised by the lens, round 1 of the KIT-SCRIPTS S3 spec review. Closed in story
  S4: distribution-files part scripts revision 7 names `run.mjs` at the kit folder's top (`scripts.md:17`) and
  node-evidence revision 9 names `node scripts/agent-workflow/run.mjs <name>` in the hook residual
  (`node-evidence.md:68`).

- **KIT-COMMAND-GATES-TOKEN-SPLIT** — invariant: every path token of a gate's cmd that names a kit check gets its
  repoint line. Raised by the lens, round 1 of the KIT-SCRIPTS S3 diff review. Closed in story S4: kit-command
  revision 2 reads the repoints by a plain search for each target's file name standing whole
  (`kit-command-gates.mjs:28`, `CHECK_FILE`), S8's cells for `;`, `&&`, `|`, `>`, `)`, `(` and single quotes red in
  the tests session and green after the code session.

- **HOLDERS-ABSENT-LOCAL-HOOK-IS-NO-CANDIDATE** — invariant: an absent `scripts/pre-commit.local` is no candidate of
  the holders scan. Raised by agy at the KIT-SCRIPTS S4 spec review's last re-read. Closed in story S4 by subtraction:
  the one-run move cut the holders scan (`holders.mjs`, `scanHolders`), so the part flat-move lists no candidate.

- **KIT-TEXTS-SPEC-REVIEW-MINORS** — invariant: every sentence of script-family revision 3's kit-texts bullet and S12
  is true of the packed texts and bindable to one test. Raised in round 2 of the KIT-SCRIPTS S6 spec review (all three
  members ship). Closed in S6's tests session, before any binding: the history exclusion names the kit's and memory's
  `CHANGELOG.md` and `migrations/` (the engine packs no `migrations/` and its changelog holds no hit yet); S12 spares
  the manifest's `run.mjs` JSON value; the bullet flags `run.mjs` at any deployment path but
  `scripts/agent-workflow/run.mjs` and `node` running a bare check file, S12 naming `node scripts/run.mjs docs-size`
  and `node check-docs-size.mjs --check-index`.

- **KIT-COMMAND-SPEC-REVIEW-MINORS** — invariant: every sentence of the draft spec kit-command and of script-family
  revision 2 is true of the code it governs. Raised by the lens in the two rounds of the KIT-SCRIPTS S3 spec review.
  Closed in S3's tests session, before any binding: a name is known only as an own key of `KIT_COMMANDS` (S4 adds
  `constructor` and `toString`); script-family's index rule and S4 add that a deployed file imports only deployed
  files; S1 pins the direct-run guard's fail-closed arm in-process; S8 reads a token with its surrounding double quotes
  dropped and adds a quoted compound cell. Its S4-bound minor moved to KIT-COMMAND-S4-SPECS-NAME-THE-COMMAND.

- **SCRIPT-FAMILY-DRAFT-WORDING-MINORS** — invariant: every sentence of the draft spec script-family is true of the
  tree it lays out and each scenario is bindable to one test. Raised by the lens at the last-round re-read of the
  KIT-SCRIPTS S2 spec review. Closed in S2's tests session, before any binding: the four text replacements in the draft
  (the finder's project paths beside the rotator's spawn edge, S4 narrowed to the canon's own imports and S11 added,
  the nested publish.yml glob named, the installer's own header comment in the hook bullet) and plan T12.

- **KIT-REFRESH-LEAVES-EMPTY-DIRECTORIES-TO-THE-USER** — invariant: a kit refresh leaves the home converged with no
  hand step. Raised at the 2026-10-28 host refresh to kit 20.0.0, which kept 70 emptied directories and printed 26
  "yours to remove by hand" lines on every run. Closed in kit 20.0.1 (AD-217): `payload-prune.mjs` removes each
  uncarried directory left empty after the orphan sweep, children first (upgrade-delivery revision 10, S13).

- **LINE-SAFETY-TEST-FULL-RANGE**, **LENS-RELAYS-NAME-NO-TARGET-REFUSAL**, **LENS-DOUBLED-CELL-PROVES-NO-LATER-WRITE**,
  **LENS-HEADING-MATCHER-STOPS-BEFORE-ITS-LABEL**, **LENS-REGION-TEST-COMMENT-NAMES-THE-PRESERVE-POSTURE**,
  **MEMORY-MAP-ROW-OUTRANKS-A-WITHHELD-POINTER** and **MEMORY-MAP-ANCHOR-WRAPPED-AFTER-A-PIPE-READS-WHOLE** — moot,
  closed in kit 20.0.0 (AD-216): each named a defect of `lens-region.mjs`, `rules-regions.mjs`,
  `project-rules/memory-map-row.mjs` or their suites, which KIT-TEXT S1 deletes with the section reconcile, the
  Memory Map row writer, the pointer slots and the entry-file cap they served.

- **STORY-FLOW-S6-EACH-PRIOR-REFRESHES** — invariant: a rules file on each story prior refreshes. Origin:
  `agent-workflow-kit/tools/rules-regions.test.mjs:324-343` pinned the prior count and prior 1's bytes only. Raised
  by codex and the review lens at the story-flow S1 diff review (2026-10-04). Closed by story S7 of
  DISTRIBUTION-FILES-STAY-CURRENT: `lens-region.test/differing-body.test.mjs` judges every Communication and Story
  sessions prior `refreshed` with the canon (rules-regions S22).
- **INIT-PROJECT-S66-REFRESH-CELLS-NAME-NO-ADR-STATE** — invariant: every cell of init-project S66 that expects the
  token `refreshed` names the ADR files' state that token needs. Raised by the EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S9
  spec review (lens, the re-read of round 2). Closed in kit 14.46.0 (AD-198): S66 retired with S65-S70; the scripts
  op's scenarios moved to spec distribution-files (its S14 among them), whose part scripts says a plain run never
  seeds, so no `refreshed` cell can meet `seeded`.
- **UPGRADE-SET-REFRESH-MAY-GROW-A-RECORDED-SIZE-UNSTATED** — invariant: every refresh the upgrade makes without a yes
  states, where the size practice measures `scripts/`, that its growth may stop the next size check. Raised by the
  EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S9 diff review (lens, round 1). Closed in kit 14.46.0 (AD-198): the
  enforcement-script paragraph of `references/modes/upgrade.md` names the growth and the size check's own reasoned
  `--write-baseline`.
- **REPLACE-RUN-EMPTY-UNION-MISSES-A-NEW-EDIT** — invariant: no line of a replace run points at a block below, and a
  file that turns edited during a replace run is reported so the upgrade asks again. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S2 spec review (lens, the last-round re-read). Closed in kit 14.46.0 (AD-198):
  `runReplace` runs each owning op under the replace even on an empty union, so a file found edited there is
  `race-unresolved`, and each owning op's race-unresolved lines under the replace name no block below (only the
  digest-mismatch line, which a fresh block follows, points at one).

- **INSTALLER-SUITE-FAILS-INSIDE-ITS-OWN-HOOK** — invariant: a suite the kit deploys into `scripts/` passes inside the
  pre-commit hook that runs it. Origin: the 4.0.0-8.2.1 `install-git-hooks.test.mjs` linked-worktree cell spawns git
  with the hook's inherited `GIT_*` variables; measured 2026-10-20, a `git commit` whose hook runs that suite fails the
  cell. Narrow fix shipped in memory 8.3.0: both installer suites strip every inherited git variable. Residual, live: a
  deployment keeps its older suite, since the enforcement copy is create-only and no refresh lane carries the tests;
  the generalization is a refresh lane for the deployed suites. Raised by the EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S6
  live walk. Closed in kit 14.42.0 (AD-194) on the narrowed invariant, the installer's two suites pass inside the hook
  a commit from the main worktree runs: the upgrade's enforcement-script ensure refreshes the installer with its two
  suites as one set on every Node deployment; a commit from a linked worktree stays debt row
  LINKED-WORKTREE-COMMIT-STOPS-IN-THE-HOOK.
- **LAYOUT-DECLINE-IS-UNDONE-BY-A-HAND-DELETE** — invariant: turning layout judging off takes a recorded, reasoned
  step. Origin: under source-size revision 3 a present config without the machine key `layout` is not judged on
  layout, and an absent config is judged on layout but on no line, so hand-deleting `layout` or the whole config
  turns a judgement off with only the printed not-judged line to show it. Not folded in S5: the decline design is
  decided; S6's offer of the layout record (the advisor item that stays open on a no) is where it closes. Proof when
  it lands: a deployment whose `layout` key was deleted hears the offer again on its next advisor run. Raised by the
  EVERY-PROJECT-IS-LAID-OUT-BY-MEANING S5 spec review (lens, round 1).
  Closed in kit 14.41.0 (AD-193): the advisor's `source-size.layout` item is offered on every run while the record is
  missing and the setup does not hold it (a stopping check or a root inside `docs/ai/specs` is a stated skip), a no
  writing nothing; proved by S41's deleted-key cell and the S6 live walk.
- **PARITY-RESOLVE-TERNARY** — queued when the fix (one redundant `isAbsolute` ternary spelled twice)
  reached outside the phase that raised it, then FOLDED in a later round of the same step: correcting
  the wrapper-link resolution base required touching both call sites anyway, and the check is no
  longer redundant there — it now decides whether the physical parent has to be resolved at all.
- **PATH-INVENTORY-READS-A-FIELD-VALUE-AS-HELP** — invariant: a reader reached through the MCP lane never treats a
  field value as a flag. Origin: `agent-workflow-kit/tools/path-inventory.mjs:470` answers `--help` or `-h` anywhere
  in argv, so MCP `path_inventory {"paths":["--help"]}` returns the help as a success and inspects nothing. Narrow fix:
  the search's own fix in story S8 of DISTRIBUTION-FILES-STAY-CURRENT (help read only at a flag position, spec
  repo-search S9), repeated in path-inventory's parser with one cell naming `--help` as a path. Residual exposure, not
  live for a file a project holds: a path literally named `--help` or `-h` cannot be inspected through the MCP lane.
  Raised by the S8 spec review (lens).
- **MEMORY-HIDDEN-PLACED-SCRIPT-NEEDS-ITS-EXCLUDE-LINE** — invariant: in a hidden deployment a script the upgrade
  places is git-ignored before the report. Origin: the hidden reconcile runs before the script ensure in upgrade step 2
  and lists only "the `/scripts/*.mjs` you added" (`agent-workflow-memory/references/contracts.md:21`). Narrow fix:
  each placed file's anchored `/scripts/<name>` line appended, append-only, after its write. Residual exposure, as for
  the pair ensures today: the file shows in `git status` until the next upgrade. Raised during the
  DISTRIBUTION-FILES-STAY-CURRENT S4 spec review.
- **MEMORY-DELEGATED-STORE-RUN-THROUGH-A-LINKED-SCRIPTS** — invariant: in delegated mode the pair copy and the ADR
  store run never write through a `scripts` that is not a plain directory. Origin: no survey runs in delegated mode,
  `ls -l` resolves through a linked `scripts` (`agent-workflow-memory/SKILL.md:262-277`), and the rotator's
  `DEFAULT_ROOT` is the link target's parent (`agent-workflow-memory/references/scripts/archive-decisions.mjs:97`).
  Narrow fix: the store run's condition opens with "`ls -ld scripts` shows a plain directory", and in delegated mode a
  `scripts` that is not one is named, its line saying the composition root's upgrade owns it, with nothing copied into
  it and nothing of the store touched. Proof: an S3 token cell. Residual exposure, not live for a deployment whose
  `scripts` is a plain directory: a linked `scripts` in a kit-driven upgrade. Raised during the S4 diff review (lens).
- **MEMORY-SKILL-CONTRACT-ARMS-PINNED-WITHOUT-LABELS** — invariant: each component arm and each pair-ensure copy
  condition is pinned with its label. Origin: `agent-workflow-memory/scripts/skill-contract.test.mjs:53-55` and
  `:82-96` pin the arms and miss the copy condition. Narrow fix: the tokens "Accepted → this ensure owns every bundled
  name, standing or absent, and the pair ensures copy nothing", "Not accepted (a project that declined the enforcement
  offer) → it writes every standing bundled name", and in both the pair and the spec-layer ensure "unless the
  component is accepted (delegated mode judges none), copy a missing". Proof: the label-swap and the "where the
  component is accepted" mutants go red. Residual exposure, not live in the shipped text: a later edit could swap the
  arms with the suite green. Raised during the S4 diff review (lens).
- **SNAPSHOT-PARTIAL-DIR-LEFT-UNNAMED-WHEN-A-LATER-BASE-SUCCEEDS** — invariant: a partial snapshot directory the rotator
  could not remove is named on every exit. Origin: `writeSnapshot` keeps the removal failure only in `failures`
  (`agent-workflow-memory/references/scripts/archive-decisions.mjs:882`), printed only when no base succeeds; a later
  base's success returns at :875 and drops it. Narrow fix: return the notes with the snapshot and log them. Proof: a
  cell whose git-dir removal fails while the temp-dir base succeeds sees the note in the output. Residual
  exposure: a leftover directory under the git dir, outside the work tree, after a failed removal there. Raised during
  the DISTRIBUTION-FILES-STAY-CURRENT S11 diff review.
- **ENSURE-EXIT-1-WITH-A-LEFTOVER-TEMPORARY-FILE** — invariant: `--ensure-current` exits 1 only when the work tree is
  byte-identical. Origin: a failed write whose temporary-file cleanup also fails leaves the `.tmp` in the work tree
  (`agent-workflow-memory/references/scripts/archive-decisions.mjs:577-584`), yet nothing marks a change, so :1370
  returns 1. Narrow fix: the cleanup-failure branch marks the change, exit 3. Proof: a cell failing both the rename and
  the removal sees exit 3. Residual exposure: two failures in a row; the leftover never ends in `.md`, so no reader takes
  it for a document. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S11 diff review.
- **ENSURE-COMBINATION-MESSAGE-ORDER** — invariant: the usage error for `--ensure-current` beside another mode flag
  names `--ensure-current`. Origin: the `--migrate --apply --dry-run` check
  (`agent-workflow-memory/references/scripts/archive-decisions.mjs:988`) runs first, so that combination with
  `--ensure-current` names only the migrate flags. Narrow fix: the ensure check first. Proof: the S13 cell with all
  four flags. Residual exposure: the exit code is 2 either way; only the message is short. Raised during the
  DISTRIBUTION-FILES-STAY-CURRENT S11 diff review.
- **SNAPSHOT-INSIDE-CHECK-DOT-DOT-PREFIX** — invariant: a temp dir inside the project root is never a snapshot base.
  Origin: `isInside` (`agent-workflow-memory/references/scripts/archive-decisions.mjs:846`) reads any relative path
  starting with `..` as outside, so a TMPDIR at `<root>/..tmp` with no usable git dir takes the snapshot inside the
  project. Narrow fix: `rel === '..' || rel.startsWith('..' + sep)`. Proof: an S9 cell with that TMPDIR exits 1.
  Residual exposure: a TMPDIR named so inside the project, off git. Raised during the DISTRIBUTION-FILES-STAY-CURRENT
  S11 diff review.
- **ROTATOR-DIRECTORY-FSYNC-EBADF-ON-AIX** — invariant: once the rename is done, a directory sync the platform does not
  support never changes the exit code. Origin: `DIRECTORY_FSYNC_UNSUPPORTED`
  (`agent-workflow-memory/references/scripts/archive-decisions.mjs:564`) leaves out EBADF, which AIX returns for an
  fsync on a read-only descriptor, the only kind a directory opens as. Narrow fix: add `'EBADF'`. Proof: a cell whose
  injected `fsyncSync` throws EBADF on a directory fd exits 0. Residual exposure: AIX hosts only. Raised during the
  DISTRIBUTION-FILES-STAY-CURRENT S11 diff review.
- **ROTATOR-TEMP-NAME-TEST-PLANTS-THE-OLD-FORM** — invariant: the suite fails when a run's temporary name stops being
  fresh per run. Origin: the cell `a temporary file a killed run left under this pid never stops the re-run`
  (`agent-workflow-memory/scripts/archive-decisions-ensure.test.mjs:427-435`) plants `<target>.<pid>.tmp`, so a fixed
  per-pid name of another form stays green. Narrow fix: leave the leftover by a real interrupted run (rename and its
  cleanup both failing), then re-run. Proof: the cell goes red with `randomBytes` dropped. Residual exposure: the code
  draws a fresh name today; only a regression would go unseen. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S11
  diff review.
- **ROTATOR-TEMP-REOPEN-UNDER-A-NO-OWNER-WRITE-UMASK** — invariant: syncing the temporary file never fails where writing
  it succeeded. Origin: the `'r+'` reopen (`agent-workflow-memory/references/scripts/archive-decisions.mjs:574`) needs
  owner write, which a umask such as 0277 removes from the new file. Narrow fix: on EACCES from the `'r+'` open, sync
  through `'r'` (POSIX accepts it; Windows has no umask). Proof: a cell creating the file 0400 exits 0. Residual
  exposure: a non-root run under a umask that strips owner write. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S11
  diff review.
- **UNCATALOGED-FAMILY-NAMES-AN-OLD-BODY-WITH-A-ROUTE** — invariant: a kit file on an unchanged older kit body is never
  named as a customization. Origin: the agent files writer and the gate hook writer keep no catalog of earlier bodies
  (`agent-workflow-kit/tools/cheap-agents.mjs:221`, `agent-workflow-kit/tools/gate-hook.mjs:112`), so under the
  no-question rule an older body and a differing one read alike and both get the route line. Narrow fix: for a family
  with no catalog, the line stays neutral ("differs from the bundled body — written; a customization belongs in …").
  Carried by stories S6 and S7 when they write those families; story S16 carries it for the two hook writers, whose line
  for a differing kit hook file is `fileLine`'s state `hook` ("differs from the body the kit writes for it"), the same
  for an older body and an edited one. Raised at the epic revision (2026-10-23).
- **PAIRS-ONLY-TREE-LACKS-THE-SHIM** — invariant: every suite the kit leaves in `scripts/` loads. Origin: a tree where
  the specs op seeded the spec-layer pairs and the component is not accepted (the pairs-only tree and a declined one
  alike) has no `_expect-shim.mjs`, so its two pair suites fail at import (`spec-schema.test.mjs:2`,
  `check-docs-size.test.mjs:2`), and the not-placed line calls the pair files no kit script. Narrow fix: the specs op
  places the modules its pairs import, and the line says "no kit script outside the spec layer". Pre-existing on
  HEAD; raised during the DISTRIBUTION-FILES-STAY-CURRENT S12 spec review (2026-10-23).
- **A-RED-BUFFER-DEEPEQUAL-EXHAUSTS-THE-HOST** — invariant: a red cell fails in bounded memory. Origin: Node 24's
  `assert.deepEqual` builds its diff on failure even with a message, printing a Buffer one byte per line, and its
  line diff takes memory of order N·D: one failed compare of a 20 KB Buffer against `null` peaks at 3.2 GB RSS,
  almost all of it outside the V8 heap (measured 2026-10-23). Red-first S12 suites compared script bodies as Buffers,
  and their HEAD run took down the 8 GB WSL host three times; S12's suites now compare sha256 digests. Still open: raw
  byte compares by `deepEqual` in older suites, e.g. `agent-workflow-kit/tools/git-hooks.test.mjs:112`,
  `:185`, `:202`, `:451` (35 suites match `deepEqual(readFileSync(`, the utf8 ones harmless). Narrow fix: a
  test-hygiene check refusing a `deepEqual` over a Buffer-valued operand, the compares moved to digests.
- **DRY-STORE-LINE-NAMES-WRITES-AND-NO-REFUSAL** — invariant: the scripts op's dry store line claims only writes that
  exist and names the refusal outcome. Origin: `agent-workflow-kit/tools/distribution-files/scripts.mjs:140`
  (`WOULD_STORE`) says the run "would run after the writes" on a dry run with nothing due, and promises "bringing the
  store current or writing nothing" where the plain run would fail `adr-store-not-current`. Narrow fix: the line reads
  `ADR store: scripts/archive-decisions.mjs --ensure-current would run last; it brings the store current, writes nothing
  when it already is, or fails this step when it refuses`, with the part and its cells. Residual: preview only; the
  upgrade never runs the dry run. Raised during the DISTRIBUTION-FILES-STAY-CURRENT S10 diff review (2026-10-23).
- **UPGRADE-STORE-RUN-TEXT-OMITS-SNAPSHOT-AND-QUIET-RELAY** — invariant: `upgrade.md` names every write of the scripts
  op's store run and says its lines are relayed only where they are. Origin:
  `agent-workflow-kit/references/modes/upgrade.md:36` lists the store run's writes without the migration snapshot (the git dir, or the OS temp dir off git), and `:46`
  says "its lines are relayed" while an `already-current` exit relays no standard output line. Narrow fix: `:36` adds
  "and snapshots the moved files into the git dir (the OS temp dir off git)"; `:46` reads "when it moves the store, its
  lines are relayed under `ADR store: `"; the byte pin in `recommendations-language-contract.test.mjs` follows.
  Residual: an omission in the agent-facing doc; the op's own lines are true. Raised during the
  DISTRIBUTION-FILES-STAY-CURRENT S10 diff review (2026-10-23).
- **RULES-RECORDED-MERGE-ENTRY-HAS-NO-DRY-RUN-READING** — invariant: a dry run judges a recorded-merge entry as the real
  run over the same tree does. Origin: `docs/ai/specs/kit/project-rules/rules-ensure.md` ("With a local file" bullet)
  and project-rules S20 judge the entry against "the kit file as this run leaves it", which read literally on a dry run
  is the edited bytes, while `planTheme` (`rules-ensure.mjs:69-72`) uses the template on both runs. Narrow fix: both
  read "as this run leaves it or, on a dry run, would leave it", and a dry-run cell beside each S20 recorded-merge cell.
  Residual: the code is right; only a cell written from the words could pin the wrong dry run. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S5 spec review (round 2).
- **RULES-PENDING-REPLACE-NO-OTHER-PATH-UNPINNED** — invariant: a replaced kit file leaves no copy in any state. Origin:
  project-rules S17 states "creates no other path" only with no local file, and S20's words forbid only the local and
  effective writes, so they let a copy stand beside the kit file in the `pending` branch (an edited kit file, a local
  file, an entry recording the edited digest). Narrow fix: S20's pending-replace clause adds "the kit file the only path
  written or created". Residual: no code writes a copy, and the S20 pending cells already assert that the kit file is
  the only path changed (`rules-ensure.test.mjs:243`). Raised by the DISTRIBUTION-FILES-STAY-CURRENT S5 spec review
  (round 2).
- **ENTRY-POINTER-OLD-LINES-NAME-SLOT-AND-FRAGMENT** — invariant: no human sentence the entry-file reconcile prints
  names a slot, marker, fragment or anchor (`agent-workflow-kit/references/shared/deploy-tail.md:15`). Origin: two
  lines that predate story S18 do: the cap error `injection would push AGENTS.md to <n> lines (cap <m>) — trim the
  fragment or the file` (`agent-workflow-kit/tools/inject-methodology.mjs:177`) and the explicit form's
  `methodology slot already present and filled — nothing to do (zero-diff).` (`:412`). Narrow fix: `writing the
  pointer would push AGENTS.md to <n> lines (cap <m>) — trim the file` and `methodology pointer already present and
  filled — nothing to do (zero-diff).`, moving the machine key `isFillCapRefusal` and the chained lanes read
  (`injection would push`, `(cap `) with the words, and the cells that pin both lines. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S18 spec review (round 1).
- **ENTRY-POINTER-TEMP-CLEANUP-FAILURE-UNREPORTED** — invariant: no failure of the entry-file reconcile's write is
  silent. Origin: a failed write or rename removes the temporary file with `rm(tmp, { force: true }).catch(() => {})`
  (`agent-workflow-kit/tools/inject-methodology.mjs:385`), so a failed removal leaves the temporary file beside
  `AGENTS.md` with no line; spec entry-pointers states it as a limit. Narrow fix: on a failed removal, reject with the
  write's error carrying the temporary path, and one cell where the write and the removal both fail. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S18 spec review (round 1).
- **RULES-MODE-ZERO-DIFF-OMITS-THE-CAP** — invariant: every zero-diff sentence about the entry file is true of an
  over-cap file. Origin: `docs/ai/specs/kit/project-rules/rules-mode.md:71-73` says a deployment whose pointers equal
  the engine's fragments and whose rows are current reconciles to a zero-diff no-op, while a file past 100 lines is
  the over-cap error, exit 1 (`agent-workflow-kit/tools/inject-methodology.mjs:234-236`); the gap predates story S18.
  Narrow fix: after `whose Memory Map rows are current` insert `, the file within the cap,`. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S18 spec review (round 2).
- **MEMORY-MAP-ANCHOR-WHOLE-ROW-TEST-UNSTATED** — invariant: the anchor row's multi-line skip has one stated test.
  Origin: from story S18 a theme's row is whole by four unescaped `|` and an unescaped closing `|`
  (`docs/ai/specs/kit/project-rules/memory-map-row.md`), while the anchor's skip ("that row on more than one line")
  names no test and `agent-workflow-kit/tools/project-rules/memory-map-row.mjs:69` uses `isWhole`; an anchor broken
  after its read-when cell, ending with `|`, gets a row inserted between its halves under `isWhole`. Narrow fix: the
  anchor reason reads `it has that row on more than one line (its line does not, trailing spaces aside, end with |)`,
  or names the theme row's test, with one S28 cell. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S18 spec review
  (round 2).
- **ENTRY-POINTERS-S11-BOUND-OPENS-A-BRACKET** — invariant: every slice bound a scenario names reads as one unit.
  Origin: spec entry-pointers S11's step-4 start bound is the literal `` `pointers` slot (workflow-methodology ``,
  whose `(` opens inside the scenario's own parenthetical and never closes, so a reader works out where the bound
  ends. Narrow fix: quote each bound in a code span. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S18 spec review
  (round 2 re-read).
- **ENTRY-POINTER-OUTCOME-LISTS-OMIT-REFRESHED** — invariant: every shipped list of the pointers outcomes names each
  outcome the reconcile prints. Origin: a known earlier pointer prints `refreshed the <name> pointer to the current
  canon` (`agent-workflow-kit/tools/inject-methodology.mjs:284`), while the `pointers` row of
  `agent-workflow-kit/references/modes/upgrade.md:13`, its step-4 relay (`:117`) and the run-list's pointers outcomes
  (`agent-workflow-kit/tools/upgrade-runlist.mjs:26`) name no refreshed pointer; the gap predates story S18. Narrow
  fix: `refreshed` after `already present` in the three lists, moving the run-list cells
  (`agent-workflow-kit/test/upgrade-runlist.test.mjs`) and the upgrade.md byte pin
  (`agent-workflow-kit/test/recommendations-language-contract.test.mjs`). Raised by the DISTRIBUTION-FILES-STAY-CURRENT
  S18 diff review (copy pass).
- **ENTRY-POINTER-WRITE-REMOVES-A-NESTED-PAIR** — invariant: a write over a pointer never removes another pointer's
  marker. Origin: `reconcileMarkerSlot` (`agent-workflow-kit/tools/inject-methodology.mjs:226-244`) writes a differing
  slot whose content holds another slot's ordered pair (the methodology pair nested in the orchestration pair), so the
  file is written with no methodology pointer, exit 0, while its line reports the methodology pointer as landed
  (already present, filled, refreshed or written); each pair alone reads `ok`, though
  `agent-workflow-kit/references/shared/composition-handoff.md:42` names a nested slot malformed. Narrow fix: only a
  later slot whose content holds an earlier slot's marker (the methodology marker in the orchestration or autonomy
  slot, the orchestration marker in the autonomy slot) answers the error `the <label> pointer holds another pointer's
  marker — refusing to write`, the slot's STOP, with one S1 cell. Residual: only a hand-nested pair reaches
  it. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S18 diff review (round 1).
- **ENTRY-POINTER-MALFORMED-STOP-CELL-READS-NO-STDERR** — invariant: a slot whose ensure answers error reads no
  fragment. Origin: the malformed-slot cell (`agent-workflow-kit/tools/inject-methodology.test.mjs:959-965`) asserts
  only a rejection and an unchanged file, so dropping the `markerSlotEnsurable` guard
  (`agent-workflow-kit/tools/inject-methodology.mjs:392`) STOPs on the absent engine instead and stays green. Narrow
  fix: run it through `runCli` with the engine absent, asserting exit 1, the `reconcile refused — expected exactly one
  start/end marker pair` line and no `engine not found`; the same for a markerless file with no anchor. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S18 diff review (round 1).
- **MEMORY-MAP-ROW-TRAILING-SPACES-CELL-MISSING** — invariant: a whole row with spaces after its last `|` is written,
  never skipped as split. Origin: no cell of `agent-workflow-kit/tools/project-rules/memory-map-row.test.mjs:161-227`
  (S35, S37) has one, so `isOneRow` without `.trimEnd()` (`agent-workflow-kit/tools/project-rules/memory-map-row.mjs:29`)
  stays green. Narrow fix: an S35 cell over every theme's row with three trailing spaces, answering written. Raised by
  the DISTRIBUTION-FILES-STAY-CURRENT S18 diff review (round 1).
- **ORCHESTRATION-NOTE-CRLF-PRIOR-CELL-MISSING** — invariant: a note that is an earlier release's body reads prior in
  any line-end form. Origin: spec orchestration-note S1 judges every `KNOWN_PRIOR_README` entry only in its exact bytes,
  so a `readmeState` that normalizes only the current note reads a CRLF prior as differing and prints the written-over
  line with the route for a kit body. Narrow fix: S1 gains one prior entry with CRLF line ends and trailing spaces,
  answering prior. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S19 spec review (round 1).
- **ORCHESTRATION-NOTE-NON-STRING-READS-TWO-WAYS** — invariant: every clause of the note's judgement gives one answer
  per input. Origin: spec orchestration-note's judgement bullet says current after `normalizeCanonical` and differing
  for a non-string value, but `normalizeCanonical` takes `String(value)`
  (`agent-workflow-kit/tools/orchestration-readme.mjs:1`), so `[CANON_README]` reads both ways; the op never meets one
  (`loadConfig` refuses a non-string `_README`, `agent-workflow-kit/tools/orchestration-config.mjs:220`). Narrow fix:
  a non-string value is differing, judged before any normalization, with one S1 cell over a one-element array. Raised
  by the DISTRIBUTION-FILES-STAY-CURRENT S19 spec review (round 1).
- **ORCHESTRATION-NOTE-RACE-LINE-UNPINNED** — invariant: the race's written line is the differing note's line with
  the seed's temp-file note after it. Origin: spec orchestration-note S3 pins the token and the file after the race,
  not its line, so a race path that drops the route or the temp-file note stays green. Narrow fix: S3 asserts the line
  ends with `NOTE_ROUTE` and, with a leftover temp file, the temp-file note follows it. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S19 spec review (round 1).
- **NOTE-ROUTE-SENDS-TEXT-INTO-A-CAPPED-FILE** — invariant: following a route never stops the upgrade bringing a kit
  part current. Origin: `NOTE_ROUTE` and `POINTER_ROUTE` send the user's text into `AGENTS.md`, whose cap is 100 lines
  (`agent-workflow-kit/tools/inject-methodology.mjs:35`); a long note moved there can bring the file past the cap, and
  the next reconcile soft-skips the orchestration pointer (spec entry-pointers, the two chained slots). Narrow fix: the
  route sentence says a long note goes in a file of the user's own that a line beside the pointer names. Raised by the
  DISTRIBUTION-FILES-STAY-CURRENT S19 spec review (round 1).
- **ENSURE-OPS-ORCHESTRATION-COMMENTS-UNPINNED** — invariant: the module's own header and comments describe the
  orchestration op it runs. Origin: spec orchestration-note says the `ensure-ops.mjs` header and orchestration comments
  describe the rule, but no scenario reads them, so a header still naming `refreshReadme` and a still-canonical note
  (`agent-workflow-kit/tools/ensure-ops.mjs:17-19,107-110`) stays green, where distribution-files S24 pins the same
  header for the scripts rule. Narrow fix: S7 gains the header and its orchestration comments naming `readmeState` and
  no `refreshReadme`, still-canonical or customized. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S19 spec review
  (round 2).
- **ORCHESTRATION-PARAGRAPH-MAY-NAME-THE-RETIRED-TOKEN** — invariant: no shipped orchestration paragraph says the op
  answers a token it never answers. Origin: spec orchestration-note S7 sets every backticked token of the closed
  vocabulary aside, `customized-preserved` included, and checks the token arm alone for that token, so a rewritten
  `agent-workflow-kit/references/modes/upgrade.md:38` keeping a tail such as "→ `customized-preserved`" stays green.
  Narrow fix: S7 and the contract's shipped-text bullet add that the orchestration paragraph names no
  `customized-preserved`. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S19 spec review (last-round re-read).
- **ORCHESTRATION-NOTE-S2-SLOT-ORDER-UNPINNED** — invariant: every slot inside an activity keeps its order through
  the note's write. Origin: `agent-workflow-kit/tools/ensure-ops.test.mjs:547` compares `Object.entries(configOf(dir))`,
  and `assert.deepEqual` does not compare key order inside nested objects, so a write that rebuilds each activity in
  the kit's slot order stays green. Narrow fix: compare `JSON.stringify(configOf(dir))` with
  `JSON.stringify({ _README: CANON_README, ...RECIPES })`. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S19 diff
  review (round 1).
- **SOURCE-SIZE-JUDGE-TIGHTEN-CLAUSE-OVERREACHES** — invariant: the judge part states which warnings bring the
  paste-ready regeneration. Origin: `docs/ai/specs/kit/source-size/judge.md:51-52` says "A lowered or removed record
  warns with the same paste-ready regeneration", but `aggregate-stale` and `aggregate-root-gone` are outside
  `LOWERED_KINDS` (`agent-workflow-kit/tools/source-size-judge.mjs:37`) and `checkReportLines` adds the tighten line
  only when `hasLoweredRecord` or `hasStoreRecord` holds (`agent-workflow-kit/tools/source-size-report.mjs:208-210`),
  so a green check
  whose only removed record is an aggregate budget prints no regeneration line. Narrow fix: judge.md names "a lowered
  or removed file or layout record", as layout.md does from revision 5. Raised by the S11 spec review of
  EVERY-PROJECT-IS-LAID-OUT-BY-MEANING (lens, round 2).
- **REPO-SEARCH-OVERSIZED-FILE-ENDS-THE-WALK** — invariant: a file over the per-file bound is skipped and the walk goes
  on. Origin: `readRegularFile` sets `state.incomplete` for a file over `maxBytes`
  (`agent-workflow-kit/tools/repo-search.mjs:291-297`), and `walk` returns at once while `state.incomplete` is set
  (`:381`), so one large file (`docs/ai/history/queue-purge-archive.txt`) turns a search of the whole tree into "no
  matches" plus INCOMPLETE, exit 3. Narrow fix: the per-file skip records its own flag, reported as INCOMPLETE at the
  end, and only the result, walk and total budgets stop the walk; one cell with a large file before a matching one.
  Residual exposure, live: callers pass `--max-bytes 67108864`. Raised by the S10 plan session of
  EVERY-PROJECT-IS-LAID-OUT-BY-MEANING.
- **BRIDGES-HAVE-NO-CHOOSE-AN-OPTION-CONSULT-FORM** — invariant: a consult that asks a bridge to choose between options
  gets the choice back with a receipt. Origin: `codex-review plan` judges a plan and answers ship or revise, so a
  choice question came back as ship with no choice; `agy-review` refuses any verdict outside SHIP, SHIP WITH NITS and
  REWORK with exit 4 and no receipt (`antigravity-cli-bridge/bin/agy-review.sh:2249-2254`), so `Verdict: C` was lost.
  Narrow fix: none inside one bridge; a consult brief asks for a review verdict and puts the choice in the body.
  Residual exposure, live: each choice consult costs a re-run. Raised by the DISTRIBUTION-FILES-STAY-CURRENT S19 consult.
- **GATE-APPROVE-HOOK-ASKS-ON-A-QUOTED-METACHARACTER** — invariant: a read-only search or a file write the agent has a
  no-prompt lane for reaches no human prompt. Origin: the hook asks on a seeded read-only command carrying a
  redirection, a command substitution, an `--output` flag or a line continuation, quoted or not, and only that ask
  hints the lane to the caller (`agent-workflow-kit/references/hooks/gate-approve.mjs:34-38,:318`); its opt-in
  read-lane allows no metacharacter at all, and any other command gets no decision from it and no hint (`:39-46`); it
  never denies (`:46`), so a quoted grep pattern or a shell redirect still prompts the maintainer. Narrow fix: none in the hook (the
  string-level scan cannot tell a quoted byte safely); the hint names the MCP `repo_search` and the Write tool.
  Residual exposure, live: every such call is one prompt. Raised by the S10 spec session of
  EVERY-PROJECT-IS-LAID-OUT-BY-MEANING.
- **REVIEW-LOOP-COSTS-OF-THE-JEV-S13-RELEASE** — invariant: the review loop ends with no run spent on a known false
  stop. Origin, each measured on the JEV epic's S13 release (2026-10-07): (1) a codex `revise` carrying only minors is
  a recognized negative, so `review-state` vetoes it (`agent-workflow-kit/tools/review-state-judge.mjs:138,261`); (2)
  release copy written after the diff review is re-checked one sentence at a time (the re-check rule,
  `agent-workflow-engine/references/procedures.md:129-134`), three re-checks for 13 copy findings; (3) the one-run agy
  raise to 420000 bytes sits near the CLI's edge over the 240000 default (`antigravity-cli-bridge/bin/agy-review.sh:482`);
  (4) a ship verdict over a numbered Blocking item exits 4 with no receipt (`agy-review.sh:2257-2264`); (5) Fold + loop
  (`procedures.md:48`) names no stop when folds breed new states; (6) a re-check that is not ship-class goes to the
  maintainer (`procedures.md:131-133`), a stop only a human lifts. Narrow fix per item: (1) the canon tells codex to
  answer ship with minors; (2) the copy is staged and lens-read before round 1; (3) a facts file that keeps the total
  under 240000; (4) re-run once, then degrade; (5) Fold + loop names the stop the planning canon states; (6) none,
  the maintainer's rule. Residual exposure, live: each item costs a run or an ask.
- **KIT-TOOL-STOPS-OF-THE-JEV-S13-CODE-AND-RELEASE** — invariant: a kit tool's refusal names a route that works. Origin:
  (1) `run-gates --pre-review` runs no `coverage-check` (`agent-workflow-kit/tools/run-gates.mjs:105-106`), so an
  uncovered branch shows only at `--final`, after the council; (2) `--write-baseline` lists files through
  `git ls-files -s` (`agent-workflow-kit/tools/source-size-scope.mjs:64`), so a new untracked file is left out and the
  record under-counts it; (3) `dispatch open --retry-of` refuses a retry whose brief was stamped on a newer checkpoint
  (`agent-workflow-kit/tools/dispatch-store-read.mjs:211`) and names no route, while a fresh thread at retry index 0
  on the new checkpoint works. Narrow fix per item: (1) `--pre-review` prints the `coverage-check.mjs --check` line to
  run next; (2) the baseline writer names untracked files under a declared root; (3) the refusal names the fresh
  thread. Residual exposure, live: each costs a late red or a lost retry. Raised by the JEV S13 code session.
- **KIT-APPLY-MEETS-THE-HARNESS-DIALOG** — invariant: a kit apply the user said yes to in chat reaches the user only as
  the harness's own consent. Origin: the sandbox protects `.claude/` (its settings files, skills and hooks), so an
  apply into it meets the harness dialog. Narrow fix: none the kit can make alone; a route with no dialog needs a
  narrow allow rule and a kit-writer exclusion, which is the maintainer's call. Residual exposure, live: one harness
  dialog per such apply. Raised by the S6 spec session of EVERY-PROJECT-IS-LAID-OUT-BY-MEANING.
- **COMMIT-HOOK-RUNS-THE-HOST-KIT-CHECKS** — invariant: a release that changes what the hook's checks read is told so
  before its own commit. Origin: the rules and layout lines name the tools path of the kit that wrote them
  (`agent-workflow-kit/tools/git-hooks.mjs:71-72`, `TOOLS`), in this repository the host install
  (`.git/hooks/pre-commit:17-18`, `~/.claude/skills/agent-workflow-kit/tools/…`), so the commit of a kit release runs
  the previous release's checks over the new tree; nothing says so before `release-run` reaches its commit stage.
  Narrow fix: `release-run --plan` names the hook lines whose tool differs from the repository's own and the host
  refresh that clears them. Residual exposure, live: the 19.4.0 release stopped at `commit` until a record went back
  with its reason and the host refresh; at kit 20.0.0 the host 19.5.0 rules check refused the moved record (`theme
  communication is not in the registry`) until the work-tree kit was installed on the host before the commit, the
  maintainer's choice. Raised by the S10-S12 release of EVERY-PROJECT-IS-LAID-OUT-BY-MEANING.

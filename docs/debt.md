# Debt queue

Rows queued out of a review round instead of folded. Each carries a stable id the flow store's
`queued` disposition binds to. A row leaves this file only when the work lands.

- **JEV-SANDBOXED-WRAPPER-NEEDS-NO-USER-STEP** — invariant: a delegated run reaches Jev with no hand settings edit by
  the user. Origin: on 2026-10-06 Claude Code 2.1.291 ran an agent's plain `codex-review` inside its sandbox although
  the project lists it in `excludedCommands`. The hosts half closed with AD-172 (kit 14.24.0): `velocity-profile
  --bridge-tier` seeds the placed bridges' declared hosts into `sandbox.network.allowedDomains` (spec velocity-profile).
  What stays: the bridges' writable state dirs (`writableDirs`), which no kit writer seeds, so where the harness
  sandbox keeps them read-only the user still adds them to `sandbox.filesystem.allowWrite` by hand. Partial work that
  keeps the row: a wrapper stderr hint naming the missing hosts on a harness-proxy 403, and the harness clause in
  `tools/velocity-profile.mjs`'s printed tier notice, `--help` and `--autonomy` detail (:702, :392, :1548, under the
  pinned `HOST_HONORS_QUALIFIER`). The fix is the no-step route (launch the wrappers outside the Bash sandbox, e.g.
  through the kit's MCP server), a story, since it routes around a sandbox an admin may mandate. Proof, the only one
  that closes the row: a sandboxed agent's plain `codex-review`, after the tier's run, gets a Jev answer with no hand
  `allowWrite` edit.
- **BRIDGE-TIER-HOSTS-REMOVED-ON-AUTONOMY-ADVICE-REFIRE** — invariant: a host the user removed on the kit's own advice
  is not offered back without saying why. Origin: the `--autonomy` preview reports the tier-seeded hosts as a network
  weakening and says "remove it by hand" (`agent-workflow-kit/tools/velocity-profile.mjs:1620`); after that removal
  the Recommendations bridge-tier item fires again (`recommendations.mjs:469`, spec velocity-profile). Narrow fix: the
  degrade detail names `--bridge-tier` as the source of hosts equal to the placed bridges' declared hosts and says a
  removal re-fires the item. Proof: a preview over tier output prints that note. Residual: an optional item re-offers
  what the user chose to remove. Raised by the S11 spec review (lens).
- **BRIDGE-TIER-FLAGLESS-READS-NO-MANIFEST-UNPINNED** — invariant: a flagless or `--kit-tools` velocity run reads no
  bridge manifest. Origin: spec velocity-profile S4 pins the manifest STOP only on `--bridge-tier`; the advisor's
  core plan has no catch (`agent-workflow-kit/tools/recommendations.mjs:452-455`), so a manifest read on every mode
  would turn a broken bundle into a crash there. Narrow fix: one cell running the flagless and `--kit-tools` writer
  over an unreadable bundle root with today's result. Raised by the S11 spec review (lens).
- **BRIDGE-TIER-ADVISOR-ON-WRONG-TYPED-NETWORK-KEY-UNPINNED** — invariant: a wrong-typed project network key or an
  unreadable manifest makes the Recommendations bridge-tier item a stated skip, never an offer the apply refuses.
  Origin: the shared velocity preflight takes no flag (`agent-workflow-kit/tools/velocity-profile.mjs:903`), so where
  the S11 network check lives decides the advisor's outcome (`recommendations.mjs:445-450,468-474`), and spec
  velocity-profile does not pin it. Narrow fix: one advisor cell over `allowedDomains: "<string>"` expecting the skip
  line. Raised by the S11 spec review (lens, round 2).
- **BRIDGE-TIER-S1-ZERO-HOSTS-COUNT-UNPINNED** — invariant: with no bridge placed a `--bridge-tier` run prints no
  `allowedDomains` count line. Origin: `agent-workflow-kit/tools/velocity-profile.test.mjs:1114` asserts no match on
  `entries: [1-9]`, which an `entries: 0` line passes; the code gates the three lines on `hostsToAdd +
  hostsAlreadyPresent` (`agent-workflow-kit/tools/velocity-profile.mjs:715`). Narrow fix:
  `assert.equal(listedHosts(r.stdout), undefined)`. Residual: not live, the line is not printed today. Raised by the
  S11 diff review (lens).

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
- **LINE-SAFETY-TEST-FULL-RANGE** — the `UNSAFE` byte list in
  `agent-workflow-kit/tools/lens-region.test.mjs` samples 11 boundary code points while the
  comment and the composer contract claim the full C0/DEL/C1/U+2028/U+2029 range; generate the
  array from the complete ranges (U+0000–U+001F, U+007F–U+009F, U+2028, U+2029) and use it in both
  checks, so a byte the composer misses cannot slip between samples. Queued at the Phase-1 round
  cap (a test-breadth minor; the composer itself already covers the full range by construction);
  land it with the next lens-region-touching Step of this plan.
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
- **STORY-FLOW-S6-EACH-PRIOR-REFRESHES** — `agent-workflow-kit/tools/rules-regions.test.mjs:324-343` pins the
  story prior count and prior 1's bytes, never that a rules file on each prior refreshes; a reconcile that read
  only `priors[0]` (`lens-region.mjs:95`) stays green. Narrow fix: for every story prior, `reconcileStoryText`
  returns `refreshed` with the template body. Raised by codex and the review lens at the S1 diff review (2026-10-04).
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
  computed `reviewed` (`agent-workflow-kit/tools/recipes.mjs:246`), so `recipes --active-line` prints
  `epic.review = reviewed (computed default) → codex-review` (`recipes-shorthand.test.mjs:28`) and `status` prints
  `epic.review: reviewed (default)` (`family-registry.test.mjs:1114`); `orchestration-readme.mjs:74` and the seed
  `references/templates/orchestration.json:2` say it "is reviewed as soon as a review backend is ready"; the tier
  offer previews `epic.review = reviewed` and `task.author = delegated` (`tier-preview.test.mjs:93`); a delegated
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

## Closed

- **PARITY-RESOLVE-TERNARY** — queued when the fix (one redundant `isAbsolute` ternary spelled twice)
  reached outside the phase that raised it, then FOLDED in a later round of the same step: correcting
  the wrapper-link resolution base required touching both call sites anyway, and the check is no
  longer redundant there — it now decides whether the physical parent has to be resolved at all.
- **INIT-LISTS-ONLY-USER-ITEMS-UNDER-ARGV-SELECTION** — invariant: `init` lists, besides its previewed variants, only
  the user-lane variants with no argv, never a pending chat item. Origin: under argv-presence selection every chat
  variant answers no argv (`agent-workflow-kit/tools/write-lanes.mjs:151-152`), so the spec init-project sentence "a
  pending variant with no argv is listed with its text" would list chat items (`init-project.mjs:185`, `:233-235`).
  Narrow fix: name the listed set in the root's Order-and-consent bullet. Raised by the S1 spec review (lens 12).
- **DANGER-CHECK-USAGE-EXITS-INCOMPLETE** — invariant: every malformed invocation of the danger check exits 2 with
  nothing read. Origin: the part apply-danger-check's exit table names no exit for a missing `--variant`, a missing
  `--cwd` or a relative `--claude-dir` (jev-skill rejects a relative dir, `agent-workflow-kit/tools/jev-skill.mjs:47-48`).
  Narrow fix: the three join exit 2 and S23. Raised by the S1 spec review (lens 14; agy round 2, minor 2).
- **DANGER-CHECK-DIGEST-BINDS-WRITTEN-BYTES-UNPINNED** — invariant: the bytes an apply writes are the bytes whose sha256
  the user saw. Origin: S22's real-apply cell compares settings diffs and changed paths, not the printed `writes: …
  sha256:` values with the written bytes (`agent-workflow-kit/tools/gate-hook.mjs:310`, `cheap-agents.mjs:203`), and no
  cell changes a planned file's content between check and apply. Narrow fix: compare the hashes, and one cell changing
  the content after the check expects exit 5 with nothing spawned. Raised by the S1 spec review (codex round 2, minor 2).
- **DANGER-CHECK-EXIT-3-SPAWNS-NOTHING-UNPINNED** — invariant: no exit of the danger check other than an equal digest
  spawns a writer. Origin: S23 names nothing spawned on 1, 2 and 5, not on 3 (a writer's dry-run refusal or a masked
  file). Narrow fix: S23 reads "1, 2, 3 or 5". Raised by the S1 spec review (agy round 2, minor 1).
- **DANGER-CHECK-GROUNDING-RULE-UNBOUND** — invariant: every bridge-tier allow entry is bound to its exact form. Origin:
  the part apply-danger-check admits "the quoted grounding rule naming KIT_GROUNDING_TOOL" at any path and with
  codex-review alone placed, while the writer emits exactly `Bash(node "<KIT_ROOT>/tools/grounding.mjs":*)` only with
  agy-review placed (`agent-workflow-kit/tools/velocity-profile.mjs:251-256`). Narrow fix: bind it to that form, only
  with agy-review placed, plus a planted S22 cell. Raised by the S1 spec review (lens round 2, minor 4).
- **DANGER-CHECK-TYPESAFE-PREFIX-LITERAL** — invariant: the danger check keeps the jev word-surface rule. Origin: the
  part prints `temporary: <parent>/.typesafe-ai.kit-tmp-*`; the prefixes are private to jev-skill.mjs (:20-21) and the
  surface rule (jev-guide S12, `agent-workflow-kit/tools/jev-guide.test/surface.test.mjs:18`, `:257`) refuses a line
  carrying the word outside a jev key or leaf. Narrow fix: derive the prefix from the `typesafe-ai` basename of
  skillTargets' path, or export the prefixes from the facts leaf. Raised by the S1 spec review (lens round 2, minor 5).
- **APPLY-SLOT-DIGEST-SUFFIX-QUOTING** — invariant: the slot's apply line ends in the literal ` --apply --expect
  <digest>`. Origin: the part write-lanes says each element after `node` passes through `quoteArg`, which would render
  `'<digest>'` (`<` and `>` are outside its safe set, `agent-workflow-kit/tools/jev-facts.mjs:16-17`). Narrow fix: quoteArg
  builds the check line; the suffix is literal. Raised by the S1 spec review (lens round 2, minor 6).
- **JEV-SKILL-HEADER-SAYS-THE-USER-RUNS-IT** — invariant: no shipped comment states who runs an item contrary to the
  lanes. Origin: `agent-workflow-kit/tools/jev-skill.mjs:3-5` says the USER runs the apply in a terminal of their own;
  under revision 8 the agent applies it through the jev-skill item; S1 keeps jev-skill.mjs unchanged. Narrow fix: the
  comment names the agent's route and the user's terminal as the alternative (the epic's S6 shares the file). Raised by
  the S1 spec review (lens round 2, minor 7).
- **DANGER-CHECK-CREATED-DIR-TWO-PRINT-FORMS** — invariant: each path the check prints has exactly one line form. Origin:
  the part apply-danger-check prints a created directory as `writes: <dir>/ created` (scope bullet) while the result
  bullet prints "every other file or directory it would create or replace" as `writes: <path> sha256:<hex>`, so
  cheap-agents creating `.claude/agents` (`agent-workflow-kit/tools/cheap-agents.mjs:197`) matches both. Narrow fix: the
  result bullet reads "every other file, and each directory it fills whole". Raised by the S1 re-read (lens).
- **JEV-GUIDE-INDEX-SKILL-COMMAND-THIRD-COPY** — invariant: every restatement of who applies the Jev skill says the agent
  applies it only through the advisor's jev-skill item. Origin: `docs/ai/specs/kit/jev-guide/index.md:21` still says
  flatly "the skill command is the agent's — the harness lane, applied on the chat yes after the danger check", while
  STEP 2's line is the user's own where no item shows (jev-steps.md:136-138). Narrow fix: "the skill command, through the
  advisor's jev-skill item, is the agent's". Raised by the S1 re-read (lens).
- **DANGER-CHECK-IN-INIT-READS-PROCESS-ENV** — invariant: `init`'s in-process check judges the environment its spawned
  writers get. Origin: `findOnPath` reads `process.env` (`agent-workflow-kit/tools/velocity-profile.mjs:241`) while
  init spawns writers with `deps.env` minus the GIT_* variables (`init-project.mjs:160`, `:337-339`); equal in
  production, different in every batch cell; outside a project the jev-skill check has no root. Narrow fix: `checkApply`
  derives `findWrapper` and `env` from `facts.env` and takes root null for jev-skill. Raised by the S1 spec review (lens 16).
- **JEV-CONNECT-USER-STEP-WIN32-QUOTING** — invariant: a user step printed for the user's own terminal is quoted for
  that terminal. Origin: the part write-lanes quotes the jev-connect user step with `quoteArg` on every platform, while
  on win32 the place is a PowerShell terminal and `connectLine` has a PowerShell form
  (`agent-workflow-kit/tools/jev-facts.mjs:17`, `:22-24`). Narrow fix: on win32 the user step uses `connectLine`'s form.
  Residual: native Windows is unmeasured. Raised by the S1 spec review (lens 17).
- **DANGER-CHECK-SCALAR-REMOVAL-CLASS** — invariant: a scalar key removed from the settings is classed by the default
  it falls back to. Origin: the part apply-danger-check classes list removals only; `classOf` classes every scalar
  removal as `nothing widened` (`agent-workflow-kit/tools/apply-danger-check.mjs:116`), so removing `sandbox.enabled:
  true` (the sandbox off by default) prints `nothing widened`, and autonomy-render's scope admits it (its value `true`).
  No harness writer removes a scalar today. Narrow fix: the table names scalar removals (`sandbox.enabled` and
  `sandbox.autoAllowBashIfSandboxed` removed: `prompts removed`; `permissions.defaultMode` removed: `nothing widened`)
  and a scope admits no scalar removal. Raised by the S1 code session's self-review.
- **JEV-SKILL-PLACE-HINT-NAMES-A-DIGEST-LINE** — invariant: a hint telling the user to run "the apply" points to a line
  that runs on its own. Origin: `run the apply in <place>` on the harness jev-skill item
  (`agent-workflow-kit/tools/recommendations.mjs:1612`), whose apply line needs the check's digest
  (`agent-workflow-kit/tools/write-lanes.mjs:189`). Narrow fix: "run the check line, then the apply line with its
  digest, in <place>". Residual: a pasted `--expect <digest>` is a parse error in bash, zsh, fish and PowerShell;
  nothing runs. Raised by the S1 diff review (lens round 1).
- **DANGER-CHECK-DIGEST-OMITS-THE-ROOT** — invariant: the consent digest binds where the change lands. Origin:
  checkApply prints root-relative lines (`agent-workflow-kit/tools/apply-danger-check.mjs:278-287`), so two projects with
  identical planned lines share a digest. Narrow fix: a first line `root: <abs>` inside the digest (a spec line-format
  revision). Residual: needs the agent itself to reuse one project's digest on another; the check and apply lines
  carry the same `--cwd`. Raised by the S1 diff review (lens round 1).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tarball-content guard for the kit package. `files[]` whitelists whole directories, so the
// package's OWN colocated *.test.mjs (bin/, tools/, tools/manifest/) and the manifest fixtures
// used to ride into the published npm tarball. Phase-1 SCOPED negation entries in files[] strip
// them — but a blanket `!**/*.test.mjs` would silently drop the deploy/mirror PAYLOAD tests, and
// the deploy/parity gate would NOT catch it (those tests read the on-disk checkout, never the
// tarball). So this guard pins the exact shape of what ships: own tests + fixtures gone, payload
// tests + runtime files retained. This file lives in test/ (outside files[]) so it never ships;
// the local gate + publish CI run it via the `test/*.test.mjs` glob.
//
// CAUTION: never broaden the negation to `!references/**` or `!bridges/**` — references/scripts
// tests are deployed into a consumer repo and bridges/.../agy.test.mjs is part of the
// byte-identical bridge mirror the installed kit links from. Both are payload, asserted below.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const packFull = () => {
  // The npm cache rides under $TMPDIR (cleaned after the run) and every network
  // side-channel (update-notifier / audit / fund) is off: a sandboxed run (read-only ~/.npm, no
  // network) must stay green and must not fire a network prompt — neither is relevant to what
  // this guard asserts (the D4 sandbox-safe command shape).
  const cacheDir = mkdtempSync(join(tmpdir(), 'pack-cache-'));
  let res;
  try {
    res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: cacheDir,
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        NO_UPDATE_NOTIFIER: '1',
      },
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
  assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
  // npm ≤11 prints a JSON array; npm ≥12 prints an object keyed by package name — accept both.
  const parsed = JSON.parse(res.stdout);
  return (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).files;
};
const pack = () => packFull().map((f) => f.path);

describe('kit package content — tarball guard (no own-test/fixture leak; payload retained)', () => {
  // Packed once in a before() hook (not at describe-body level): a failing `npm pack` is then
  // reported as a graceful hook failure rather than throwing during test collection.
  let packed;
  before(() => {
    packed = pack();
  });

  it('ships no own colocated test — every shipped *.test.mjs is deploy/mirror payload', () => {
    const leaks = packed
      .filter((p) => /\.test\.mjs$/.test(p))
      .filter((p) => !/^references\//.test(p) && !/^bridges\//.test(p));
    assert.deepEqual(leaks, [], 'own tests must not ship; only references/ & bridges/ payload tests may');
  });

  it('retains the deploy/mirror payload tests (reverse pins)', () => {
    const required = [
      'references/scripts/archive-caps.test.mjs',
      'references/scripts/archive-changelog.test.mjs',
      'references/scripts/archive-decisions.test.mjs',
      'references/scripts/archive-issues.test.mjs',
      'references/scripts/check-docs-size-ensure.test.mjs',
      'references/scripts/check-docs-size.test.mjs',
      'references/scripts/spec-schema.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy-review.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy-review-await-guard.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-exec.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-review.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-await-guard.test.mjs',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a deploy/mirror payload test was dropped from the tarball');
  });

  it('retains every deployed runtime payload file and entry point', () => {
    const required = [
      'references/scripts/archive-caps.mjs',
      'references/scripts/archive-changelog.mjs',
      'references/scripts/archive-decisions.mjs',
      'references/scripts/archive-issues.mjs',
      'references/scripts/check-docs-size.mjs',
      'references/scripts/_expect-shim.mjs',
      'references/scripts/install-git-hooks.mjs',
      'bin/install.mjs',
      'capability.json',
      'SKILL.md',
      'tools/engine-source.mjs',
      'tools/commands.mjs',
      // the pure member-table leaf (shared by family-registry + the npx installer)
      'tools/family-members.mjs',
      // the dependency-free semver leaf (shared by the installer gate + the bridge freshness probe)
      'tools/semver-lite.mjs',
      // the status-presenter core (Plan: One-init-freshness §4.2) — runtime modules that MUST ship
      'tools/labels.mjs',
      'tools/presentation.mjs',
      'tools/surface.mjs',
      'tools/view-model.mjs',
      'tools/renderers.mjs',
      // the generic gate runner + its project-declaration seed (cost-tiered execution)
      'tools/run-gates.mjs',
      'references/templates/gates.json',
      // the dependency-free LCOV parser (the D3(d) coverage arm's consumption path)
      'tools/lcov.mjs',
      // the promptless literal search lane — reverse-pinned by NAME, not only by the exact count,
      // so dropping it from the payload fails loudly instead of merely shifting a number
      'tools/repo-search.mjs',
      // the promptless inventory lane, pinned by NAME for the same reason: a count alone would let it
      // fall out of the payload unnoticed if some other file leaked in at the same time
      'tools/path-inventory.mjs',
      // the typed channel over those two readers: the stdio MCP server and its JSON-RPC framing leaf —
      // pinned by NAME, because a registration pointing at an absent server fails at every session start
      'tools/mcp-stdio.mjs',
      'tools/mcp-server.mjs',
      // and the mode that makes a project DECLARE it: the guarded writer, its read-only registration
      // leaf (what the advisor and uninstall both ask), and the mode contract. The server shipping
      // without the registration mode is exactly the "opt-in ships invisible" state — a capability
      // present in the tarball that no deployment can ever reach.
      'tools/mcp.mjs',
      'tools/mcp-registration.mjs',
      'references/modes/mcp.md',
      // the finding-scope checker — the pure rule and its CLI half. By NAME: the procedures advisor
      // renders the CLI path into a copy-paste command, so a payload drop hands every deployed
      // project a command that cannot run.
      'tools/fold-scope.mjs',
      'tools/fold-scope-cli.mjs',
      // the structural checker of the spec store (spec layer 2b) — the op grammar, the IO-free judge
      // and the CLI half. By NAME for the same reason as fold-scope: the procedures advisor renders
      // the CLI path into a copy-paste command, and the judge imports the other two at load.
      'tools/spec-check-ops.mjs',
      'tools/spec-check.mjs',
      'tools/spec-check-cli.mjs',
      // the backlog-queue classifier and its CLI half — by NAME for the same reason: a project
      // declares the CLI path as a gate command, so a payload drop hands a deployed project a gate
      // row that cannot run.
      'tools/queue-audit.mjs',
      'tools/queue-audit-rows.mjs',
      'tools/queue-audit-cli.mjs',
      // the coverage requirement — no work without a specification. By NAME because a project
      // declares the CLI path as a gate command, so a payload drop hands a deployed project a gate
      // row that cannot run, and the requirement would silently stop being one.
      'tools/spec-coverage.mjs',
      'tools/spec-coverage-cli.mjs',
      // and the block tokenizer fold-scope.mjs reads its markdown through: a TOOL now imports this
      // deployed payload leaf, so a drop breaks the checker at load, not merely an archiver run.
      'references/scripts/markdown-blocks.mjs',
      // the spec reader the deployed navigator collapse imports: a drop breaks check-docs-size at load
      'references/scripts/spec-schema.mjs',
      // the cheap-lane subagent writer + its bundled vehicles
      'tools/cheap-agents.mjs',
      'references/agents/mechanical-sweep.md',
      'references/agents/changelog-skeleton.md',
      'references/agents/gate-triage.md',
      // the gate-approval PreToolUse hook: writer + the bundled self-contained runtime
      'tools/gate-hook.mjs',
      'references/hooks/gate-approve.mjs',
      // the CONTINUATION-STALL detector: a Stop hook that judges the closing state block, plus its
      // contract doc — the mode ships no writer, so the doc IS the wiring surface
      'references/hooks/state-block-guard.mjs',
      'references/modes/state-block-guard.md',
      // the ONE bundle↔placed comparison walk + the post-failure parity reading the read-only
      // refresh degrade composes its line from. Pinned by NAME: setup-backends imports it, so a
      // leaf dropped from the payload would break every placed-bridge refresh, and the count alone
      // would hide it behind any other simultaneous drift.
      'tools/refresh-parity.mjs',
      // the ONE ensure command upgrade.md invokes (its four ops + the CLI). Pinned by NAME: the mode
      // doc names ONE invocation, so a payload drop would leave that step with nothing to run at all,
      // and the count alone would hide it behind any other simultaneous drift.
      'tools/ensure-configs.mjs',
      'tools/ensure-ops.mjs',
      // and the PURE vocabulary leaf both they and the read-only doc-parity lint import — pinned by
      // NAME because dropping it would break the ops AND the lint at once
      'tools/ensure-vocabulary.mjs',
      // the spec-layer delivery (1b, widened in 2a): the append-only catalog of shipped reader and
      // checker bodies the specs ensure classifies a deployed script through — by NAME, a drop would
      // turn every shipped prior into "custom" and silently stop the refresh
      'tools/script-priors.mjs',
      // and the sixth ensure itself: the op the CLI table composes — by NAME, a drop would break
      // ensure-configs at load and every upgrade with it
      'tools/ensure-specs.mjs',
      // the shared realpath direct-run predicate + the library-only registry. Every guarded module
      // imports it, so a leaf missing from the payload breaks them all — by NAME for the same reason.
      'tools/direct-run.mjs',
      // the ordered upgrade step-3 run-list registry (feedback item 5): upgrade.md renders its
      // checklist from these entries and the structure test binds the two — a payload drop would
      // strand the doc's checklist with no owning registry, and the count alone would hide it.
      'tools/upgrade-runlist.mjs',
      // the three-outcome tool-claim classifier (the ONE shape/admissibility/realpath screen the
      // source-size matcher and the advisor's probes decide through) and the tracked-tree census the
      // coverage-domain verdict reads. Pinned by NAME: the first is imported by a shipped leaf, so
      // dropping it would break the practice at load time, and the count alone would hide either
      // behind any other simultaneous drift.
      'tools/checker-claim.mjs',
      'tools/tracked-tree-census.mjs',
      // the AD-038 review-enforcement pair: the read-only receipt checker + the facts assembler
      'tools/review-state.mjs',
      'tools/grounding.mjs',
      // the NEUTRAL shared core: the changed-surface computation the coverage domain consumes
      'tools/changed-surface.mjs',
      // the shared atomic-write core the consented writers run on (AD-042)
      'tools/atomic-write.mjs',
      // the AD-055 Part I consent-gated ack-store writer (docs/ai/acks.json — the family-owned
      // neutral sandbox-lane fingerprint ack, relocated off the host settings schema)
      'tools/ack-write.mjs',
      // the strip-the-kit core-evidence writer (D3(b)/(c) + D6/D6a/D7): the git-dir evidence store
      // (red-proof / degrade / summary) the hardened self-control core rides on
      'tools/core-evidence.mjs',
      // the closed flow-record vocabulary (flow-orchestration Phase 1) — the flow store/checker's
      // record contract; pinned by NAME so it cannot fall out of the payload behind the count
      'tools/flow-record.mjs',
      // the flow-store IO (flow-orchestration Phase 2) — common-dir resolution, fail-closed reader,
      // lock/CAS serialized append; pinned by NAME for the same reason
      'tools/flow-store.mjs',
      // the parameterized lock/CAS serialized-append leaf (delegation Plan 1 D12) — the discipline
      // both stores ride; falling out of the payload would break every append, so it is pinned by NAME
      'tools/store-append.mjs',
      // the flow-check refusal core (flow-orchestration Phase 3) — pure checker predicates + the
      // standalone --check CLI (deliberately unwired until Plan 3); pinned by NAME for the same reason
      'tools/flow-check.mjs',
      // and the three halves that core became (baseline-practices tranche 1): the facade imports all
      // three, so a leaf falling out of the payload would leave the DECLARED flow-check gate unable
      // to load at all — pinned by NAME, not only by the count, exactly like the source-size leaves
      'tools/flow-check-cores.mjs',
      'tools/flow-check-rungs.mjs',
      'tools/flow-check-git-lane.mjs',
      // and the five leaves the flow-store facade now composes (baseline-practices tranche 2): the
      // facade imports all five, so a leaf falling out of the payload would break EVERY append at
      // load time — pinned by NAME, not only by the count, exactly like the flow-check halves
      'tools/flow-chain-state.mjs',
      'tools/flow-subset-budget.mjs',
      'tools/flow-append.mjs',
      'tools/flow-adoption-mint.mjs',
      'tools/flow-delta-proof.mjs',
      // and the five leaves the flow-record facade now composes (baseline-practices tranche 3): the
      // facade imports all five, so a leaf falling out of the payload would leave EVERY flow consumer
      // — 16 runtime modules — unable to load — pinned by NAME, not only by the count
      'tools/flow-vocabulary.mjs',
      'tools/flow-record-shape.mjs',
      'tools/flow-record-identity.mjs',
      'tools/flow-legality.mjs',
      'tools/flow-finding-manifest.mjs',
      // the closed delegation-record vocabulary (delegation Plan 1 Phase 1) — the record family, the
      // exec-return schema, the sub-task contract header and the metric byte domains the delegation
      // store and engine consume; pinned by NAME for the same reason
      'tools/dispatch-record.mjs',
      // the delegation-ledger IO (delegation Plan 1 Phase 2) — its own store beside the review
      // receipts, the fail-closed reader, and the thread/correlation/retry/wave preflight
      'tools/dispatch-store.mjs',
      // the delegation ENGINE + its mode contract (delegation Plan 1 Phase 3) — the FORM-only
      // contract check, the two hand-written ledger records, and the L0 aggregate report
      'tools/dispatch.mjs',
      'references/modes/dispatch.md',
      // the vehicle-routing advisor (delegation Plan 3 Phase 1) — the frozen row set, the
      // filesystem-only capability resolution and the render behind `dispatch advise` and the
      // form-valid `check` footer. Pinned by NAME: dispatch.mjs AND doc-parity.mjs both import it, so
      // a payload drop would break the engine's load AND the declared doc-parity gate at once, and
      // the count alone would hide it behind any other simultaneous drift.
      'tools/dispatch-advisor.mjs',
      // and the matrix STRUCTURE leaf the read-only lint runs beside its bindings — pinned by NAME
      // because doc-parity.mjs imports it, so a payload drop would leave the DECLARED doc-parity gate
      // unable to load at all, and the count alone would hide it behind any other drift.
      'tools/advisor-matrix.mjs',
      // the D3(c)+(d) final-run checker (fixed git-dir lcov path + red-proof verification) and the
      // D10 read-only pre-commit guard that binds the run-gates --final receipt
      'tools/coverage-check.mjs',
      'tools/commit-guard.mjs',
      // the source-size practice: the pure read core (the ONE import point for the read surfaces)
      // and the CLI + writer half, plus the four leaves the core re-exports and the checker's own
      // judge/report halves. Pinned by NAME, not only by the count: a leaf that fell out of the
      // payload would leave the core importing a file that is not there — the practice would fail to
      // load at all — and the count alone would hide it behind any other simultaneous drift.
      'tools/source-size-core.mjs',
      'tools/source-size-check.mjs',
      'tools/source-size-refusal.mjs',
      'tools/source-size-config.mjs',
      'tools/source-size-scope.mjs',
      'tools/source-size-gate-cmd.mjs',
      'tools/source-size-judge.mjs',
      'tools/source-size-report.mjs',
      // the opt-in one-file-per-ADR store migration writer + its mode + the seeded templates (AD-051)
      'tools/migrate-adr-store.mjs',
      'references/modes/migrate-adr-store.md',
      // the parallel-feature worktrees tool + its mode contract (AD-060)
      'tools/worktrees.mjs',
      'references/modes/worktrees.md',
      // the satellite cold-start trio (delegation Plan 3 Phase 2): the handoff RECORD format as a
      // pure leaf, the slug → satellite locator with git and fs injected, and the prompt composer.
      // Pinned by NAME: worktrees.mjs imports all three and doc-parity.mjs imports the composer, so
      // a payload drop would break the tool's load AND a declared gate at once — and the count alone
      // would hide it behind any other simultaneous drift.
      'tools/worktrees-record.mjs',
      'tools/satellite-locator.mjs',
      'tools/worktree-prompt.mjs',
      // the handoff-return pair (delegation Plan 3 Phase 3): the observation builder (dispatch.mjs
      // AND the rung build the observation record through it) and the return rung itself
      // (dispatch.mjs routes the verb, doc-parity.mjs binds AFTER_FOLD_ORDER). Pinned by NAME: a
      // payload drop breaks the dispatch CLI's load and a declared gate at once, and the exact
      // count alone cannot prove THESE files ship.
      'tools/observation-builder.mjs',
      'tools/worktree-handoff-return.mjs',
      'references/templates/adr-record.md',
      'references/templates/SPEC_TEMPLATE.md',
      'references/templates/specs/index.md',
      'references/templates/adr/log.md',
      // the guarded autonomy provisioner doctor + its mode contract (AD-044 Plan 2)
      'tools/autonomy-doctor.mjs',
      'references/modes/autonomy-doctor.md',
      // the lens-region reconcile — invoked from upgrade/bootstrap prose (a count alone would not
      // catch its accidental exclusion)
      'tools/lens-region.mjs',
      // the progressive-disclosure split payload: the router's mode files + shared contracts must
      // ship, or every placed kit routes into a void (representative pins; the exact count below
      // and the catalog↔modes set-equality guard cover the full set)
      'references/modes/upgrade.md',
      'references/modes/help.md',
      'references/modes/core-evidence.md',
      'references/modes/coverage-check.md',
      'references/modes/commit-guard.md',
      'references/shared/report-footer.md',
      'references/shared/composition-handoff.md',
      'references/shared/deploy-tail.md',
      'references/shared/command-shapes.md',
      // the agy envelope reader: every agy review shells out to it to read the CLI's
      // `--output-format json` answer, and the wrapper refuses pre-spend without it — a placed
      // bridge missing this file could only fail AFTER a paid subscription run
      'bridges/antigravity-cli-bridge/bin/agy-envelope.mjs',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a runtime payload file or entry point was dropped from the tarball');
  });

  // NUL-byte guard (BUGFREE-3): no shipped TEXT source file may contain a NUL byte — a stray \0 (e.g. an
  // editor artifact in a string literal) makes the file read as BINARY, hiding it from rg-based scans,
  // release-scan, and review tooling. Cheap, prevents the class from recurring.
  it('ships no NUL byte in any text source file (.mjs / .json / .md / .sh)', () => {
    const textShipped = packed
      .filter((p) => /\.(mjs|cjs|js|json|md|sh)$/.test(p))
      .map((p) => p.replace(/^package\//, ''));
    const withNul = textShipped.filter((rel) => readFileSync(join(ROOT, rel)).indexOf(0) >= 0);
    assert.deepEqual(withNul, [], 'a shipped text file contains a NUL byte (reads as binary) — remove it');
  });

  it('ships no fixtures anywhere (neither `fixtures/` nor the inline-fixtures `__fixtures__/`)', () => {
    // The manifest validator's `fixtures/` dir is stripped by files[]. The presenter modules use
    // INLINE fixtures (never a tools/__fixtures__/ dir) — defense-in-depth: reject either spelling so a
    // stray fixtures dir can never leak past the gate (`!tools/**/*.test.mjs` would NOT catch a non-test
    // fixtures file).
    const leaks = packed.filter((p) => /(^|\/)fixtures\//.test(p) || /(^|\/)__fixtures__\//.test(p));
    assert.deepEqual(leaks, [], 'no fixtures (fixtures/ or __fixtures__/) may ship in the tarball');
  });

  // Exact-count pin: update this number only when intentionally adding/removing a shipped file;
  // a surprise change means over/under-exclusion (e.g. a new colocated test leaking, or a payload
  // file accidentally dropped). After an intentional change, run `npm pack ./agent-workflow-kit
  // --dry-run --json` and set the new count here in the same commit.
  it('ships exactly the expected number of files', () => {
    // 121 = 96 + the 20 progressive-disclosure split files (17 references/modes/ + 3 references/shared/)
    //     + tools/lens-region.mjs (the agent-rules lens reconcile)
    //     + tools/seed-gates.mjs + tools/atomic-write.mjs (the consent-gated seeder pair, AD-042)
    //     + tools/bridge-settings.mjs + tools/bridge-settings-read.mjs (the host-level bridge-settings
    //       writer + its read-only core, bridges 2.3.0 / D6; modes/bridge-settings.md is the 17th mode).
    // 125 = 121 + the 4 autonomy-policy files (AD-044 Plan 1): tools/autonomy-config.mjs (schema/read
    //       core), tools/autonomy-write.mjs (the one fs-writer), tools/set-autonomy.mjs (the writer CLI),
    //       references/modes/set-autonomy.md (the 18th mode). The *.test.mjs siblings are stripped by files[].
    // 128 = 125 + the 3 review-round LEDGER files (AD-045): tools/review-ledger.mjs (schema + decideStop
    //       + --check, read-only), tools/review-ledger-write.mjs (the sole writer), and
    //       references/modes/review-ledger.md (the 19th mode). The *.test.mjs siblings are stripped by files[].
    // 130 = 128 + the M3 fold-completeness READ/RUN pair (AD-046, Phase 2): tools/fold-completeness.mjs
    //       (result schema + read-only --check) + tools/fold-completeness-run.mjs (the sole tree-toucher +
    //       result writer). The *.test.mjs siblings are stripped by files[].
    // 131 = 130 + references/modes/fold-completeness.md (the 20th mode-ref — the fold-completeness
    //       command surface, AD-046). The shelved mutation half ships NO file (no tools/fold-mutate.mjs).
    // 132 = 131 + tools/changed-surface.mjs (AD-048 — the NEUTRAL shared core: ONE changed-surface
    //       computation for the D4 diff cap + the coverage domain, plus the D8 telemetry fold-read
    //       path). Its *.test.mjs sibling is stripped by files[].
    // 134 = 132 + the BUGFREE-3 verification profile (AD-049): tools/verification-profile.mjs (the
    //       read-core: schema + loadProfile + declared-path safety) + references/templates/
    //       verification-profile.json (the memory-canon template's kit mirror). *.test.mjs stripped.
    // 135 = 134 + tools/lcov.mjs (the dependency-free LCOV parser — the coverage.kind:"lcov" branch).
    // 136 = 135 + tools/sarif.mjs (the dependency-free SARIF reader — the optional advisory findings
    //       surface, never gate-blocking; the --findings verb prints, never records).
    // 138 = 136 + the BUGFREE-3 Segment 2 doc-parity lint (AD-049): tools/doc-parity.mjs (the closed
    //       constant⟷contract-doc parity checker) + references/modes/doc-parity.md (the 21st mode-ref).
    //       Its *.test.mjs sibling — and the new colocated review-state-await / from-receipts /
    //       grounding-ledger-summary tests — are stripped by files[]. The (d)/(e)/(g)/(h) verbs added
    //       no new shipped file (they extend existing tools + the shipped reference-scripts mirror).
    // 139 = 138 + tools/review-ledger-core.mjs (AD-050 — the NEUTRAL ledger read-core: the validated
    //       read path both read-only checkers share, extracted so review-state.mjs reads the ledger
    //       for the degraded exemption without an import cycle). Its *.test.mjs coverage rides in the
    //       existing review-ledger / review-state suites; no new colocated test file ships.
    // 143 = 139 + the one-file-per-ADR store migration (AD-051, Phase 2): tools/migrate-adr-store.mjs
    //       (the opt-in migration writer) + references/modes/migrate-adr-store.md (the 22nd mode-ref) +
    //       references/templates/adr-record.md (the MADR authoring reference) + references/templates/
    //       adr/log.md (the seed navigator, mirrored from memory). The *.test.mjs sibling is stripped by
    //       files[]; the retargeted decisions.md HOT seed is count-neutral (an in-place mirror update).
    // 145 = 143 + the autonomy provisioner doctor (AD-044 Plan 2): tools/autonomy-doctor.mjs (the
    //       guarded consent-per-run OS provisioner — detect → consent-gated install → verify) +
    //       references/modes/autonomy-doctor.md (the 23rd mode-ref). The *.test.mjs sibling is
    //       stripped by files[].
    // 147 = 145 + the Phase-1.5 cosmetic exclude lane (AD-044 Plan 4): tools/sandbox-masks.mjs (the
    //       guarded probe/apply device-mask hider — full-block replace in info/exclude) +
    //       references/modes/sandbox-masks.md (the 24th mode-ref). The *.test.mjs sibling is
    //       stripped by files[].
    // 150 = 147 + the Plan-4 Segment B additions: tools/recommendations.mjs (the read-only upgrade
    //       Recommendations advisor) + references/modes/recommendations.md (the 25th mode-ref) +
    //       references/templates/autonomy.json (the sparse defaults-equivalent policy seed, mirrored
    //       from memory). The *.test.mjs siblings are stripped by files[].
    // 151 = 150 + tools/ack-write.mjs (AD-055 Part I — the consent-gated writer for the family-owned
    //       docs/ai/acks.json neutral ack store; its *.test.mjs sibling is stripped by files[]).
    // 152 = 151 + tools/core-evidence.mjs (strip-the-kit Phase 2 — the ONE core-evidence writer:
    //       the git-dir store for red-proof / degrade records + the D6 stateless summary). Its
    //       *.test.mjs sibling is stripped by files[].
    // 154 = 152 + tools/coverage-check.mjs (the D3(c)+(d) final-run checker) +
    //       tools/commit-guard.mjs (the D10 read-only pre-commit guard binding the --final
    //       receipt). Their *.test.mjs siblings are stripped by files[].
    // 149 = 154 − 11 (strip-the-kit 3.1: the ledger triad review-ledger/-core/-write + the fold
    //       pair fold-completeness/-run + verification-profile.mjs + sarif.mjs + seed-gates.mjs,
    //       their two mode docs, and the verification-profile.json template)
    //       + 3 (the new core mode docs: core-evidence.md / coverage-check.md / commit-guard.md)
    //       + 1 (tools/gates-init.mjs — the D9 consented gates.json fill preview)
    //       + 2 (references/scripts/migrate-gates.mjs + its deploy-payload test — the D8 legacy
    //       gates.json migration, mirrored from the memory canon).
    // 150 = 149 + references/scripts/install-git-hooks.test.mjs (the installer's deploy-payload
    //       spec joins its mirrored script — the C7/C8 worktree-hooks + guard-persistence pins).
    // 152 = 150 + references/scripts/migrate-gates-branches.test.mjs (the refusal/no-op branch
    //       pins) + references/scripts/install-git-hooks-repo-exec.test.mjs (the in-place
    //       GIT_DIR-pinned execution lane — the D3(d) changed-line check reads real executions
    //       of the shipped bytes). Both mirrored from the memory canon.
    // 154 = 152 + the strip Phase-4 round-1 hardening specs, one per bridge bundle:
    //       bridges/*/bin/agy-review-honesty.test.mjs + codex-review-honesty.test.mjs (the
    //       exact-verdict-parse / scoped-refusal / structural-schema-parse / raw-tier-screen
    //       pins — colocated separately because the main wrapper specs are red-proof-frozen).
    // 155 = 154 + bridges/antigravity-cli-bridge/bin/agy-review-model-screen.test.mjs (the
    //       round-2 M6 ordering pin: the control-byte screen precedes every AGY_MODEL
    //       interpolation — the advisory can never echo a raw control byte).
    // 156 = 155 + migrations/3.0.0-hardened-core-loop.md (the AD-059 lineage migration — the
    //       kit-side consumer steps: gates migration, bridge refresh, the guarded installer
    //       refresh + commit-guard arm, re-stamp).
    // 157 = 156 + references/scripts/check-docs-size-cli.test.mjs (Phase-5 coverage fill,
    //       mirrored from the memory canon: the runCli refusal-branch pins — the main spec
    //       file is parity-frozen, so the pins ride a colocated deploy-payload file).
    // 159 = 157 + the parallel-feature worktrees surface (AD-060): tools/worktrees.mjs
    //       (provision | list | land | cleanup) + references/modes/worktrees.md (the 27th
    //       mode-ref). The *.test.mjs sibling is stripped by files[].
    // 160 = 159 + references/shared/command-shapes.md (AD-061 — the shared promptless
    //       command-shapes contract the probe-instructing modes Requires:-declare).
    // 162 = 160 + the CONTINUATION-STALL Stop-hook detector pair: references/hooks/
    //       state-block-guard.mjs (the runtime) + references/modes/state-block-guard.md (the 28th
    //       mode-ref, which carries the paste-ready wiring because the mode ships no writer).
    // 163 = 162 + references/agents/review-lens.md — the read-only REVIEW vehicle. A read-only
    //       fan-out that needs judgment previously had no vehicle at all (the cheap ones are scoped
    //       away from review, and a review-capable full-tool subagent shells out and floods the
    //       maintainer with approval prompts), so the lens ships with NO Bash grant.
    // 164 = 163 + tools/repo-search.mjs — the promptless LITERAL search lane. A pattern carrying a
    //       shell-significant byte cannot ride a seeded-core command without the residual ASK (the
    //       scan reads the raw string and a quote-stripped copy), so the search moves off that
    //       surface: --pattern-file keeps the bytes out of the command string entirely, and the
    //       tool's own prefix is in the hook's scanned list so a byte on the INVOCATION still asks.
    //       Its *.test.mjs sibling is stripped by files[].
    // 165 = 164 + tools/path-inventory.mjs — the promptless INVENTORY lane, the other half of the
    //       same idea. The corpus of useless approvals is mostly small path questions (exists, size,
    //       line count, listing, a small file's contents) batched into a composed shell with `echo`
    //       banners, because no single call answered them; the composition is what raises the prompt.
    //       It shares repo-search's paths-file format and failure classes by IMPORT, so the two file
    //       lanes cannot drift into classifying the same failure differently. Its *.test.mjs sibling
    //       is stripped by files[].
    // 169 = 165 + the fail-closed archiver core mirrored from the memory canon (kit 5.0.0):
    //       references/scripts/markdown-blocks.mjs (the ONE shared block tokenizer) + its
    //       deploy-payload test + references/scripts/archive-conservation.test.mjs (the
    //       conservation/round-trip harness) + references/scripts/archiver-structure.test.mjs
    //       (the no-raw-scan structural pin).
    // 170 = 169 + tools/flow-record.mjs — the closed flow-record vocabulary (flow-orchestration
    //       Phase 1: kinds/purposes, per-kind arms, transition table, per-record canonical digest).
    //       Its *.test.mjs sibling is stripped by files[].
    // 171 = 170 + tools/flow-store.mjs — the flow-store IO (flow-orchestration Phase 2: common-dir
    //       path resolution, fail-closed reader, lock/CAS serialized append with semantic
    //       preflight). Its *.test.mjs siblings are stripped by files[].
    // 172 = 171 + tools/flow-check.mjs — the flow-check refusal core (flow-orchestration Phase 3:
    //       pure checker predicates over both stores + the standalone --check CLI, deliberately
    //       UNDECLARED in gates.json until Plan 3 wires composition). Its *.test.mjs sibling is
    //       stripped by files[].
    // 176 = 172 + the flow arming + writer surfaces (flow-orchestration Plan 3 Phase 3), EXACTLY
    //       four files: tools/set-flow.mjs (the preview-first arming writer — deep floors live
    //       there) + tools/flow-writer.mjs (the explicit record writer — the store preflight is
    //       the single legality door) + their two mode docs references/modes/set-flow.md +
    //       references/modes/flow-writer.md. The *.test.mjs siblings are stripped by files[].
    // 177 = 176 + tools/flow-store-read.mjs — the read half of the flow store (owns no write
    //       API), extracted by a Phase-3 review disposition: the read-only procedures advisor
    //       never DIRECTLY imports the append-capable store module (the orchestration-write
    //       import-split rule, extended); flow-store.mjs re-exports it. Full transitive graph
    //       purity is queued (FLOW-READ-GRAPH-PURITY), not claimed.
    // 179 = 177 + the Phase-4 deadline runner, EXACTLY two files: tools/receipt-deadline.mjs
    //       (the receipt-ARRIVAL waiter — watermark + in-process prefix binding + the preferred
    //       nonce-manifest correlation) + its mode doc references/modes/receipt-deadline.md.
    //       The *.test.mjs sibling is stripped by files[]. (The Phase-4 wrapper manifest lane
    //       and the consult-attestation arm live in already-counted files.)
    // 183 = 179 + the FLOW-READ-GRAPH-PURITY leaves (flow Plan 4 Phase 2), EXACTLY four files:
    //       tools/fs-read-nofollow.mjs (the race-free no-follow read primitive — the receipts
    //       reader rides it) + tools/repo-lex.mjs (lexicalRepoRelative + shellQuoteArg) +
    //       tools/plan-files.mjs (the in-flight-plan convention) + tools/gates-declaration.mjs
    //       (declaration load/validation + the canonical checker predicate + the pregate subset
    //       derivation the locked subset-attempt factory re-derives — the R10 rider). The
    //       read-graph purity test itself lives in the repo's test/, never in the tarball.
    // 184 = 183 + the delegation record vocabulary (delegation Plan 1 Phase 1), EXACTLY one file:
    //       tools/dispatch-record.mjs (pure form — closed record family, D4 outcome enum + successor
    //       table, exec-return schema, D8 contract header, D6 byte domains). Its colocated
    //       *.test.mjs sibling is stripped by files[] and never enters the tarball.
    // 185 = 184 + the shared coverage-producer vocabulary (kit-inert-gate Phase 1.1), EXACTLY one
    //       file: tools/coverage-producer.mjs (the reporter-flag constant + the CLOSED
    //       matchesCoverageProducer predicate, held byte-equal to the memory canon by a TEXT drift
    //       guard rather than an import). Its *.test.mjs sibling is stripped by files[].
    // 186 = 185 + the coverage vocabulary leaf (kit-inert-gate Phase 2), EXACTLY one file:
    //       tools/coverage-state.mjs (the CLOSED coverage= value set + the subset a final receipt
    //       may record). It is a LEAF because its two consumers cannot import each other —
    //       run-gates REPORTS the token and core-evidence VALIDATES it, and run-gates already
    //       imports core-evidence. Its *.test.mjs sibling is stripped by files[].
    // 187 = 186 + the declared-path leaf (kit-inert-gate Phase 3.3), EXACTLY one file:
    //       tools/declared-paths.mjs (resolution + segment containment for a declared
    //       sandbox.filesystem.allowWrite entry). It is a LEAF because its two consumers read the
    //       same rule from opposite ends — the advisor asks whether an entry COVERS a probe dir,
    //       the autonomy render whether one resolves OUTSIDE the repo — and the advisor already
    //       imports the render, so neither could own it. Its coverage rides both consumers' suites.
    // 188 = 187 + the shared append leaf (delegation Plan 1 Phase 2, D12), EXACTLY one file:
    //       tools/store-append.mjs (the parameterized lock/CAS serialized append — nouns, seams,
    //       validator, parser and the semantic preflight injected). It is a LEAF because two stores
    //       now ride the identical discipline and neither may import the other's module. Its
    //       coverage rides both callers' suites; there is no colocated *.test.mjs.
    // 189 = 188 + the delegation store (delegation Plan 1 Phase 2), EXACTLY one file:
    //       tools/dispatch-store.mjs (path resolution + fail-closed reader + the semantic preflight
    //       the shared leaf runs under the lock, and the D5 uncommitted-state fingerprint helper).
    //       Its colocated *.test.mjs sibling is stripped by files[] and never enters the tarball.
    // 191 = 189 + the delegation engine (delegation Plan 1 Phase 3), EXACTLY two files:
    //       tools/dispatch.mjs (check | register | observe | aggregate — the FORM-only contract
    //       check, the pre-registration and observation records, and the D7 acceptance report) +
    //       references/modes/dispatch.md (its mode contract, doc-parity-bound on the ONE sentence
    //       carrying the form-only limit and the aggregator's refusals). The colocated
    //       *.test.mjs sibling is stripped by files[] and never enters the tarball.
    // 193 = 191 + the exec-return producers (delegation Plan 2 Phase 1), EXACTLY two files:
    //       tools/exec-receipt.mjs (the wrapper-minted receipt's closed form — the two states, the
    //       terminal-only rule, the D3 outcome mapping and the artifact naming grammar) +
    //       tools/exec-producer.mjs (the git-side metric producer: the returned change set
    //       enumerated over the fingerprint domain, the diff bytes and the bundle assembly). Both
    //       colocated *.test.mjs siblings are stripped by files[] and never enter the tarball.
    // 195 = 193 + the source-size practice (baseline-practices Plan 1 Phase 1), EXACTLY two files:
    //       tools/source-size-core.mjs (the PURE READ core — config states, the declared-scope and
    //       counting rules, the canonical gate-cmd matcher; imported by the read surfaces) +
    //       tools/source-size-check.mjs (the CLI + writer half, imported by NOTHING in the read
    //       graph). The split is what keeps the read-graph purity suite true. The colocated
    //       *.test.mjs sibling is stripped by files[] and never enters the tarball.
    // 201 = 195 + the source-size decomposition (baseline-practices Plan 1 Phase 2), EXACTLY six
    //       files. The read core became the ONE import point over four leaves — tools/
    //       source-size-refusal.mjs (the two exit classes + the absolute path every refusal names) +
    //       source-size-config.mjs (the config grammar, its four states, its reader) +
    //       source-size-scope.mjs (which files are judged, and how big each one is) +
    //       source-size-gate-cmd.mjs (the canonical gate-cmd matcher) — and the checker gained its
    //       own read halves: source-size-judge.mjs (the verdict as facts, shared with the writer so
    //       the two can never disagree about the tree) + source-size-report.mjs (the wording,
    //       including the tighten/growth render contracts). The colocated *.test.mjs siblings are
    //       stripped by files[] and never enter the tarball.
    // 204 = 201 + the flow-check decomposition (baseline-practices Plan 1 Phase 5, campaign tranche
    //       1), EXACTLY three files: tools/flow-check-cores.mjs (the decision cores over both
    //       stores' read-results + decideFlowCheck) + tools/flow-check-rungs.mjs (the evidence rungs
    //       #61/#56/#65/#25/#42/#15 and the refusal vocabulary both pure halves share) +
    //       tools/flow-check-git-lane.mjs (the all-path git lane for base-motion inputs, a leaf).
    //       tools/flow-check.mjs stays the CLI + computeFlowDecision + the public surface, so no
    //       consumer's import path moved. Its *.test.mjs sibling is stripped by files[] and stays
    //       byte-identical — the split is characterized by the suite it already had.
    // 205 = 204 + tools/refresh-parity.mjs (feedback-hardening Plan 1 F3): the bundle↔placed
    //       comparison walk moved out of setup-backends.mjs, joined by the POST-FAILURE parity
    //       verdict and the read-only skip line it composes. A LEAF — fs injected, nothing imported
    //       back from the writer — which is what lets the read-only degrade prove its own claim
    //       without the scanner being written twice. Its *.test.mjs sibling is stripped by files[].
    // 208 = 205 + the feedback-hardening Plan 1 F4 trio: tools/ensure-configs.mjs (the ONE upgrade
    //       ensure command) + tools/ensure-ops.mjs (its four operations) + tools/direct-run.mjs (the
    //       realpath direct-run predicate extracted from the source-size writer, plus the explicit
    //       library-only registry a mode-doc-named module without a CLI now has to join). The three
    //       *.test.mjs siblings are stripped by files[].
    // 209 = 208 + tools/ensure-vocabulary.mjs — the closed token/cause vocabulary as a PURE leaf, so
    //       the read-only doc-parity lint can bind the relayed token set into upgrade.md without
    //       importing the ensure implementation and, through it, the orchestration writer (a round-1
    //       council finding).
    // 211 = 209 + the feedback-hardening Plan 2 P1 pair of PURE leaves: tools/checker-claim.mjs (the
    //       three-outcome tool-claim classifier — the shape + admissibility + realpath screens the
    //       source-size matcher now decides through, twinned byte-identically into the standalone
    //       migration) + tools/tracked-tree-census.mjs (the strict-dominance census over `git
    //       ls-files -z`, classified by the existing closed changed-path vocabulary). Their
    //       *.test.mjs siblings live in test/ and never enter the tarball.
    // 212 = 211 + tools/upgrade-runlist.mjs (feedback-hardening Plan 3 item 5): the ordered upgrade
    //       step-3 run-list registry — a PURE zero-import leaf (the ensure-vocabulary pattern) the
    //       upgrade.md step-3 checklist renders from. Its structure test lives in test/ and never
    //       enters the tarball.
    // 213 = 212 + references/scripts/check-docs-size-ensure.test.mjs (the navigator write contract +
    //       the --ensure-index finalizer mode — mirrored from the memory package via sync-mirrors,
    //       so it ships as deploy payload here too).
    // 215 = 213 + the agy envelope reader PAIR under bridges/antigravity-cli-bridge/bin/ (AGY-1.1.13):
    //       agy-envelope.mjs, which every agy review now shells out to in order to read the CLI's
    //       `--output-format json` answer, and its colocated agy-envelope.test.mjs. A bridge dir
    //       ships WHOLE (it is placed as a skill), so the colocated test is payload here — unlike a
    //       tools/ sibling, which files[] strips. The module is ALSO pinned by NAME above: an exact
    //       count alone cannot prove THIS file ships, because another added file masks its loss.
    // 216 = 215 + tools/dispatch-advisor.mjs (delegation Plan 3 Phase 1): the vehicle-routing
    //       advisor — the frozen row set, the filesystem-only capability resolution, and the render
    //       both `dispatch advise` and the form-valid `check` footer print. Its colocated
    //       *.test.mjs siblings are stripped by files[]. The module is ALSO pinned by NAME above.
    // 217 = 216 + tools/advisor-matrix.mjs: the round-1 fold widened the matrix structure check to
    //       every CELL, an anchored surface and a column-arity refusal, which pushed doc-parity.mjs
    //       past the 400-line default — so the parser and its refusal vocabulary moved out to a leaf
    //       instead of being recorded as fresh size debt. Pinned by NAME above for the same reason
    //       the other lint leaves are: doc-parity imports it, so a payload drop breaks a declared
    //       gate at load time.
    // 220 = 217 + the satellite cold-start trio (delegation Plan 3 Phase 2): tools/
    //       worktrees-record.mjs (the handoff record format as a PURE leaf — the typed STOP, the
    //       exit codes, compose + parse) + tools/satellite-locator.mjs (slug → satellite worktree
    //       and the handoff identity proof, git and fs injected) + tools/worktree-prompt.mjs (the
    //       cold-start prompt composer and its two bars). The first two are extractions the
    //       dispatch side reads too, which is what keeps the 3200-line worktrees tool out of the
    //       dispatch CLI's import closure. All three are pinned by NAME above; their colocated
    //       *.test.mjs siblings are stripped by files[].
    // 222 = 220 + the handoff-return pair (delegation Plan 3 Phase 3): tools/
    //       observation-builder.mjs (the scope measurement + the ONE observation-record
    //       construction, extracted from dispatch.mjs so the rung cannot import the CLI back —
    //       the tools graph is pinned acyclic) + tools/worktree-handoff-return.mjs (the
    //       worktree-stream return rung: byte-verbatim delivery, the prepared-tree/prepared-head
    //       re-attestation, the observation-domain classification). Both are pinned by NAME above;
    //       their colocated *.test.mjs siblings (the integration E2E included) are stripped by
    //       files[] and never enter the tarball.
    // 227 = 222 + the five leaves the flow-store facade now composes (baseline-practices tranche 2):
    //       tools/flow-chain-state.mjs + tools/flow-subset-budget.mjs (the two PURE leaves — the
    //       chain-state walk with the generic reference validator, and the Decision-7/8 counting
    //       budget) + tools/flow-append.mjs (the ONE write door: the lane over store-append.mjs, the
    //       semantic preflight, the run-lock lanes and the locked subset-attempt factory) +
    //       tools/flow-adoption-mint.mjs + tools/flow-delta-proof.mjs (the two mints). flow-store.mjs
    //       keeps its path as a re-export facade, so no consumer import site moved. All five are
    //       pinned by NAME above; the new test/flow-store-layout.test.mjs suite is outside files[]
    //       and never enters the tarball.
    // 232 = 227 + the five leaves the flow-record facade now composes (baseline-practices tranche 3):
    //       tools/flow-vocabulary.mjs (the closed kind/purpose sets, the transition table and the
    //       shared form bindings) + tools/flow-record-shape.mjs (the per-kind field shapes and
    //       validateFlowRecord) + tools/flow-record-identity.mjs (keys, tree identity, the canonical
    //       digest and the projection) + tools/flow-legality.mjs (the two raw-order legality walks) +
    //       tools/flow-finding-manifest.mjs (the wrapper manifest and its fatal-UTF-8 decoder).
    //       flow-record.mjs keeps its path as a re-export facade, so none of the 30 import sites
    //       moved. All five are pinned by NAME above; the new test/flow-record-layout.test.mjs suite
    //       is outside files[] and never enters the tarball.
    // 233 = 232 + bridges/antigravity-cli-bridge/bin/agy-review-await-guard.test.mjs (the suite-speed
    //       work): the agy-review dispatches are awaited so the suite stops pinning one core, and a
    //       missing await is NOT self-announcing at the one site whose result is discarded. A bridge
    //       dir ships WHOLE, so this colocated guard is payload here — unlike a tools/ sibling.
    // 234 = 233 + bridges/codex-cli-bridge/bin/codex-await-guard.test.mjs — the twin guard for the
    //       codex bundle (its two suites carry five discarded-result dispatches between them). One
    //       guard per BUNDLE, not one per family: a bridge dir is placed on its own, so neither
    //       guard can read the other bundle's suites.
    // 236 = 234 + the typed channel (typed-channel-mcp Plan 1): tools/mcp-stdio.mjs (the JSON-RPC 2.0
    //       line-framing leaf over injected streams) + tools/mcp-server.mjs (the stdio MCP server
    //       exposing path_inventory and repo_search as typed tools over the readers' exported main).
    //       The three *.test.mjs siblings are stripped by files[]; both are pinned by NAME above.
    // 239 = 236 + the typed channel's REGISTRATION half (mcp-registration Plan 2): tools/mcp.mjs
    //       (the guarded writer) + tools/mcp-registration.mjs (its read-only leaf, which the advisor
    //       and uninstall ask) + references/modes/mcp.md (the mode contract, which every mode doc
    //       ships). The two *.test.mjs siblings are stripped by files[]; all three are pinned by
    //       NAME above.
    // 241 = 239 + the finding-scope checker (the fold channel): tools/fold-scope.mjs (the pure rule)
    //       + tools/fold-scope-cli.mjs (argv + fs). Their *.test.mjs siblings are stripped by files[].
    // 243 = 241 + the spec layer's reader pair (spec layer 1a): references/scripts/spec-schema.mjs
    //       (the ONE import-free reader that defines a well-formed spec; the navigator collapse reads
    //       through it) + its deploy-payload test — both mirrored from the memory canon by sync-mirrors.
    // 245 = 243 + references/templates/SPEC_TEMPLATE.md (the spec authoring reference, skill-home only
    //       like adr-record.md) + references/templates/specs/index.md (the seed spec store root the
    //       bootstrap deploys) — both mirrored from the memory canon by sync-mirrors.
    // 246 = 245 + tools/script-priors.mjs (spec layer 1b; 2a widened it to the reader pair): the
    //       append-only digest catalog of every shipped refreshable-script body + the
    //       current|prior|custom classifier. Its test and the .txt fixtures under test/ are outside
    //       files[] and never enter the tarball.
    // 247 = 246 + tools/ensure-specs.mjs (spec layer 1b, rows b04-b09): the sixth upgrade ensure —
    //       pair seed + prior-matching refresh for BOTH pairs (reader since 2a), store root behind a
    //       current checker. Its table test and the E2E are outside files[].
    // 250 = 247 + the structural checker (spec layer 2b): tools/spec-check-ops.mjs (the frozen change-op
    //       grammar) + tools/spec-check.mjs (the IO-free judge) + tools/spec-check-cli.mjs (argv + fs).
    //       Their *.test.mjs siblings and the fixture stores under test/ are outside files[].
    // 252 = 250 + references/scripts/archive-caps.mjs (the frozen tier table every rolling archive
    //       stamps from) + its deploy-payload test — both mirrored from the memory canon by
    //       sync-mirrors.
    // 255 = 252 + the backlog-queue checker's three modules: tools/queue-audit-rows.mjs (the status
    //       grammar of one row), tools/queue-audit.mjs (the document pass and the caps) and
    //       tools/queue-audit-cli.mjs (argv + fs). Split at the 400-line cap, twice.
    // 257 = 255 + the coverage requirement: tools/spec-coverage.mjs (the rule) and
    //       tools/spec-coverage-cli.mjs (argv, fs and the one write, the shrink-only debt).
    //       Both also ride the NAMED list above: a count alone would let either fall out of the
    //       payload unnoticed the moment some other file leaked in at the same time.
    // 259 = 257 + the agy-review suite split: bridges/antigravity-cli-bridge/bin/
    //       agy-review-harness.test.mjs (the shared fake CLI + sandbox) and agy-review-verdict.test.mjs
    //       (the verdict-body honesty topic). A bridge subtree ships its tests — files[] excludes
    //       only tools/ and bin/ tests of the kit itself.
    assert.equal(packed.length, 259, `tarball file count drifted (${packed.length} ≠ 259)`);
  });

  // The byte-equality mirror guard does NOT cover the exec bit, and a non-+x agy-review.sh would break
  // the `setup` symlink target. npm normalizes a packed file's mode to 0755 (executable) or 0644, so
  // pinning the packed mode pins the shipped exec bit.
  it('ships agy-review.sh executable (packed mode 0755)', () => {
    const full = packFull();
    const sh = full.find((f) => f.path === 'bridges/antigravity-cli-bridge/bin/agy-review.sh');
    assert.ok(sh, 'agy-review.sh must be packed');
    assert.equal(sh.mode, 0o755, `agy-review.sh must ship executable, got mode ${sh.mode?.toString(8)}`);
  });
});

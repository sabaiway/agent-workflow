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
  // The npm cache rides under $TMPDIR (cleaned after the run — agy R1) and every network
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
      'references/scripts/archive-changelog.test.mjs',
      'references/scripts/archive-decisions.test.mjs',
      'references/scripts/archive-issues.test.mjs',
      'references/scripts/check-docs-size.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy.test.mjs',
      'bridges/antigravity-cli-bridge/bin/agy-review.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-exec.test.mjs',
      'bridges/codex-cli-bridge/bin/codex-review.test.mjs',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a deploy/mirror payload test was dropped from the tarball');
  });

  it('retains every deployed runtime payload file and entry point', () => {
    const required = [
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
      // the BUGFREE-3 verification-profile read-core + its seeded template (the language-independence
      // contract, AD-049) — the memory-canon template's kit mirror (byte-parity: template-parity.test.mjs)
      'tools/verification-profile.mjs',
      'references/templates/verification-profile.json',
      // the dependency-free LCOV parser (the coverage.kind:"lcov" branch — M3a goes any-language)
      'tools/lcov.mjs',
      // the dependency-free SARIF reader (the OPTIONAL advisory findings surface — never gate-blocking)
      'tools/sarif.mjs',
      // the cheap-lane subagent writer + its bundled vehicles
      'tools/cheap-agents.mjs',
      'references/agents/mechanical-sweep.md',
      'references/agents/changelog-skeleton.md',
      'references/agents/gate-triage.md',
      // the gate-approval PreToolUse hook: writer + the bundled self-contained runtime
      'tools/gate-hook.mjs',
      'references/hooks/gate-approve.mjs',
      // the AD-038 review-enforcement pair: the read-only receipt checker + the facts assembler
      'tools/review-state.mjs',
      'tools/grounding.mjs',
      // the AD-045 review-round LEDGER: the read-only checker (schema + decideStop + --check) + the sole writer
      'tools/review-ledger.mjs',
      'tools/review-ledger-write.mjs',
      // the AD-050 NEUTRAL ledger read-core: the validated read path (path/base + schema + reader +
      // filters) both read-only checkers share without a cycle (review-state reads it for the degraded exemption)
      'tools/review-ledger-core.mjs',
      // the AD-046 fold-completeness READ/RUN pair: the read-only --check gate + the sole tree-toucher/runner
      'tools/fold-completeness.mjs',
      'tools/fold-completeness-run.mjs',
      // the AD-048 NEUTRAL shared core: the changed-surface computation (the D4 diff cap + the
      // coverage domain consume ONE computation) + the D8 telemetry fold-read path
      'tools/changed-surface.mjs',
      // the consent-gated gates.json seeder + the shared atomic-write core it runs on (AD-042)
      'tools/seed-gates.mjs',
      'tools/atomic-write.mjs',
      // the AD-055 Part I consent-gated ack-store writer (docs/ai/acks.json — the family-owned
      // neutral sandbox-lane fingerprint ack, relocated off the host settings schema)
      'tools/ack-write.mjs',
      // the strip-the-kit core-evidence writer (D3(b)/(c) + D6/D6a/D7): the git-dir evidence store
      // (red-proof / degrade / summary) the hardened self-control core rides on
      'tools/core-evidence.mjs',
      // the D3(c)+(d) final-run checker (fixed git-dir lcov path + red-proof verification) and the
      // D10 read-only pre-commit guard that binds the run-gates --final receipt
      'tools/coverage-check.mjs',
      'tools/commit-guard.mjs',
      // the opt-in one-file-per-ADR store migration writer + its mode + the seeded templates (AD-051)
      'tools/migrate-adr-store.mjs',
      'references/modes/migrate-adr-store.md',
      'references/templates/adr-record.md',
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
      'references/modes/review-ledger.md',
      'references/modes/fold-completeness.md',
      'references/shared/report-footer.md',
      'references/shared/composition-handoff.md',
      'references/shared/deploy-tail.md',
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
    assert.equal(packed.length, 154, `tarball file count drifted (${packed.length} ≠ 154)`);
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

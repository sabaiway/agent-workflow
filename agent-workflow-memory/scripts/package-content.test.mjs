import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// The memory substrate must "know nobody": it ships ONLY its own capability.json and NO
// family-wide tooling (schema/validator/injection/scanner — those are owned by the composition
// root). This guards the DAG at the package-content level.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_FILES = new Set([
  'validate.mjs',
  'schema.md',
  'inject-methodology.mjs',
  'methodology-slot.md',
  'release-scan.mjs',
]);
const FORBIDDEN_DIRS = new Set(['tools', 'manifest']);

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      acc.push({ kind: 'dir', name: entry, full });
      walk(full, acc);
    } else {
      acc.push({ kind: 'file', name: entry, full });
    }
  }
  return acc;
};

describe('memory package content — DAG guard (knows nobody)', () => {
  const entries = walk(ROOT);

  it('ships no family-wide tooling files', () => {
    const leaks = entries.filter((e) => e.kind === 'file' && FORBIDDEN_FILES.has(e.name));
    assert.deepEqual(leaks.map((e) => e.full), [], 'family tooling must not ship in the memory package');
  });

  it('has no tools/ or manifest/ directory', () => {
    const leaks = entries.filter((e) => e.kind === 'dir' && FORBIDDEN_DIRS.has(e.name));
    assert.deepEqual(leaks.map((e) => e.full), []);
  });

  it('package.json files[] does not enumerate any family tooling', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const offending = (pkg.files ?? []).filter((f) => /tools|manifest|validate|schema\.md|inject-methodology|release-scan/.test(f));
    assert.deepEqual(offending, []);
  });

  it('does ship its own capability.json (the only manifest it owns)', () => {
    assert.ok(entries.some((e) => e.kind === 'file' && e.name === 'capability.json' && basename(dirname(e.full)) === basename(ROOT)));
  });

  it('no source file names a specific sibling skill (knows nobody — generic "composition root" only)', () => {
    // Built from fragments so the literal sibling names never appear in THIS test's own source
    // (otherwise the walk below would flag this file).
    const d = '-';
    const SIBLINGS = [
      ['agent', 'workflow', 'kit'].join(d),
      ['codex', 'cli', 'bridge'].join(d),
      ['antigravity', 'cli', 'bridge'].join(d),
      ['agent', 'workflow', 'engine'].join(d),
    ];
    const offenders = [];
    for (const e of entries) {
      if (e.kind !== 'file' || !/\.(md|mjs|json|sh|ya?ml)$/.test(e.name)) continue;
      const text = readFileSync(e.full, 'utf8');
      for (const sibling of SIBLINGS) {
        if (text.includes(sibling)) offenders.push(`${e.full} → "${sibling}"`);
      }
    }
    assert.deepEqual(offenders, [], 'memory must reference only the generic composition root, never a named sibling');
  });
});

// Tarball-content guard. `files[]` whitelists whole directories, so the package's OWN colocated
// *.test.mjs (bin/, scripts/) used to ride into the published npm tarball. Phase-1 SCOPED negation
// entries strip them — but `!scripts/*.test.mjs` deliberately does NOT cross `/`, so it never
// touches references/scripts/*.test.mjs, which are deploy PAYLOAD (copied into a consumer repo's
// scripts/). A blanket `!references/**` would silently drop them and the deploy gate would NOT
// catch it (it reads the checkout, never the tarball). This guard pins the exact shape: own tests
// gone, payload tests + runtime files retained. This file is itself stripped from the tarball by
// Phase 1, but runs from the checkout via the gate + publish-CI `scripts/*.test.mjs` glob.
//
// CAUTION: never broaden the negation to `!references/**` — those tests are deploy payload.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const packMemory = () => {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG_ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
  // npm ≤11 prints a JSON array; npm ≥12 prints an object keyed by package name — accept both.
  const parsed = JSON.parse(res.stdout);
  return (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]).files.map((f) => f.path);
};

describe('memory package content — tarball guard (no own-test leak; deploy payload retained)', () => {
  // Packed once in a before() hook (not at describe-body level): a failing `npm pack` is then
  // reported as a graceful hook failure rather than throwing during test collection.
  let packed;
  before(() => {
    packed = packMemory();
  });

  it('ships no own colocated test — every shipped *.test.mjs is deploy payload', () => {
    const leaks = packed
      .filter((p) => /\.test\.mjs$/.test(p))
      .filter((p) => !/^references\//.test(p));
    assert.deepEqual(leaks, [], 'own tests must not ship; only references/ deploy-payload tests may');
  });

  it('retains the deploy payload tests (reverse pins)', () => {
    const required = [
      'references/scripts/archive-changelog.test.mjs',
      'references/scripts/archive-decisions.test.mjs',
      'references/scripts/archive-issues.test.mjs',
      'references/scripts/check-docs-size.test.mjs',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a deploy payload test was dropped from the tarball');
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
      'scripts/stamp-takeover.mjs',
      'references/templates/gates.json',
      'references/templates/verification-profile.json',
      'references/templates/adr-record.md',
      'references/templates/adr/log.md',
    ];
    const missing = required.filter((p) => !packed.includes(p));
    assert.deepEqual(missing, [], 'a runtime payload file or entry point was dropped from the tarball');
  });

  it('ships no fixtures anywhere', () => {
    const leaks = packed.filter((p) => /(^|\/)fixtures\//.test(p));
    assert.deepEqual(leaks, [], 'no fixtures may ship in the tarball');
  });

  // Exact-count pin: update this number only when intentionally adding/removing a shipped file;
  // a surprise change means over/under-exclusion. After an intentional change, run `npm pack
  // ./agent-workflow-memory --dry-run --json` and set the new count here in the same commit.
  it('ships exactly the expected number of files', () => {
    // 43 = 41 + references/templates/adr-record.md (the MADR authoring reference) +
    //      references/templates/adr/log.md (the seed ADR navigator == the generator over the seeded
    //      HOT decisions.md). The one-file-per-ADR store retargets decisions.md IN PLACE (count-neutral);
    //      only these two new seeds add to the total. Kit mirrors are pinned by the kit's own
    //      package-content test + template-parity.test.mjs.
    assert.equal(packed.length, 43, `tarball file count drifted (${packed.length} ≠ 43)`);
  });
});

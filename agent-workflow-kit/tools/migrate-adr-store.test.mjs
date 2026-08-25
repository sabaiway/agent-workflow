import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { main, parseArgs, planScriptRefresh, MIGRATE_ADR_STORE_STOP } from './migrate-adr-store.mjs';
import { surveyProject } from './family-registry.mjs';
import { runCli as runArchiveDecisions } from '../references/scripts/archive-decisions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_SCRIPTS = resolve(HERE, '..', 'references', 'scripts');
const STAMP = '2026-01-01T00-00-00-000Z';

const tier = (title, cap, ...adrs) =>
  `---\ntype: reference\nlastUpdated: 2026-01-01\nscope: permanent\nstaleAfter: never\nowner: none\nmaxLines: ${cap}\n---\n\n# ${title}\n\n` +
  adrs.map(({ id, t }) => `## AD-${id} — ${t}\n\n**Date:** 2026-01-0${Number(id)}\n**Status:** Accepted\n\nBody ${id}.`).join('\n\n') +
  '\n';

let cwd;
const dirs = [];
const mkOldLayout = ({ git = false, deployedScripts = ['archive-decisions.mjs', 'check-docs-size.mjs'] } = {}) => {
  cwd = mkdtempSync(join(tmpdir(), 'migrate-adr-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, 'docs', 'ai', 'history'), { recursive: true });
  writeFileSync(
    join(cwd, 'docs', 'ai', 'decisions.md'),
    // HOT preamble names the retired monolith (so the rewrite has something to repoint).
    tier('Architecture Decision Records (ADRs)', 500, { id: '003', t: 'Third' }, { id: '004', t: 'Fourth' }).replace(
      '# Architecture Decision Records (ADRs)\n',
      '# Architecture Decision Records (ADRs)\n\n> Older ADRs rolled to `decisions-archive.md`.\n',
    ),
  );
  writeFileSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive.md'), tier('ADR Archive', 500, { id: '002', t: 'Second' }));
  writeFileSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive-early.md'), tier('ADR Archive (early)', 1000, { id: '001', t: 'First' }));
  const scripts = join(cwd, 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of deployedScripts) writeFileSync(join(scripts, name), '// an OLD deployed enforcement script (pre-migration)\n');
  if (git) execFileSync('git', ['init', '-q'], { cwd });
  return cwd;
};
const quiet = () => {
  const log = [];
  const error = [];
  return { log: (m) => log.push(m), error: (m) => error.push(m), out: () => log.join('\n'), err: () => error.join('\n') };
};
const run = (argv, io, extra = {}) => main(['--cwd', cwd, ...argv], { log: io.log, error: io.error, stamp: STAMP, ...extra });

beforeEach(() => { cwd = null; });
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

describe('migrate-adr-store — arg parsing + gates', () => {
  it('--dry-run and --apply are mutually exclusive (both orders → usage exit 2)', () => {
    for (const argv of [['--dry-run', '--apply'], ['--apply', '--dry-run']]) {
      const io = quiet();
      assert.equal(main(argv, { log: io.log, error: io.error }), 2);
      assert.match(io.err(), /mutually exclusive/);
    }
  });

  it('an unknown flag is a usage error (exit 2)', () => {
    const io = quiet();
    assert.equal(main(['--frobnicate'], { cwd: tmpdir(), log: io.log, error: io.error }), 2);
    assert.match(io.err(), /unknown argument/);
  });

  it('refuses a project with no docs/ai deployment (exit 1)', () => {
    const io = quiet();
    const empty = mkdtempSync(join(tmpdir(), 'migrate-adr-empty-'));
    dirs.push(empty);
    assert.equal(main(['--cwd', empty], { log: io.log, error: io.error, stamp: STAMP }), 1);
    assert.match(io.err(), /docs\/ai is absent/);
  });
});

describe('migrate-adr-store — no-op detection', () => {
  it('a fresh new-scheme tree (no monoliths, no adr/) is a stated no-op (exit 0)', () => {
    cwd = mkdtempSync(join(tmpdir(), 'migrate-adr-fresh-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /nothing to migrate/);
  });

  // RE-CUT: a store DIRECTORY on disk does not prove the crossing finished. A crash between the
  // mkdir and the navigator write leaves exactly this shape, and the old no-op turned the retry into
  // a dead end — the tree stayed un-finalised forever while the detector read it as migrated.
  // Finalisation is now the tree's OWN gate: the navigator exists and --check passes.
  it('a store dir with NO navigator is NOT "already migrated" — --apply finalises it', () => {
    cwd = mkdtempSync(join(tmpdir(), 'migrate-adr-half-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'docs', 'ai', 'adr'), { recursive: true });
    const io = quiet();
    assert.equal(run(['--apply'], io), 0);
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'adr', 'log.md')), 'the navigator is written');
    assert.match(io.out(), /seeded/);
  });

  it('a FINALISED tree (store + navigator + green gate) is a stated no-op, and --apply is idempotent', () => {
    cwd = mkdtempSync(join(tmpdir(), 'migrate-adr-done-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'docs', 'ai', 'adr'), { recursive: true });
    assert.equal(run(['--apply'], quiet()), 0, 'first apply finalises');
    const nav = readFileSync(join(cwd, 'docs', 'ai', 'adr', 'log.md'), 'utf8');
    const io = quiet();
    assert.equal(run(['--apply'], io), 0, 'a second apply is a no-op, not a re-crossing');
    assert.match(io.out(), /already migrated/);
    assert.equal(readFileSync(join(cwd, 'docs', 'ai', 'adr', 'log.md'), 'utf8'), nav, 'the navigator is byte-identical');
  });
});

// ── the un-rotated old-scheme tree (no monolith was ever produced) ────────────────
//
// The cohort the signal used to miss entirely: the deployed rotator predates the store, the tree
// never rotated, so there is no monolith to detect. Its own gate says "OK — every tier is within its
// cap" forever. The discriminator is that deployed script's provenance.

const mkUnrotatedLayout = ({ rotatorIsNew = false, extraScripts = ['check-docs-size.mjs'] } = {}) => {
  cwd = mkdtempSync(join(tmpdir(), 'migrate-adr-unrotated-'));
  dirs.push(cwd);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), tier('Architecture Decision Records (ADRs)', 500, { id: '001', t: 'First' }, { id: '002', t: 'Second' }));
  const scripts = join(cwd, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const rotator = rotatorIsNew
    ? readFileSync(join(KIT_SCRIPTS, 'archive-decisions.mjs'), 'utf8')
    : "// a pre-migration rotator: three tiers, no store\nexport const HOT_REL = 'docs/ai/decisions.md';\n";
  writeFileSync(join(scripts, 'archive-decisions.mjs'), rotator);
  for (const name of extraScripts) writeFileSync(join(scripts, name), '// an OLD deployed enforcement script (pre-migration)\n');
  return cwd;
};

const canonBytes = (name) => readFileSync(join(KIT_SCRIPTS, name), 'utf8');

describe('migrate-adr-store — the un-rotated old-scheme crossing', () => {
  it('--dry-run names snapshot + refresh + store seeding, and writes NOTHING', () => {
    mkUnrotatedLayout();
    const hotBefore = readFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), 'utf8');
    const rotatorBefore = readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8');
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /predates the one-file-per-ADR store/);
    assert.match(io.out(), /snapshot →/);
    assert.match(io.out(), /refresh 2 enforcement script/);
    assert.match(io.out(), /seed the store/);
    assert.match(io.out(), /with --apply/, 'the go-ahead is printed for a tree that can converge');
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'adr')), 'no store written on dry-run');
    assert.equal(readFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), 'utf8'), hotBefore, 'HOT byte-identical');
    assert.equal(readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8'), rotatorBefore, 'the rotator is NOT refreshed by a dry-run');
  });

  it('a malformed substrate: --dry-run exits non-zero, prints NO go-ahead, and writes nothing', () => {
    mkUnrotatedLayout();
    writeFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), '---\nmaxLines: 500\n---\n\n# ADRs\n\n## not a canonical heading\n\nBody.\n');
    const io = quiet();
    assert.equal(run([], io), 1);
    assert.doesNotMatch(io.out(), /with --apply/, 'a tree that cannot converge never gets a go-ahead');
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'adr')), 'nothing written');
  });

  it('--apply seeds the store, leaves the tree gate-green, and the layout survey then reads migrated', () => {
    mkUnrotatedLayout();
    assert.equal(surveyProject(cwd).adrLayout, 'old-unrotated', 'the detector flags it before the crossing');
    const io = quiet();
    assert.equal(run(['--apply'], io), 0);
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'adr', 'log.md')), 'the navigator exists');
    assert.equal(readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8'), canonBytes('archive-decisions.mjs'), 'the rotator is refreshed to the kit canon');
    // The convergence bind: the crossing and the detector are asserted against EACH OTHER, so the
    // signal provably goes quiet — the advisor guard could never disarm otherwise.
    assert.equal(surveyProject(cwd).adrLayout, 'migrated', 'the crossed tree is migrated');
  });

  it('every refresh target matches the canon in BYTES and in MODE — not just the discriminator', () => {
    mkUnrotatedLayout();
    assert.equal(run(['--apply'], quiet()), 0);
    for (const name of ['archive-decisions.mjs', 'check-docs-size.mjs']) {
      assert.equal(readFileSync(join(cwd, 'scripts', name), 'utf8'), canonBytes(name), `${name} bytes`);
      assert.equal(statSync(join(cwd, 'scripts', name)).mode & 0o777, statSync(join(KIT_SCRIPTS, name)).mode & 0o777, `${name} mode`);
    }
  });

  // The convergence bind in its sharpest form: the detector calls an old rotator beside a finished
  // store `old-unrotated`, so if the tool called that tree done the signal would stay lit forever
  // with nothing able to clear it.
  it('an OLD rotator beside a FINALISED store still converges — apply refreshes it and the layout reads migrated', () => {
    mkUnrotatedLayout();
    assert.equal(run(['--apply'], quiet()), 0, 'first crossing');
    // put the pre-migration rotator back: the store is finished, the script is not
    writeFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), "// a pre-migration rotator\nexport const HOT_REL = 'docs/ai/decisions.md';\n");
    assert.equal(surveyProject(cwd).adrLayout, 'old-unrotated', 'the detector still flags it');
    const io = quiet();
    assert.equal(run(['--apply'], io), 0);
    assert.doesNotMatch(io.out(), /already migrated/, 'a stale rotator is not a finished migration');
    assert.equal(surveyProject(cwd).adrLayout, 'migrated', 'and now it converges');
  });

  // The consent preview must describe THIS tree. Keying the wording on "is there a store" called an
  // already-refreshed rotator outdated — in the one message whose whole job is to be accurate.
  it('the dry-run preview STATES the two facts and summarises neither', () => {
    // A current rotator beside stale siblings is a supported state, so any sentence that summarises
    // "the scripts" is wrong for it. The preview reports the rotator and the store separately, and
    // which scripts are stale is the refresh line's job alone.
    mkUnrotatedLayout({ rotatorIsNew: true });
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /archive-decisions\.mjs: already names the store/);
    assert.match(io.out(), /docs\/ai\/adr\/: absent/);
    assert.doesNotMatch(io.out(), /predates the one-file-per-ADR store/, 'a current rotator is never called outdated');
    assert.doesNotMatch(io.out(), /scripts are current/, 'the sibling scripts are NOT claimed current');
  });

  // The preview may not infer "nothing to refresh" from an absent rotator: a SIBLING script can
  // still be stale, and the very next line would then contradict it.
  it('an absent rotator is reported as absent, never as "nothing to refresh"', () => {
    mkUnrotatedLayout();
    rmSync(join(cwd, 'scripts', 'archive-decisions.mjs'));
    mkdirSync(join(cwd, 'docs', 'ai', 'adr'), { recursive: true }); // a store, so the no-rotator no-op does not fire
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /archive-decisions\.mjs: not deployed$/m);
    assert.match(io.out(), /refresh 1 enforcement script/, 'a stale sibling IS still refreshed');
  });

  // A tree the tool could not READ must never be reported as a tree with nothing in it.
  it('an UNREADABLE substrate is a loud refusal, never a confident "nothing to migrate"', () => {
    mkUnrotatedLayout();
    const io = quiet();
    const eacces = (p) => {
      if (String(p).endsWith('docs/ai/adr') || String(p).endsWith('docs/ai/decisions.md')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return statSync(p);
    };
    assert.equal(run([], io, { statSync: eacces }), 1);
    assert.match(io.err(), /could not inspect/);
    assert.doesNotMatch(io.out(), /nothing to migrate/, 'an unreadable tree is never called empty');
  });

  // Every path in this arm asks the same way: no `existsSync` survives to turn a permission error
  // into "not there". The navigator is the one an earlier fold left behind.
  it('an unreadable NAVIGATOR is loud too, not silently "not finalised"', () => {
    mkUnrotatedLayout();
    assert.equal(run(['--apply'], quiet()), 0, 'crossing completes');
    const io = quiet();
    const eacces = (p) => {
      if (String(p).endsWith('docs/ai/adr/log.md')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return statSync(p);
    };
    assert.equal(run(['--apply'], io, { statSync: eacces }), 1);
    assert.match(io.err(), /could not inspect/);
  });

  it('the same two facts on an old-scheme tree', () => {
    mkUnrotatedLayout();
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /archive-decisions\.mjs: predates the one-file-per-ADR store/);
    assert.match(io.out(), /docs\/ai\/adr\/: absent/);
  });

  it('a PARTIALLY refreshed tree (rotator already new, siblings stale) is completed, not skipped', () => {
    // Exactly the crash state: the discriminator flipped, the rest of the refresh never happened.
    mkUnrotatedLayout({ rotatorIsNew: true });
    assert.equal(run(['--apply'], quiet()), 0);
    assert.equal(readFileSync(join(cwd, 'scripts', 'check-docs-size.mjs'), 'utf8'), canonBytes('check-docs-size.mjs'), 'the sibling the resume could have skipped is refreshed');
    assert.equal(surveyProject(cwd).adrLayout, 'migrated');
  });

  it('a crash during seeding converges on retry (the crossing is idempotent)', () => {
    mkUnrotatedLayout();
    let attempt = 0;
    const failingSeed = (argv, opts) => {
      if (argv[0] === '--write-navigator' && !argv.includes('--dry-run') && attempt++ === 0) return 1;
      return runArchiveDecisions(argv, opts);
    };
    const io = quiet();
    assert.equal(run(['--apply'], io, { runArchiveDecisions: failingSeed }), 1, 'the failed seed is LOUD');
    assert.match(io.err(), /snapshot is at/, 'the failure names the snapshot');
    assert.equal(run(['--apply'], quiet(), { runArchiveDecisions: failingSeed }), 0, 'the retry converges');
    assert.equal(surveyProject(cwd).adrLayout, 'migrated');
  });

  // The retry has to repair what the failure left behind. `--check` never looks at the index, so a
  // finalisation test built on it alone reported "already migrated" over a stale index forever.
  it('after a FAILED index regeneration, the retry repairs it instead of reporting already-migrated', () => {
    mkUnrotatedLayout();
    let failIndex = true;
    const regen = () => (failIndex ? { ok: false, detail: 'the index generator is not beside this script' } : { ok: true, detail: '' });
    assert.equal(run(['--apply'], quiet(), { regenerateIndex: regen }), 1, 'the first run fails closed');
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'adr', 'log.md')), 'the navigator did land');
    failIndex = false;
    const io = quiet();
    // A stale index must NOT read as finalised: the retry re-seeds and regenerates it.
    assert.equal(run(['--apply'], io, { regenerateIndex: regen, spawnSync: () => ({ status: 1 }) }), 0);
    assert.doesNotMatch(io.out(), /already migrated/, 'a tree with a stale index is not "already migrated"');
    assert.match(io.out(), /seeded/);
  });

  it('a failed index regeneration fails the crossing CLOSED', () => {
    mkUnrotatedLayout();
    const io = quiet();
    assert.equal(run(['--apply'], io, { regenerateIndex: () => ({ ok: false, detail: 'the index generator is not beside this script' }) }), 1);
    assert.match(io.err(), /index\.md was NOT regenerated/);
    assert.match(io.err(), /snapshot is at/);
  });

  it('--dry-run refuses the go-ahead when no out-of-tree snapshot location exists', () => {
    mkUnrotatedLayout();
    const io = quiet();
    // the fallback would land INSIDE the work tree, so it is not a durable snapshot base
    assert.equal(run([], io, { snapshotFallbackBase: cwd }), 1);
    assert.match(io.err(), /no out-of-tree snapshot location/);
    assert.doesNotMatch(io.out(), /with --apply/, 'never green-light an apply that would refuse');
  });

  it('--apply runs the preflight FIRST: a malformed substrate touches nothing', () => {
    mkUnrotatedLayout();
    const rotatorBefore = readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8');
    writeFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), '---\nmaxLines: 500\n---\n\n# ADRs\n\n## not a canonical heading\n\nBody.\n');
    const io = quiet();
    assert.equal(run(['--apply'], io), 1);
    assert.match(io.err(), /refusing to touch the tree/);
    assert.equal(readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8'), rotatorBefore, 'no script was refreshed');
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'adr')), 'no store was seeded');
  });

  it("a seeded store whose own gate still fails is LOUD and names the snapshot", () => {
    mkUnrotatedLayout();
    const io = quiet();
    const checkFails = (argv, opts) => (argv[0] === '--check' ? 1 : runArchiveDecisions(argv, opts));
    assert.equal(run(['--apply'], io, { runArchiveDecisions: checkFails }), 1);
    assert.match(io.err(), /its own gate does not pass/);
    assert.match(io.err(), /snapshot is at/);
  });

  it('an old-scheme tree with NEITHER HOT nor store is a neutral no-op — never "a fresh new-scheme tree"', () => {
    mkUnrotatedLayout();
    rmSync(join(cwd, 'docs', 'ai', 'decisions.md'));
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /no ADR substrate/);
    assert.doesNotMatch(io.out(), /new-scheme/, 'an old-scheme tree is never described as new-scheme');
  });

  it('no deployed rotation script at all is a stated no-op that points at upgrade (No-Node included)', () => {
    mkUnrotatedLayout();
    rmSync(join(cwd, 'scripts'), { recursive: true });
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /no deployed rotation script/);
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'adr')), 'a tree with nothing to maintain a store is never given one');
  });
});

describe('migrate-adr-store — dry-run writes nothing', () => {
  it('prints the plan + conservation proof and leaves the tree byte-identical', () => {
    mkOldLayout({ git: true });
    const before = readFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), 'utf8');
    const io = quiet();
    assert.equal(run([], io), 0);
    // No writes: monoliths still present, decisions.md unchanged, no adr/ store.
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive.md')), 'WARM monolith untouched');
    assert.equal(readFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), 'utf8'), before, 'HOT byte-identical');
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'adr')), 'no adr/ store written on dry-run');
    assert.match(io.out(), /--dry-run/);
    assert.match(io.out(), /snapshot →/);
    assert.match(io.out(), /conserved/, 'the rotator conservation proof is surfaced in the preview');
  });

  it('a dry-run whose rotation would fail exits nonzero and does NOT green-light --apply (review-adr-migrate-r01-major-01)', () => {
    mkOldLayout({ git: true });
    const hot = join(cwd, 'docs', 'ai', 'decisions.md');
    writeFileSync(hot, `${readFileSync(hot, 'utf8')}\n## not an ADR heading\n\nstray body.\n`);
    const io = quiet();
    assert.equal(run([], io), 1, 'a failing dry-run surfaces the rotation exit code, never 0');
    assert.doesNotMatch(io.out(), /again with --apply/, 'a failed dry-run must not print the apply go-ahead');
    assert.match(io.err(), /NOT safe to --apply/);
  });

  it('a dry-run with no out-of-tree snapshot location does NOT green-light --apply either (review-adr-migrate-r02-minor-01)', () => {
    mkOldLayout({ git: false });
    const io = quiet();
    // Non-git + a fallback under cwd → resolveSnapshotDir returns dir:null → --apply would refuse.
    assert.equal(run([], io, { snapshotFallbackBase: cwd }), 1);
    assert.doesNotMatch(io.out(), /again with --apply/, 'a dry-run must not green-light an apply that will refuse');
    assert.match(io.err(), /no out-of-tree snapshot location/);
  });
});

describe('migrate-adr-store — apply performs the migration', () => {
  it('snapshots, force-refreshes the scripts, explodes the monoliths, retires them, and is idempotent', () => {
    mkOldLayout({ git: true });
    const io = quiet();
    assert.equal(run(['--apply'], io), 0);

    // Monoliths retired, adr/ records written for the archived ids, HOT retains the newest.
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive.md')), 'WARM monolith retired');
    assert.ok(!existsSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive-early.md')), 'COLD monolith retired');
    const records = readdirSync(join(cwd, 'docs', 'ai', 'adr')).filter((f) => /^AD-\d{3,}-.*\.md$/.test(f)).sort();
    assert.deepEqual(records, ['AD-001-first.md', 'AD-002-second.md'], 'the two archived ADRs became records');
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'adr', 'log.md')), 'the navigator is generated');
    assert.match(readFileSync(join(cwd, 'docs', 'ai', 'decisions.md'), 'utf8'), /## AD-003/, 'HOT retains the newest window');

    // The deployed enforcement scripts were force-refreshed to the kit canon.
    assert.equal(
      readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8'),
      readFileSync(join(KIT_SCRIPTS, 'archive-decisions.mjs'), 'utf8'),
      'archive-decisions.mjs refreshed to the kit canon',
    );

    // A durable snapshot landed in the git dir (uncommittable), holding decisions.md + both monoliths + scripts.
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim();
    const snapDir = join(gitDir, `agent-workflow-adr-migration-snapshot-${STAMP}`);
    assert.ok(existsSync(snapDir), 'snapshot dir created in the git dir');
    const snapFiles = readdirSync(snapDir).sort();
    assert.ok(snapFiles.includes('docs__ai__decisions.md'), 'snapshot holds decisions.md');
    assert.ok(snapFiles.includes('docs__ai__history__decisions-archive.md'), 'snapshot holds the WARM monolith');
    assert.ok(snapFiles.includes('scripts__archive-decisions.mjs'), 'snapshot holds the pre-refresh script');

    // Idempotent: a second apply is a no-op (monoliths already gone).
    const io2 = quiet();
    assert.equal(run(['--apply'], io2), 0);
    assert.match(io2.out(), /already migrated/);
  });

  it('a non-git deployment snapshots to the stated out-of-tree fallback', () => {
    mkOldLayout({ git: false });
    const fallback = mkdtempSync(join(tmpdir(), 'migrate-adr-fallback-'));
    dirs.push(fallback);
    const io = quiet();
    assert.equal(run(['--apply'], io, { snapshotFallbackBase: fallback }), 0);
    assert.ok(existsSync(join(fallback, `agent-workflow-adr-migration-snapshot-${STAMP}`)), 'snapshot in the fallback base');
    assert.match(io.out(), /out-of-tree fallback/);
  });

  it('refuses when the only snapshot base would land inside the work tree (review-adr-migrate-r01-minor-01)', () => {
    mkOldLayout({ git: false });
    const io = quiet();
    // A fallback base UNDER cwd would put the snapshot in the (stageable) work tree — reject it.
    assert.equal(run(['--apply'], io, { snapshotFallbackBase: cwd }), 1);
    assert.match(io.err(), /no out-of-tree snapshot location/);
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive.md')), 'nothing migrated when the snapshot is refused');
  });

  it('a locally-edited enforcement script is snapshotted before it is overwritten (never silently clobbered)', () => {
    mkOldLayout({ git: true });
    const edited = '// a LOCAL hand-edit the maintainer made\n';
    writeFileSync(join(cwd, 'scripts', 'check-docs-size.mjs'), edited);
    const io = quiet();
    assert.equal(run(['--apply'], io), 0);
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim();
    const snap = readFileSync(join(gitDir, `agent-workflow-adr-migration-snapshot-${STAMP}`, 'scripts__check-docs-size.mjs'), 'utf8');
    assert.equal(snap, edited, 'the local edit is preserved in the snapshot');
    assert.notEqual(readFileSync(join(cwd, 'scripts', 'check-docs-size.mjs'), 'utf8'), edited, 'the deployed copy is refreshed to canon');
  });

  it('a pre-flight validation failure aborts before any mutation (exit 1, nothing touched)', () => {
    mkOldLayout({ git: true });
    // A non-canonical H2 heading in the HOT window fails the dry-run pre-flight parse.
    const hot = join(cwd, 'docs', 'ai', 'decisions.md');
    writeFileSync(hot, `${readFileSync(hot, 'utf8')}\n## not an ADR heading\n\nstray body.\n`);
    const scriptBefore = readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8');
    const io = quiet();
    assert.equal(run(['--apply'], io), 1);
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive.md')), 'the monolith is untouched on abort');
    assert.equal(readFileSync(join(cwd, 'scripts', 'archive-decisions.mjs'), 'utf8'), scriptBefore, 'the scripts are NOT refreshed on abort');
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).trim();
    assert.ok(!existsSync(join(gitDir, `agent-workflow-adr-migration-snapshot-${STAMP}`)), 'no snapshot is written on abort');
    assert.match(io.err(), /refusing to touch the tree/, 'the pre-flight refusal is stated');
  });
});

describe('migrate-adr-store — error paths + help', () => {
  it('--help prints the usage and exits 0', () => {
    const io = quiet();
    assert.equal(main(['--help'], { log: io.log, error: io.error }), 0);
    assert.match(io.out(), /usage: migrate-adr-store/);
  });

  it('an unwritable snapshot location (mkdir throws for every base) fails loud (exit 1)', () => {
    mkOldLayout({ git: true });
    const io = quiet();
    const code = run(['--apply'], io, { mkdir: () => { throw new Error('EACCES'); } });
    assert.equal(code, 1);
    assert.match(io.err(), /no writable snapshot location/);
    assert.ok(existsSync(join(cwd, 'docs', 'ai', 'history', 'decisions-archive.md')), 'nothing migrated when the snapshot cannot be written');
  });

  it('a rotation that fails AFTER the snapshot + refresh reports the snapshot path (exit 1)', () => {
    mkOldLayout({ git: true });
    const io = quiet();
    // Pre-flight (--migrate, no --apply) passes; the real --migrate --apply fails → the post-refresh guard.
    const runArchiveDecisions = (argv) => (argv.includes('--apply') ? 1 : 0);
    const code = run(['--apply'], io, { runArchiveDecisions });
    assert.equal(code, 1);
    assert.match(io.err(), /the rotation failed/);
    assert.match(io.err(), /snapshot is at/);
  });
});

describe('migrate-adr-store — planScriptRefresh is directional', () => {
  it('refreshes only kit-canon basenames the consumer already deploys; never adds a missing one', () => {
    mkOldLayout({ deployedScripts: ['archive-decisions.mjs'] }); // check-docs-size.mjs NOT deployed
    const refresh = planScriptRefresh(cwd);
    const names = refresh.map((r) => r.name);
    assert.ok(names.includes('archive-decisions.mjs'), 'the deployed script is a refresh candidate');
    assert.ok(!names.includes('check-docs-size.mjs'), 'a canon script the consumer lacks is NEVER added');
    for (const r of refresh) assert.ok(existsSync(r.dst), 'every candidate already exists at the consumer');
  });
});

describe('migrate-adr-store — companion seed keeps refreshed archivers loadable', () => {
  // The refresh is directional (never ADDS a basename), but this kit's archivers import
  // ./markdown-blocks.mjs — refreshing an OLD deployment without seeding the module would leave
  // every refreshed archiver crashing on a missing import until a separate upgrade run.
  it('--apply seeds the markdown-blocks pair beside refreshed archivers, and they import cleanly', async () => {
    mkOldLayout({ git: true, deployedScripts: ['archive-decisions.mjs', 'archive-changelog.mjs', 'check-docs-size.mjs'] });
    const io = quiet();
    assert.equal(run(['--apply'], io), 0, io.err() || io.out());
    assert.ok(existsSync(join(cwd, 'scripts', 'markdown-blocks.mjs')), 'the runtime companion module is seeded');
    assert.ok(existsSync(join(cwd, 'scripts', 'markdown-blocks.test.mjs')), 'its deploy-payload test is seeded');
    // The load probe that matters: the refreshed deployed archivers resolve their imports.
    const { pathToFileURL } = await import('node:url');
    await import(pathToFileURL(join(cwd, 'scripts', 'archive-decisions.mjs')).href);
    await import(pathToFileURL(join(cwd, 'scripts', 'archive-changelog.mjs')).href);
  });

  // archive-caps.mjs is imported by archive-changelog.mjs ALONE, so it rides that archiver and no
  // other. Seeding it on a migration that never refreshed the changelog archiver would write a file
  // with no importer — the directional "never ADD a basename the consumer lacks" rule broken.
  it('seeds archive-caps ONLY when the changelog archiver is among the refreshed set', () => {
    mkOldLayout({ git: true, deployedScripts: ['archive-decisions.mjs', 'archive-changelog.mjs', 'check-docs-size.mjs'] });
    const io = quiet();
    assert.equal(run(['--apply'], io), 0, io.err() || io.out());
    // The PAIR, not just the module: pinning only the module would let its deploy-payload test
    // silently stop seeding, or go unconditional, without a red arm anywhere.
    assert.ok(existsSync(join(cwd, 'scripts', 'archive-caps.mjs')), 'the importer is refreshed, so its dependency is seeded');
    assert.ok(existsSync(join(cwd, 'scripts', 'archive-caps.test.mjs')), 'its deploy-payload test rides the same condition');
  });

  it('seeds NO archive-caps when the changelog archiver is absent from the consumer', () => {
    mkOldLayout({ git: true, deployedScripts: ['archive-decisions.mjs', 'check-docs-size.mjs'] });
    const io = quiet();
    assert.equal(run(['--apply'], io), 0, io.err() || io.out());
    assert.ok(existsSync(join(cwd, 'scripts', 'markdown-blocks.mjs')), 'every archiver imports it — still unconditional');
    assert.ok(!existsSync(join(cwd, 'scripts', 'archive-caps.mjs')), 'no importer here — a file with no importer must not be written');
    assert.ok(!existsSync(join(cwd, 'scripts', 'archive-caps.test.mjs')), 'its test must not be written either');
  });

  it('a dry run names the companion seed in the plan and writes nothing', () => {
    mkOldLayout({ git: true, deployedScripts: ['archive-decisions.mjs', 'check-docs-size.mjs'] });
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /markdown-blocks\.mjs/);
    assert.ok(!existsSync(join(cwd, 'scripts', 'markdown-blocks.mjs')), 'dry run seeds nothing');
  });
});

describe('migrate-adr-store — parseArgs', () => {
  it('defaults to dry-run; --apply flips it; --cwd captures a value', () => {
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs(['--apply']).apply, true);
    assert.equal(parseArgs(['--cwd', '/x']).cwd, '/x');
    assert.equal(parseArgs(['--help']).help, true);
  });
});

describe('migrate-adr-store — the mode reference contract (post-apply re-stamp ordering)', () => {
  it('orders the normal upgrade immediately after --apply, BEFORE the review/commit ask (the mode never writes stamps)', () => {
    const doc = readFileSync(resolve(HERE, '..', 'references', 'modes', 'migrate-adr-store.md'), 'utf8');
    assert.match(doc, /after a successful `--apply`, run the normal \*\*`upgrade`\*\* immediately/i, 'the re-stamp step is instructed');
    assert.match(doc, /before any\s+review\/commit ask/i, 'the ordering beats the commit gate — one gated commit covers layout + re-stamp');
    assert.match(doc, /never writes stamps/, 'the mode itself stays stamp-free (one consented action per surface)');
  });
});

describe('migrate-adr-store — the --apply success output matches the mode contract', () => {
  it('the success output instructs the normal upgrade BEFORE review/commit (never a commit-first instruct)', () => {
    mkOldLayout({ git: true });
    const io = quiet();
    assert.equal(run(['--apply'], io), 0);
    assert.match(io.out(), /run the normal upgrade/i, 'the success output routes to upgrade first (the re-stamp)');
    assert.match(io.out(), /never commits/, 'the no-commit invariant stays stated');
  });
});

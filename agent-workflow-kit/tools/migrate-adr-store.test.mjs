import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { main, parseArgs, planScriptRefresh, MIGRATE_ADR_STORE_STOP } from './migrate-adr-store.mjs';

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

  it('an already-migrated tree (adr/ present, no monoliths) is a stated no-op (exit 0)', () => {
    cwd = mkdtempSync(join(tmpdir(), 'migrate-adr-done-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'docs', 'ai', 'adr'), { recursive: true });
    const io = quiet();
    assert.equal(run([], io), 0);
    assert.match(io.out(), /already migrated/);
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

  it('a dry-run whose rotation would fail exits nonzero and does NOT green-light --apply (codex R1 major)', () => {
    mkOldLayout({ git: true });
    const hot = join(cwd, 'docs', 'ai', 'decisions.md');
    writeFileSync(hot, `${readFileSync(hot, 'utf8')}\n## not an ADR heading\n\nstray body.\n`);
    const io = quiet();
    assert.equal(run([], io), 1, 'a failing dry-run surfaces the rotation exit code, never 0');
    assert.doesNotMatch(io.out(), /again with --apply/, 'a failed dry-run must not print the apply go-ahead');
    assert.match(io.err(), /NOT safe to --apply/);
  });

  it('a dry-run with no out-of-tree snapshot location does NOT green-light --apply either (codex R2 minor)', () => {
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

  it('refuses when the only snapshot base would land inside the work tree (codex R1 minor)', () => {
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

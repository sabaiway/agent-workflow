// migrate-gates-branches.test.mjs — the refusal/no-op branch pins the main spec file leaves
// unexercised (colocated so the D3(d) changed-line check reads real executions, not intentions):
// the --help arm, the missing-declaration no-op, the invalid-shape STOP, the honest no-op split
// on final-run-capability, the mid-write parent-verification failure (fail closed + tmp cleanup),
// and the loud-but-non-fatal retired-store cleanup error.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { UNIT_TESTS_COVERAGE_FLAGS, RETIRED_STORE_BASENAMES, main } from './migrate-gates.mjs';

const KIT_TOOLS = mkdtempSync(join(tmpdir(), 'migrate-branches-kit-'));
writeFileSync(join(KIT_TOOLS, 'coverage-check.mjs'), '// the installed checker the migration points at\n');

const mkProject = (gates) => {
  const root = mkdtempSync(join(tmpdir(), 'migrate-branches-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  if (gates !== undefined) {
    writeFileSync(join(root, 'docs', 'ai', 'gates.json'), typeof gates === 'string' ? gates : `${JSON.stringify({ gates }, null, 2)}\n`);
  }
  return root;
};
const quiet = () => {
  const out = [];
  const err = [];
  return { log: (l) => out.push(String(l)), error: (l) => err.push(String(l)), out, err };
};

const UNIT_DONE = { id: 'unit-tests', title: 'U', cmd: `node --test ${UNIT_TESTS_COVERAGE_FLAGS} tools/*.test.mjs` };
const CHECKER = { id: 'coverage-check', title: 'CC', cmd: `node "${join(KIT_TOOLS, 'coverage-check.mjs')}" --check` };
const REVIEW_STATE = { id: 'review-state', title: 'RS', cmd: `node "${join(KIT_TOOLS, 'review-state.mjs')}" --check` };
const LEGACY = { id: 'review-ledger', title: 'L', cmd: 'node "/kit/tools/review-ledger.mjs" --check' };
const UNIT = { id: 'unit-tests', title: 'U', cmd: 'node --test tools/*.test.mjs' };

describe('migrate-gates — refusal and no-op branches', () => {
  it('--help prints the contract and exits 0', () => {
    const io = quiet();
    assert.equal(main(['--help'], io), 0);
    assert.match(io.out.join('\n'), /Usage:/);
  });

  it('the no-op split is HONEST about final-run-capability (capable names it; incapable never does)', () => {
    const capable = mkProject([UNIT_DONE, REVIEW_STATE, CHECKER]);
    const io = quiet();
    assert.equal(main(['--cwd', capable, '--kit-tools', KIT_TOOLS], io), 0);
    assert.match(io.out.join('\n'), /already final-run-capable/);
    rmSync(capable, { recursive: true, force: true });

    const incapable = mkProject([UNIT_DONE, CHECKER]);
    const io2 = quiet();
    assert.equal(main(['--cwd', incapable, '--kit-tools', KIT_TOOLS], io2), 0);
    const text = io2.out.join('\n');
    assert.match(text, /nothing to migrate mechanically/);
    assert.match(text, /NOT final-run-capable/);
    assert.doesNotMatch(text, /already final-run-capable/);
    rmSync(incapable, { recursive: true, force: true });
  });

  it('docs/ai WITHOUT a gates.json (and no stores) is a stated no-op, never a crash', () => {
    const root = mkProject(undefined);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0);
    assert.match(io.out.join('\n'), /nothing to migrate/);
    rmSync(root, { recursive: true, force: true });
  });

  it('a parseable-but-invalid declaration ({ gates: <non-array> }) is a loud STOP', () => {
    const root = mkProject('{ "gates": 5 }\n');
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 1);
    assert.match(io.err.join('\n'), /not a \{ gates/);
    rmSync(root, { recursive: true, force: true });
  });

  it('an lstat failure DURING the write fails CLOSED — nothing written, the tmp cleaned', () => {
    const root = mkProject([LEGACY, UNIT]);
    const before = readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8');
    const tmpExists = () => readdirSync(join(root, 'docs', 'ai')).some((f) => f.endsWith('.tmp'));
    const io = {
      ...quiet(),
      // Fail the parent verification the moment the tmp file exists — that is exactly the
      // PRE-RENAME re-check, whatever the lstat call count is (count-anchored injection went
      // silently stale once loadDeclaration became an lstat consumer too).
      lstat: (p) => {
        if (tmpExists()) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return lstatSync(p);
      },
    };
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 1);
    assert.match(io.err.join('\n'), /cannot verify the declaration parent/);
    assert.equal(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8'), before, 'the declaration is untouched');
    assert.deepEqual(readdirSync(join(root, 'docs', 'ai')).filter((f) => f.endsWith('.tmp')), [], 'no tmp litter survives (the writer catch cleaned it)');
    rmSync(root, { recursive: true, force: true });
  });

  it('a NON-canonical entry squatting the checker id is a loud STOP on preview AND apply (never a duplicate row)', () => {
    const squatter = { id: 'coverage-check', title: 'C', cmd: 'node scripts/coverage-check.mjs --check' };
    const root = mkProject([squatter, UNIT]);
    for (const argv of [['--cwd', root, '--kit-tools', KIT_TOOLS], ['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply']]) {
      const io = quiet();
      assert.equal(main(argv, io), 1, `must STOP: ${argv.join(' ')}`);
      assert.match(io.err.join('\n'), /id collision/);
    }
    const after = JSON.parse(readFileSync(join(root, 'docs', 'ai', 'gates.json'), 'utf8')).gates;
    assert.equal(after.filter((g) => g.id === 'coverage-check').length, 1, 'nothing was written');
    rmSync(root, { recursive: true, force: true });
  });

  it('a canonical checker addressed THROUGH A SYMLINKED kit dir is recognized (realpath, never lexical)', () => {
    const linked = join(tmpdir(), `migrate-branches-link-${process.pid}`);
    rmSync(linked, { force: true });
    symlinkSync(KIT_TOOLS, linked);
    const throughLink = { id: 'coverage-check', title: 'CC', cmd: `node "${join(linked, 'coverage-check.mjs')}" --check` };
    const root = mkProject([throughLink, UNIT]);
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS], io), 0, io.err.join('\n'));
    const text = io.out.join('\n');
    assert.doesNotMatch(text, /id collision/, 'the symlinked canonical checker is never a collision');
    assert.doesNotMatch(text, /ADD coverage-check/, 'no duplicate checker is added');
    rmSync(linked, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('a NON-ENOENT lstat failure on the gates.json LEAF is a loud STOP — never read as "missing"', () => {
    const root = mkProject([LEGACY, UNIT]);
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(root, '.git', RETIRED_STORE_BASENAMES[0]), '{"dead":1}\n');
    const io = {
      ...quiet(),
      lstat: (p) => {
        if (p.endsWith('gates.json')) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
        return lstatSync(p);
      },
    };
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 1, 'an unreadable declaration must STOP the apply');
    assert.match(io.err.join('\n'), /EACCES/);
    assert.ok(lstatSync(join(root, '.git', RETIRED_STORE_BASENAMES[0])).isFile(), 'the retired store is untouched on the STOP');
    rmSync(root, { recursive: true, force: true });
  });

  it('an un-unlinkable retired store is reported LOUDLY and never fails the migration', () => {
    const root = mkProject([LEGACY, UNIT]);
    spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    // A DIRECTORY at the store path: existsSync sees it, unlink refuses (EISDIR/EPERM) — the
    // deterministic un-unlinkable shape (permission bits vary by runner; a dir does not).
    mkdirSync(join(root, '.git', RETIRED_STORE_BASENAMES[0]), { recursive: true });
    const io = quiet();
    assert.equal(main(['--cwd', root, '--kit-tools', KIT_TOOLS, '--apply'], io), 0);
    const text = io.out.join('\n');
    assert.match(text, /could not clean .*review-ledger\.jsonl/, 'the cleanup failure is named');
    assert.match(text, /migrated .*gates\.json/, 'the migration itself still landed');
    rmSync(root, { recursive: true, force: true });
  });
});

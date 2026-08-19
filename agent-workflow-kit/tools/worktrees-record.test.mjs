// worktrees-record.test.mjs — the provision record as an ORIENTATION artifact, not just an identity
// stub. A fresh satellite session cannot derive three things from its own checkout: where the SHARED
// series index lives (and that copying it is forbidden), that landing runs from MAIN, and what this
// project's install posture is. The record now carries all three, and the mode doc carries the same
// live constants.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, runCli, parseProvisionRecord, handoffBasename } from './worktrees.mjs';
// Authored WITH the fixtures below: imported dynamically so this spec LOADS against the pre-fix
// tree and each fixture fails on its OWN assertion (the red-first doctrine).
const { QUEUE_SHARED_RULE, LANDING_FROM_MAIN } = await import('./worktrees.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREES_MODE_DOC = join(HERE, '..', 'references', 'modes', 'worktrees.md');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-record-'));
const PLAN_ARGS = ['--plan', 'docs/plans/SEED-PROMPT-x.md'];
const REPO_GITS = new Map();
const HEAD = '3333333333333333333333333333333333333333';

after(() => rmSync(TMP, { recursive: true, force: true }));

const makeGit = (main) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const porcelain = () => [
    [`worktree ${main}`, `HEAD ${HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  return (args) => {
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && args.includes('--git-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-tree') return ok();
    if (args[0] === 'ls-files') return ok();
    if ((args[0] === 'status' && args[1] === '--porcelain')
      || (args[0] === '--no-optional-locks' && args[1] === 'status' && args[2] === '--porcelain')) return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const branch = args[3];
      const canonical = join(realpathSync(dirname(args[4])), basename(args[4]));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
};

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  REPO_GITS.set(main, makeGit(main));
  return main;
};

const provisionOk = (repo, slug, extra = []) => {
  const out = [];
  const err = [];
  const code = runCli(['provision', slug, ...PLAN_ARGS, '--as', `feature-${slug}.md`, ...extra], {
    cwd: repo,
    git: REPO_GITS.get(repo),
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  });
  assert.equal(code, EXIT.ok, err.join('\n'));
  const worktree = join(dirname(repo), `${basename(repo)}--${slug}`);
  const text = readFileSync(join(worktree, 'docs/plans', handoffBasename(slug)), 'utf8');
  return {
    worktree,
    text,
    record: parseProvisionRecord(text),
    nodeModulesLine: out.find((line) => line.startsWith('  node_modules:')),
  };
};

describe('worktrees provision record — the three facts a fresh satellite session cannot derive', () => {
  it('provision-record carries the ABSOLUTE shared-queue path', () => {
    const repo = makeRepo('queue-path-main');
    const { record } = provisionOk(repo, 'qpath');
    assert.equal(record.sharedQueue, join(repo, 'docs/plans', 'queue.md'));
  });

  it('provision-record forbids copying the queue, stating why a copy diverges', () => {
    const repo = makeRepo('queue-rule-main');
    const { text } = provisionOk(repo, 'qrule');
    assert.ok(text.includes(QUEUE_SHARED_RULE), 'the record carries the live shared-queue rule verbatim');
    assert.match(QUEUE_SHARED_RULE, /never copy it/, 'the rule states the prohibition');
    assert.match(QUEUE_SHARED_RULE, /diverges/, 'and WHY — a machine-local copy silently diverges');
  });

  it('provision-record names landing as running FROM MAIN, with the runnable command', () => {
    const repo = makeRepo('landing-main');
    const { record } = provisionOk(repo, 'landme');
    assert.ok(record.landing.includes(LANDING_FROM_MAIN), 'the landing field states where landing runs');
    assert.match(record.landing, /land 'landme' --prepare|land landme --prepare/, 'and carries the actual command');
    assert.ok(record.landing.includes(repo), 'the command cd-s to MAIN, not to the satellite');
  });

  it('provision-record carries the resolved install posture — the runnable isolated-install command', () => {
    const repo = makeRepo('install-main');
    const { worktree, record } = provisionOk(repo, 'inst');
    assert.match(record.install, /npm install/, 'the posture is the real command, not a generic hint');
    assert.ok(record.install.includes(worktree), 'and it cd-s into THIS worktree (isolated install)');
  });

  // A plain `cd … && npm install` through a SYMLINKED node_modules writes into MAIN — the record
  // must never present that as isolated. When provision symlinks main's node_modules, the recorded
  // posture is the unlink-first form.
  it('a symlinked node_modules records the unlink-first install posture, never the plain command', () => {
    const repo = makeRepo('install-symlink-main');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    const { worktree, record } = provisionOk(repo, 'instlink');
    assert.match(record.install, /writes into MAIN/, 'the hazard is stated, not implied');
    assert.match(record.install, /remove it first: rm /, 'the unlink-first form is the recorded command');
    assert.ok(record.install.includes(join(worktree, 'node_modules')), 'the rm names THIS worktree symlink');
    assert.doesNotMatch(record.install, /^cd /, 'the bare cd-and-install form would install through the symlink');
  });

  it('existing user sections of the record are preserved across a --resume refresh', () => {
    const repo = makeRepo('preserve-main');
    const { worktree } = provisionOk(repo, 'keep');
    const handoff = join(worktree, 'docs/plans', handoffBasename('keep'));
    const before = readFileSync(handoff, 'utf8');
    const userSuffix = '\n## Session records\n\nhand-written, must survive\n';
    writeFileSync(handoff, `${before}${userSuffix}`);
    const out = [];
    const code = runCli(['provision', 'keep', '--resume', ...PLAN_ARGS, '--as', 'feature-keep.md'], {
      cwd: repo,
      git: REPO_GITS.get(repo),
      log: (line) => out.push(line),
      logError: () => {},
    });
    const after_ = readFileSync(handoff, 'utf8');
    assert.equal(code, EXIT.ok);
    assert.ok(after_.endsWith(userSuffix), 'the user-owned section is byte-preserved');
    const record = parseProvisionRecord(after_);
    assert.equal(record.sharedQueue, join(repo, 'docs/plans', 'queue.md'), 'and the tool section is refreshed');
    assert.ok(after_.includes(QUEUE_SHARED_RULE));
  });

  it('mode-doc matches the record contract — the same live constants in both', () => {
    const repo = makeRepo('doc-parity-main');
    const { text } = provisionOk(repo, 'docmatch');
    const doc = readFileSync(WORKTREES_MODE_DOC, 'utf8');
    for (const constant of [QUEUE_SHARED_RULE, LANDING_FROM_MAIN]) {
      assert.ok(text.includes(constant), `the record carries ${JSON.stringify(constant.slice(0, 40))}…`);
      assert.ok(doc.includes(constant), 'and so does references/modes/worktrees.md');
    }
  });
});

// ── the control-byte class (delegation Plan 3, Phase 2 — round-4/5 folds) ──────────────
//
// APPENDED, never woven in: every assertion above is byte-identical to what it was, and these are
// new distinctions. They live in THIS file rather than a new one for a mechanical reason worth
// stating — their red-proofs bind {base, testId}, and a testId can only be superseded where it was
// minted; moving them would leave obligations no run could ever satisfy at this base.
//
// The leaf was extracted byte-for-byte with ONE deliberate exception: the control-byte class was
// widened to cover C1. That tightening is pinned here rather than resting on the extraction claim.

const guardLeaf = () => import('./worktrees-record.mjs');

// Built by CODE POINT, never typed as literal bytes.
const withCode = (cp) => `a${String.fromCharCode(cp)}b`;

const C0 = [0x00, 0x09, 0x0a, 0x0d, 0x1f];
const C1 = [0x7f, 0x80, 0x85, 0x9b, 0x9f];
const LINE_TERMINATORS = [0x2028, 0x2029];

describe('worktrees-record — the control-byte class', () => {
  it('the record refuses a C1 value, not only a C0 one — the widening is a real tightening', async () => {
    const { WORKTREES_STOP, recordValue, hasControlByte } = await guardLeaf();
    for (const cp of [...C0, ...C1, ...LINE_TERMINATORS]) {
      assert.equal(hasControlByte(withCode(cp)), true, `U+${cp.toString(16)} must be in the class`);
      assert.throws(
        () => recordValue('branch', withCode(cp)),
        (e) => e.code === WORKTREES_STOP && /control character/.test(e.message),
        `U+${cp.toString(16)} must be refused as a record value`,
      );
    }
  });

  it('an ordinary value with punctuation, spaces and non-ASCII letters is still accepted', async () => {
    const { recordValue } = await guardLeaf();
    // The tightening must not have swallowed printable text: a branch or a path may legally carry
    // any of these, and refusing them would break provisioning rather than protect it.
    // The non-ASCII letters are written as escapes: same bytes at runtime, ASCII in the source, which
    // is the project's English-only invariant applied to a fixture that needs them.
    for (const value of ['aw/feature-1', 'a b', 'path/with.dots', 'caf\u00e9', '\u4e2d\u6587']) {
      assert.equal(recordValue('branch', value), value);
    }
  });

  it('a field line carrying CR or a Unicode line terminator refuses instead of reading back as absent', async () => {
    const { parseProvisionRecord, WORKTREES_STOP } = await guardLeaf();
    const section = (branch) => [
      '## Provision record', '', '- slug: alpha', `- branch: ${branch}`,
      '- node_modules: absent', '- vscode-settings: absent', '',
    ].join('\n');
    // A JS `.` crosses none of these, so the field line stops matching and the field would read back
    // as ABSENT — indistinguishable from an older kit that never wrote it.
    for (const cp of [0x0d, 0x2028, 0x2029]) {
      assert.throws(
        () => parseProvisionRecord(section(`aw/a${String.fromCharCode(cp)}b`)),
        (e) => e.code === WORKTREES_STOP && /silently read back as absent/.test(e.message),
        `U+${cp.toString(16)} must refuse, not vanish`,
      );
    }
    // A tab is crossed by `.` and trimmed on read — carried through, never a parse refusal.
    assert.equal(parseProvisionRecord(section('aw/a\t')).branch, 'aw/a');
  });

  it('displayValue renders every member of the class as a visible escape, never as itself', async () => {
    const { hasControlByte, displayValue } = await guardLeaf();
    for (const cp of [...C0, ...C1, ...LINE_TERMINATORS]) {
      const rendered = displayValue(withCode(cp));
      assert.equal(hasControlByte(rendered), false, `U+${cp.toString(16)} must not survive rendering`);
      assert.match(rendered, new RegExp(`^a\\\\u${cp.toString(16).padStart(4, '0')}b$`));
    }
    assert.equal(displayValue('aw/feature-1'), 'aw/feature-1', 'ordinary text is untouched');
  });
});

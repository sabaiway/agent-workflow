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

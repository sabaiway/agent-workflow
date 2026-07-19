// worktrees-attest.test.mjs — the post-cap attest folds' pins (fourth colocated file; the
// three earlier spec files are red-proof-frozen).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, runCli, rebaseAbsolutePins, composeProvisionArgv, spawnGit, handoffBasename } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-attest-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', '/.vscode/', ''];

const makeRepo = (name, { vscode = false, nodeModules = false } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), EXCLUDES.join('\n'));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  if (vscode) {
    mkdirSync(join(main, '.vscode'));
    writeFileSync(join(main, '.vscode/settings.json'), '{}');
  }
  if (nodeModules) {
    mkdirSync(join(main, 'node_modules'));
    writeFileSync(join(main, 'node_modules/marker.txt'), 'nm\n');
  }
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

// A git seam that fails ONE intercepted call class with a fatal status and delegates the rest.
const brokenGit = (matches, result = { status: 128, stdout: '', stderr: 'fatal: broken index' }) =>
  (args, cwd) => (matches(args) ? result : spawnGit(args, cwd));

describe('worktrees attest — post-add failures state the kept partial state (M1)', () => {
  it('a failure after worktree add names path, branch, and the FULL --resume invocation', () => {
    const repo = makeRepo('at-kept');
    const flags = { plan: 'docs/plans/SEED-PROMPT-x.md', as: 'feature-kp.md', branch: 'aw/custom-kp', dir: null, include: [], install: false, resume: false };
    const r = run(['provision', 'kp', '--plan', flags.plan, '--as', flags.as, '--branch', flags.branch], {
      cwd: repo,
      deps: { write: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /was created and KEPT/);
    const wt = join(dirname(repo), `${basename(repo)}--kp`);
    assert.ok(r.errText.includes(wt), 'the kept worktree path is named');
    assert.ok(r.errText.includes('aw/custom-kp'), 'the kept branch is named');
    const expected = composeProvisionArgv({ root: repo, slug: 'kp', flags: { ...flags, resume: true } });
    assert.ok(r.errText.includes(expected), `the full --resume invocation is printed:\n${expected}\nvs\n${r.errText}`);
  });
  it('a refused worktree add itself carries NO false KEPT note', () => {
    const repo = makeRepo('at-nokept');
    const r1 = run(['provision', 'nk', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-nk.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const r2 = run(['provision', 'nk', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-nk.md'], { cwd: repo });
    assert.equal(r2.code, EXIT.stop);
    assert.match(r2.errText, /git worktree add refused/);
    assert.doesNotMatch(r2.errText, /KEPT/);
  });
});

describe('worktrees attest — check-ignore/ls-files git errors are fatal, never "not ignored" (M2)', () => {
  it('the docs/plans gate: status 128 STOPs with git words, never the ignore-rules recommendation', () => {
    const repo = makeRepo('at-ci-plans');
    const git = brokenGit((args) => args[0] === 'check-ignore' && args.includes('docs/plans/'));
    const r = run(['provision', 'cip', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo, deps: { git } });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /fatal: broken index/);
    assert.doesNotMatch(r.errText, /Ignore docs\/plans/);
  });
  it('the .vscode ignore probe: status 128 STOPs with git words', () => {
    const repo = makeRepo('at-ci-vscode', { vscode: true });
    const git = brokenGit((args) => args[0] === 'check-ignore' && args.includes('.vscode/settings.json'));
    const r = run(['provision', 'civ', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo, deps: { git } });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /fatal: broken index/);
  });
  it('the node_modules ignore probe: status 128 STOPs with git words', () => {
    const repo = makeRepo('at-ci-nm', { nodeModules: true });
    const git = brokenGit((args) => args[0] === 'check-ignore' && args.includes('node_modules'));
    const r = run(['provision', 'cin', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo, deps: { git } });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /fatal: broken index/);
  });
  it('the .vscode ls-files probe: a failing `ls-files -- .vscode/settings.json` STOPs with git words', () => {
    const repo = makeRepo('at-ls-vscode', { vscode: true });
    const git = brokenGit(
      (args) => args[0] === 'ls-files' && args.includes('.vscode/settings.json'),
      { status: 128, stdout: '', stderr: 'fatal: index locked' },
    );
    const r = run(['provision', 'lsv', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo, deps: { git } });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /fatal: index locked/);
  });
});

describe('worktrees attest — list ENOENT honesty covers dangling and vanished paths (m3)', () => {
  it('a DANGLING docs/plans symlink renders (unreadable); a genuinely absent one renders no', () => {
    const repo = makeRepo('at-dangle');
    const r1 = run(['provision', 'dgl', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-dgl.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const wt = join(dirname(repo), `${basename(repo)}--dgl`);
    rmSync(join(wt, 'docs/plans'), { recursive: true, force: true });
    symlinkSync('gone-target', join(wt, 'docs/plans'));
    const dangling = run(['list'], { cwd: repo });
    assert.equal(dangling.code, EXIT.ok);
    assert.match(dangling.text, /handoff: \(unreadable\)/);
    rmSync(join(wt, 'docs/plans'));
    const absent = run(['list'], { cwd: repo });
    assert.equal(absent.code, EXIT.ok);
    assert.match(absent.text, /handoff: no/);
  });
  it('a worktree whose dir vanished (no prunable mark yet) renders (unreadable), never no', () => {
    const repo = makeRepo('at-vanish');
    const ghost = join(TMP, 'at-ghost-dir');
    const fakeList = [
      [`worktree ${repo}`, 'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'branch refs/heads/main'],
      [`worktree ${ghost}`, 'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'branch refs/heads/aw/ghost'],
    ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
    const git = (args, cwd) => (args[0] === 'worktree' ? { status: 0, stdout: fakeList, stderr: '' } : spawnGit(args, cwd));
    const r = run(['list'], { cwd: repo, deps: { git } });
    assert.equal(r.code, EXIT.ok);
    assert.match(r.text, /handoff: \(unreadable\)/);
    assert.doesNotMatch(r.text, /handoff: no/);
  });
});

describe('worktrees attest — replacement tokens are inert in ALL three encodings (m4)', () => {
  const cases = [
    {
      name: 'forward',
      text: 'node /a/main/tool.mjs --check',
      main: '/a/main',
      wt: '/a/ma$&in--w',
      expected: 'node /a/ma$&in--w/tool.mjs --check',
    },
    {
      name: 'raw backslash',
      text: 'node "C:\\u\\main\\t.mjs"',
      main: 'C:/u/main',
      wt: 'C:/m$&x--w',
      expected: 'node "C:\\m$&x--w\\t.mjs"',
    },
    {
      name: 'JSON-doubled backslash',
      text: JSON.stringify({ cmd: 'node C:\\u\\main\\t.mjs' }),
      main: 'C:/u/main',
      wt: 'C:/m$&x--w',
      expected: JSON.stringify({ cmd: 'node C:\\m$&x--w\\t.mjs' }),
    },
  ];
  for (const c of cases) {
    it(`${c.name}: a worktree root carrying $& rebases byte-exact`, () => {
      assert.equal(rebaseAbsolutePins(c.text, c.main, c.wt).text, c.expected);
    });
  }
});

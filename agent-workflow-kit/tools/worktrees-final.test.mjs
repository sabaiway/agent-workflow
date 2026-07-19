// worktrees-final.test.mjs — final-round fixes: no-follow content reads, record strictness,
// scan error honesty, config chain-before-default.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, lstatSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXIT, WORKTREES_STOP, runCli, loadWorktreesConfig, parseProvisionRecord,
} from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-final-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''];

const makeRepo = (name) => {
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
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

describe('worktrees final — F1 content reads never follow links', () => {
  it('F1 a symlinked worktree gates.json is never opened on resume (no follow, entry kept)', () => {
    const repo = makeRepo('f1-gates');
    const r1 = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const wt = join(dirname(repo), `${basename(repo)}--alpha`);
    const wtGates = join(wt, 'docs/ai/gates.json');
    const outside = join(TMP, 'f1-outside-gates.json');
    writeFileSync(outside, JSON.stringify({ gates: [] }));
    unlinkSync(wtGates);
    symlinkSync(outside, wtGates);
    const reads = [];
    const r2 = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], {
      cwd: repo,
      deps: { readFile: (p, enc) => { reads.push(p); return readFileSync(p, enc); } },
    });
    assert.equal(r2.code, EXIT.ok, r2.errText);
    assert.ok(!reads.includes(wtGates), 'a path whose lstat shows a symlink must never reach readFile');
    assert.ok(lstatSync(wtGates).isSymbolicLink(), 'the symlink itself stays untouched');
    assert.match(r2.text, /not a regular file — left untouched|unreadable at the worktree/);
  });
  it('F1 a node swapped after lstat is still refused (descriptor recheck)', () => {
    const repo = makeRepo('f1-swap');
    writeFileSync(join(repo, 'docs/ai/real.json'), '{}');
    symlinkSync('real.json', join(repo, 'docs/ai/worktrees.json'));
    const lie = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
    assert.throws(
      () => loadWorktreesConfig(repo, {
        lstat: (p) => (p === join(repo, 'docs/ai/worktrees.json') ? lie : lstatSync(p)),
      }),
      (e) => e.code === WORKTREES_STOP && /not a regular file/.test(e.message),
    );
  });
  it('F1 tripwire — content reads exist only inside the one no-follow door', () => {
    const src = readFileSync(new URL('./worktrees.mjs', import.meta.url), 'utf8');
    const count = (re) => (src.match(re) ?? []).length;
    assert.equal(count(/readFile\(/g), 0, 'raw readFile( calls must not exist — use the door');
    assert.equal(count(/readFileSync\(/g), 1, 'exactly one readFileSync( — the door body');
    assert.equal(count(/openSync\(/g), 1, 'exactly one openSync( — the door body');
    assert.equal(count(/createReadStream|readSync\(|readvSync/g), 0);
  });
});

describe('worktrees final — F2 provision-record strictness', () => {
  it('F2 a duplicated slug field is a typed STOP, never last-wins', () => {
    const text = [
      '## Provision record', '', '- slug: alpha', '- slug: alpha', '- branch: aw/alpha',
      '- node_modules: absent', '- vscode-settings: absent', '',
    ].join('\n');
    assert.throws(
      () => parseProvisionRecord(text),
      (e) => e.code === WORKTREES_STOP && /duplicate/.test(e.message) && /slug/.test(e.message),
    );
  });
  it('F2 fields outside the Provision record section are ignored', () => {
    const text = [
      '## Provision record', '', '- slug: alpha', '- branch: aw/alpha',
      '- node_modules: absent', '- vscode-settings: absent', '',
      '## Notes', '', '- slug: evil', '- branch: aw/evil', '',
    ].join('\n');
    const record = parseProvisionRecord(text);
    assert.equal(record.slug, 'alpha');
    assert.equal(record.branch, 'aw/alpha');
  });
  it('F2 multiple Provision record sections are a typed STOP', () => {
    const text = [
      '## Provision record', '', '- slug: a', '- branch: aw/a', '',
      '## Provision record', '', '- slug: b', '- branch: aw/b', '',
    ].join('\n');
    assert.throws(
      () => parseProvisionRecord(text),
      (e) => e.code === WORKTREES_STOP && /multiple/.test(e.message),
    );
  });
});

describe('worktrees final — F3 scan errors render honestly', () => {
  it('F3 a stat error inside the plans chain renders (unreadable) instead of crashing list', () => {
    const wt = join(TMP, 'f3-wt');
    mkdirSync(join(wt, 'docs'), { recursive: true });
    const porcelain = [
      `worktree ${TMP}`, 'HEAD aaaaaaaaaaaa', 'branch refs/heads/main', '',
      `worktree ${wt}`, 'HEAD bbbbbbbbbbbb', 'branch refs/heads/aw/x', '',
    ].join('\n');
    const git = (args) => (args[0] === 'worktree'
      ? { status: 0, stdout: porcelain, stderr: '' }
      : { status: 0, stdout: '', stderr: '' });
    const denied = join(wt, 'docs');
    const r = run(['list'], {
      cwd: TMP,
      deps: {
        git,
        lstat: (p) => {
          if (p === denied) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return lstatSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /\(unreadable\)/);
  });
});

describe('worktrees final — F4 config absence is trusted only under a plain chain', () => {
  it('F4 a symlinked docs or docs/ai ancestor is a STOP even when the config leaf is absent', () => {
    const rootA = join(TMP, 'f4-a');
    const outsideA = join(TMP, 'f4-a-outside');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(outsideA, { recursive: true });
    symlinkSync(outsideA, join(rootA, 'docs'));
    assert.throws(
      () => loadWorktreesConfig(rootA),
      (e) => e.code === WORKTREES_STOP && /not a plain director/.test(e.message),
    );
    const rootB = join(TMP, 'f4-b');
    const outsideB = join(TMP, 'f4-b-outside');
    mkdirSync(join(rootB, 'docs'), { recursive: true });
    mkdirSync(outsideB, { recursive: true });
    symlinkSync(outsideB, join(rootB, 'docs/ai'));
    assert.throws(
      () => loadWorktreesConfig(rootB),
      (e) => e.code === WORKTREES_STOP && /not a plain director/.test(e.message),
    );
  });
  it('F4 a stat error on an ancestor is a typed STOP naming the code, never silent absence', () => {
    const rootC = join(TMP, 'f4-c');
    mkdirSync(join(rootC, 'docs/ai'), { recursive: true });
    assert.throws(
      () => loadWorktreesConfig(rootC, {
        lstat: (p) => {
          if (p === join(rootC, 'docs')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return lstatSync(p);
        },
      }),
      (e) => e.code === WORKTREES_STOP && /EACCES/.test(e.message),
    );
  });
});

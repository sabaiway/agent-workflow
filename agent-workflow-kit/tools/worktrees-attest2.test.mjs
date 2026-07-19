// worktrees-attest2.test.mjs — the maintainer-directed second attest fold pass (fifth colocated
// file; the four earlier spec files are red-proof-frozen).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, lstatSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, WORKTREES_STOP, runCli, parseArgs, loadWorktreesConfig, handoffBasename } from './worktrees.mjs';
import { buildRecommendations } from './recommendations.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-att2-'));
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

const provisionOk = (repo, slug, extra = []) => {
  const r = run(['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`, ...extra], { cwd: repo });
  assert.equal(r.code, EXIT.ok, r.errText);
  return join(dirname(repo), `${basename(repo)}--${slug}`);
};

describe('worktrees attest2 — worktrees.json must be a regular, symlink-free-path file (M1)', () => {
  it('a SYMLINKED worktrees.json is a typed STOP with zero readFile calls on it', () => {
    const repo = makeRepo('a2-cfg-link');
    writeFileSync(join(repo, 'docs/ai/real-config.json'), JSON.stringify({ parentDir: TMP }));
    symlinkSync('real-config.json', join(repo, 'docs/ai/worktrees.json'));
    const reads = [];
    assert.throws(
      () => loadWorktreesConfig(repo, { readFile: (p, enc) => { reads.push(p); return readFileSync(p, enc); } }),
      (e) => e.code === WORKTREES_STOP && /not a regular file/.test(e.message),
    );
    assert.deepEqual(reads, [], 'the config must never be read through a link');
  });
  it('a DIRECTORY at the config path is the same typed STOP (never a malformed-JSON guess)', () => {
    const repo = makeRepo('a2-cfg-dir');
    mkdirSync(join(repo, 'docs/ai/worktrees.json'));
    assert.throws(
      () => loadWorktreesConfig(repo),
      (e) => e.code === WORKTREES_STOP && /not a regular file/.test(e.message),
    );
  });
  it('a FIFO-like non-regular node (injected stat) is the same STOP with zero reads', () => {
    const repo = makeRepo('a2-cfg-fifo');
    writeFileSync(join(repo, 'docs/ai/worktrees.json'), '{}');
    const fifoStat = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false, isFIFO: () => true };
    const reads = [];
    assert.throws(
      () => loadWorktreesConfig(repo, {
        lstat: (p) => (p === join(repo, 'docs/ai/worktrees.json') ? fifoStat : lstatSync(p)),
        readFile: (p, enc) => { reads.push(p); return readFileSync(p, enc); },
      }),
      (e) => e.code === WORKTREES_STOP && /not a regular file/.test(e.message),
    );
    assert.deepEqual(reads, []);
  });
  it('the recommendations advisor renders the same shape as a stated skip', () => {
    const repo = makeRepo('a2-cfg-advisor');
    writeFileSync(join(repo, 'docs/ai/.workflow-version'), '3.0.0\n');
    writeFileSync(join(repo, 'docs/ai/real-config.json'), JSON.stringify({ parentDir: TMP }));
    symlinkSync('real-config.json', join(repo, 'docs/ai/worktrees.json'));
    const { items, skips } = buildRecommendations({
      cwd: repo,
      deps: { findWrapper: () => false, env: { PATH: '/none' }, getenv: { PATH: '/none' }, home: repo, canWriteDir: () => false },
    });
    assert.ok(!items.some((i) => i.key === 'worktrees-dir'));
    assert.ok(skips.some((s) => s.key === 'worktrees-dir' && /not a regular file/.test(s.reason)));
  });
});

describe('worktrees attest2 — resume binds the live slug/branch to the existing handoff (M2)', () => {
  it('a SECOND slug resumed onto the same --dir/--branch worktree STOPs before any write (probe included)', () => {
    const repo = makeRepo('a2-id-slug');
    const dir = join(TMP, 'a2-id-slug-wt');
    const r1 = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md', '--dir', dir, '--branch', 'aw/shared'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const mkdirPlainCalls = [];
    const rmdirCalls = [];
    const r2 = run(['provision', 'beta', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-beta.md', '--dir', dir, '--branch', 'aw/shared'], {
      cwd: repo,
      deps: {
        mkdirPlain: (p) => mkdirPlainCalls.push(p),
        rmdir: (p) => rmdirCalls.push(p),
      },
    });
    assert.equal(r2.code, EXIT.stop);
    assert.match(r2.errText, /handoff.*alpha|alpha.*handoff/s);
    assert.ok(!existsSync(join(dir, 'docs/plans', handoffBasename('beta'))), 'no second handoff may be written');
    assert.deepEqual(mkdirPlainCalls, [], 'the writability probe must not run before identity checks on resume');
    assert.deepEqual(rmdirCalls, []);
  });
  it('an INTERNAL slug mismatch (handoff-alpha.md carrying slug: beta) is a typed STOP', () => {
    const repo = makeRepo('a2-id-int');
    const wt = provisionOk(repo, 'alpha');
    const handoffPath = join(wt, 'docs/plans', handoffBasename('alpha'));
    writeFileSync(handoffPath, readFileSync(handoffPath, 'utf8').replace('- slug: alpha', '- slug: beta'));
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /record.*slug|slug.*record/s);
  });
  it('a BRANCH mismatch in the record is a typed STOP', () => {
    const repo = makeRepo('a2-id-branch');
    const wt = provisionOk(repo, 'alpha');
    const handoffPath = join(wt, 'docs/plans', handoffBasename('alpha'));
    writeFileSync(handoffPath, readFileSync(handoffPath, 'utf8').replace('- branch: aw/alpha', '- branch: aw/other'));
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /record.*branch|branch.*record/s);
  });
  it('MISSING identity fields in the record are a typed STOP (malformed identity never passes)', () => {
    const repo = makeRepo('a2-id-missing');
    const wt = provisionOk(repo, 'alpha');
    writeFileSync(join(wt, 'docs/plans', handoffBasename('alpha')), '# Handoff — alpha\n\nno record here\n');
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /identity|record/);
  });
  it('MULTIPLE handoffs are a typed STOP naming them', () => {
    const repo = makeRepo('a2-id-multi');
    const wt = provisionOk(repo, 'alpha');
    writeFileSync(join(wt, 'docs/plans', handoffBasename('stray')), '# Handoff — stray\n');
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /handoff-alpha\.md/);
    assert.match(r.errText, /handoff-stray\.md/);
  });
  it('the MATCHING resume stays green', () => {
    const repo = makeRepo('a2-id-ok');
    provisionOk(repo, 'alpha');
    const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-alpha.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
  });
});

describe('worktrees attest2 — list scans the plans chain no-follow, regular files only (M3)', () => {
  it('a symlinked docs ANCESTOR renders (unreadable)', () => {
    const repo = makeRepo('a2-ls-anc');
    const wt = provisionOk(repo, 'anc');
    const outside = join(TMP, 'a2-ls-anc-outside');
    mkdirSync(join(outside, 'plans'), { recursive: true });
    rmSync(join(wt, 'docs'), { recursive: true, force: true });
    symlinkSync(outside, join(wt, 'docs'));
    const r = run(['list'], { cwd: repo });
    assert.equal(r.code, EXIT.ok);
    assert.match(r.text, /handoff: \(unreadable\)/);
    assert.doesNotMatch(r.text, /handoff: no/);
  });
  it('a handoff-NAMED entry that is a symlink or a directory renders (unreadable)', () => {
    const repo = makeRepo('a2-ls-nonfile');
    const wt = provisionOk(repo, 'nf');
    rmSync(join(wt, 'docs/plans', handoffBasename('nf')));
    mkdirSync(join(wt, 'docs/plans', handoffBasename('nf')));
    const r = run(['list'], { cwd: repo });
    assert.equal(r.code, EXIT.ok);
    assert.match(r.text, /handoff: \(unreadable\)/);
    rmSync(join(wt, 'docs/plans', handoffBasename('nf')), { recursive: true, force: true });
    symlinkSync('elsewhere.md', join(wt, 'docs/plans', handoffBasename('nf')));
    const r2 = run(['list'], { cwd: repo });
    assert.match(r2.text, /handoff: \(unreadable\)/);
  });
});

describe('worktrees attest2 — per-subcommand flag allowlists (m4)', () => {
  const rejections = [
    { argv: ['provision', 'x', '--abandon'], sub: 'provision', flag: '--abandon' },
    { argv: ['provision', 'x', '--prepare'], sub: 'provision', flag: '--prepare' },
    { argv: ['list', '--install'], sub: 'list', flag: '--install' },
    { argv: ['list', '--abandon'], sub: 'list', flag: '--abandon' },
    { argv: ['land', 'x', '--plan', 'p'], sub: 'land', flag: '--plan' },
    { argv: ['land', 'x', '--abandon'], sub: 'land', flag: '--abandon' },
    { argv: ['cleanup', 'x', '--plan', 'p'], sub: 'cleanup', flag: '--plan' },
    { argv: ['cleanup', 'x', '--install'], sub: 'cleanup', flag: '--install' },
  ];
  for (const c of rejections) {
    it(`${c.sub} rejects ${c.flag} naming both`, () => {
      assert.throws(
        () => parseArgs(c.argv),
        (e) => e.exitCode === EXIT.usage && e.message.includes(c.sub) && e.message.includes(c.flag),
      );
    });
  }
  const accepted = [
    ['provision', 'x', '--plan', 'p'],
    ['provision', 'x', '--plan', 'p', '--as', 'a.md', '--dir', 'd', '--branch', 'b', '--include', 'i', '--install', '--resume'],
    ['list'],
    ['land', 'x', '--prepare'],
    ['cleanup', 'x', '--branch', 'b', '--abandon'],
  ];
  for (const argv of accepted) {
    it(`accepts: ${argv.join(' ')}`, () => {
      const parsed = parseArgs(argv);
      assert.equal(parsed.sub, argv[0]);
    });
  }
});

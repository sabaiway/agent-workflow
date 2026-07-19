// worktrees-r3.test.mjs — the R3 convergence-round pins, in a fresh colocated file:
// worktrees.test.mjs and worktrees-hardening.test.mjs are both red-proof-frozen.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, lstatSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, runCli, rebaseAbsolutePins, copyTreeIfMissing, WORKTREES_STOP, handoffBasename } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-r3-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

// A repo whose ignores live in a TRACKED .gitignore with DIRECTORY-form patterns — the shape
// the dir-probe fixes exist for. The plan source sits at the repo ROOT (docs/plans may be absent).
const makeGitignoreRepo = (name, { plansDirOnDisk = false, extraIgnores = [] } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(
    join(main, '.gitignore'),
    ['docs/plans/', 'docs/ai/', '.claude/', 'AGENTS.md', 'CLAUDE.md', 'node_modules', ...extraIgnores, ''].join('\n'),
  );
  writeFileSync(join(main, 'SEED-PROMPT-x.md'), '# body\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  if (plansDirOnDisk) mkdirSync(join(main, 'docs/plans'), { recursive: true });
  return main;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

describe('worktrees r3 — directory probes carry the trailing slash (agy R3-B1)', () => {
  it('a tracked dir-form docs/plans/ ignore with NO docs/plans dir on disk provisions cleanly', () => {
    const repo = makeGitignoreRepo('r3-noplans');
    const r = run(['provision', 'npd', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-npd.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    const wt = join(dirname(repo), `${basename(repo)}--npd`);
    assert.ok(existsSync(join(wt, 'docs/plans/feature-npd.md')));
    assert.ok(existsSync(join(wt, 'docs/plans', handoffBasename('npd'))));
    assert.equal(sh(['status', '--porcelain'], wt).trim(), '');
  });
  it('a directory --include ignored via the dir-form pattern passes the destination probe', () => {
    const repo = makeGitignoreRepo('r3-incdir', { extraIgnores: ['extras/'] });
    mkdirSync(join(repo, 'extras'));
    writeFileSync(join(repo, 'extras/data.txt'), 'x\n');
    const r = run(['provision', 'inc', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-inc.md', '--include', 'extras'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    const wt = join(dirname(repo), `${basename(repo)}--inc`);
    assert.equal(readFileSync(join(wt, 'extras/data.txt'), 'utf8'), 'x\n');
  });
  it('an ABSENT in-repo --dir target ignored via the dir-form pattern passes the target probe', () => {
    const repo = makeGitignoreRepo('r3-target', { extraIgnores: ['wtfarm/'] });
    const r = run(['provision', 'tgt', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-tgt.md', '--dir', join(repo, 'wtfarm')], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.ok(existsSync(join(repo, 'wtfarm/docs/plans/feature-tgt.md')));
  });
});

describe('worktrees r3 — the symlink branch creates its parent, guarded (agy R3-B2)', () => {
  it('a nested registry symlink with no pre-created parent provisions cleanly (mirrored as a link)', () => {
    const repo = makeGitignoreRepo('r3-lnkparent');
    mkdirSync(join(repo, '.claude'));
    symlinkSync('settings.json', join(repo, '.claude/settings.local.json'));
    writeFileSync(join(repo, '.claude/settings.json'), '{}\n');
    const r = run(['provision', 'lkp', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-lkp.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    const wt = join(dirname(repo), `${basename(repo)}--lkp`);
    assert.ok(lstatSync(join(wt, '.claude/settings.local.json')).isSymbolicLink());
    assert.equal(sh(['status', '--porcelain'], wt).trim(), '');
  });
  it('a parent swapped to a symlink AFTER its mkdir STOPs before the link lands (guard order pinned)', () => {
    const repo = makeGitignoreRepo('r3-lnkswap');
    mkdirSync(join(repo, '.claude'));
    symlinkSync('settings.json', join(repo, '.claude/settings.local.json'));
    writeFileSync(join(repo, '.claude/settings.json'), '{}\n');
    const wt = join(dirname(repo), `${basename(repo)}--lks`);
    let armed = false;
    const fakeSymlink = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, mode: 0 };
    const links = [];
    const r = run(['provision', 'lks', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-lks.md'], {
      cwd: repo,
      deps: {
        lstat: (p) => (armed && p === join(wt, '.claude') ? fakeSymlink : lstatSync(p)),
        mkdir: (p) => {
          mkdirSync(p, { recursive: true });
          if (p === join(wt, '.claude')) armed = true;
        },
        symlink: (target, dst) => links.push(dst),
      },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /symlink/);
    assert.ok(!links.some((d) => d.startsWith(join(wt, '.claude'))), `no link may land after the swap: ${links}`);
  });
});

describe('worktrees r3 — symlink targets are canonicalized through existing ancestors (codex R3-M1)', () => {
  it('copyNode: a dangling target routed through an escaping ancestor symlink STOPs', () => {
    const src = join(TMP, 'r3-canon-src');
    const wt = join(TMP, 'r3-canon-wt');
    const outside = join(TMP, 'r3-canon-outside');
    mkdirSync(src, { recursive: true });
    mkdirSync(wt, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(wt, 'sub'));
    symlinkSync('sub/deeper/thing', join(src, 'lnk'));
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: join(src, 'lnk'), dstAbs: join(wt, 'lnk'), wtRoot: wt, rel: 'lnk' }),
      (e) => e.code === WORKTREES_STOP && /escap|unresolvable/.test(e.message),
    );
    assert.ok(!existsSync(join(wt, 'lnk')), 'the link must not land');
  });
  it('the sweep: a dangling registry symlink routed through an escaping ancestor STOPs pre-add', () => {
    const repo = makeGitignoreRepo('r3-sweep-canon');
    const outsideMissing = join(TMP, 'r3-sweep-gone');
    rmSync(join(repo, 'AGENTS.md'));
    symlinkSync(outsideMissing, join(repo, 'gone-dir'));
    symlinkSync('gone-dir/x', join(repo, 'AGENTS.md'));
    const before = sh(['worktree', 'list', '--porcelain'], repo);
    const r = run(['provision', 'swc', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /escapes the main repo|unresolvable/);
    assert.equal(sh(['worktree', 'list', '--porcelain'], repo), before, 'no git mutation');
  });
});

describe('worktrees r3 — the node_modules symlink is a guarded mutation (codex R3-M2)', () => {
  it('a wt root swapped to a symlink before the link STOPs with zero symlink calls', () => {
    const repo = makeGitignoreRepo('r3-nmguard');
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules/marker.txt'), 'nm\n');
    const wt = join(dirname(repo), `${basename(repo)}--nmg`);
    let armed = false;
    const fakeSymlink = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, mode: 0 };
    const links = [];
    const r = run(['provision', 'nmg', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-nmg.md'], {
      cwd: repo,
      deps: {
        lstat: (p) => {
          if (p === join(wt, 'node_modules')) {
            armed = true;
            return lstatSync(p);
          }
          return armed && p === wt ? fakeSymlink : lstatSync(p);
        },
        symlink: (target, dst) => links.push(dst),
      },
    });
    assert.equal(r.code, EXIT.stop, r.errText);
    assert.match(r.errText, /symlink/);
    assert.ok(!links.includes(join(wt, 'node_modules')), 'the node_modules link must never land after the swap');
  });
});

describe('worktrees r3 — JSON-escaped backslash pins rebase with their encoding (codex R3-M3)', () => {
  it('a JSON.stringify-shaped Windows pin rebases preserving the doubled encoding, counted', () => {
    const text = JSON.stringify({ cmd: 'node C:\\u\\main\\tools\\c.mjs --check' });
    const { text: out, changes } = rebaseAbsolutePins(text, 'C:/u/main', 'C:/u/main--x');
    assert.equal(out, JSON.stringify({ cmd: 'node C:\\u\\main--x\\tools\\c.mjs --check' }));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].count, 1);
  });
  it('the runtime single-backslash and forward-slash forms keep their existing behavior', () => {
    assert.equal(rebaseAbsolutePins('node "C:\\u\\main\\t.mjs"', 'C:/u/main', 'C:/u/main--x').text, 'node "C:\\u\\main--x\\t.mjs"');
    assert.equal(rebaseAbsolutePins('/a/main/x', '/a/main', '/a/main--w').text, '/a/main--w/x');
  });
});

describe('worktrees r3 — list read errors render honestly (codex R3-m4)', () => {
  it('a readdir failure renders handoff: (unreadable), never handoff: no', () => {
    const repo = makeGitignoreRepo('r3-listerr', { plansDirOnDisk: true });
    writeFileSync(join(repo, 'docs/plans/SEED2-PROMPT.md'), '# p\n');
    const r1 = run(['provision', 'ler', '--plan', 'SEED-PROMPT-x.md', '--as', 'feature-ler.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const wt = join(dirname(repo), `${basename(repo)}--ler`);
    const r2 = run(['list'], {
      cwd: repo,
      deps: {
        readdir: (p, opts) => {
          if (String(p).startsWith(join(wt, 'docs/plans'))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          throw Object.assign(new Error('unexpected readdir'), { code: 'EINVAL' });
        },
      },
    });
    assert.equal(r2.code, EXIT.ok);
    assert.match(r2.text, /handoff: \(unreadable\)/);
    assert.doesNotMatch(r2.text, /handoff: no/);
  });
});

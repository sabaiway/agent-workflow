// worktrees-hardening.test.mjs — the R2 hardening pins, colocated SEPARATELY because
// worktrees.test.mjs is red-proof-frozen (the *-honesty.test.mjs lane the bridge specs use).
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, lstatSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, WORKTREES_STOP, runCli, rebaseAbsolutePins, handoffBasename } from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-hard-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', '/.vscode/', ''];

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

const fakeSymlinkStat = {
  isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false, mode: 0,
};

// A resume run whose injected lstat flags ONE directory as a symlink and whose injected mkdir
// records every call: the guard must STOP with ZERO mkdir calls at (or under) the flagged dir.
const resumeWithFlaggedDir = (repo, slug, flagged) => {
  const mkdirCalls = [];
  const r = run(['provision', slug, '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`], {
    cwd: repo,
    deps: {
      lstat: (p) => (p === flagged ? fakeSymlinkStat : lstatSync(p)),
      mkdir: (p) => {
        mkdirCalls.push(p);
        mkdirSync(p, { recursive: true });
      },
    },
  });
  return { r, mkdirCalls };
};

describe('worktrees hardening — every destination mkdir is guarded BEFORE the call (R2-B1)', () => {
  it('the HANDOFF mkdir site: a symlink-flagged docs/plans dir STOPs with zero mkdir calls there', () => {
    const repo = makeRepo('hb-handoff');
    const wt = provisionOk(repo, 'hb1');
    rmSync(join(wt, 'docs/plans', handoffBasename('hb1')));
    const { r, mkdirCalls } = resumeWithFlaggedDir(repo, 'hb1', join(wt, 'docs/plans'));
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /symlink/);
    assert.ok(!mkdirCalls.some((p) => p.startsWith(join(wt, 'docs/plans'))), `no mkdir may touch the flagged dir: ${mkdirCalls}`);
  });
  it('the SEED-PLAN mkdir site: with the handoff present, the seed write STOPs the same way', () => {
    const repo = makeRepo('hb-seed');
    const wt = provisionOk(repo, 'hb2');
    rmSync(join(wt, 'docs/plans/feature-hb2.md'));
    const { r, mkdirCalls } = resumeWithFlaggedDir(repo, 'hb2', join(wt, 'docs/plans'));
    assert.equal(r.code, EXIT.stop);
    assert.ok(!mkdirCalls.some((p) => p.startsWith(join(wt, 'docs/plans'))));
  });
  it('the VSCODE mkdir site: a symlink-flagged .vscode dir STOPs with zero mkdir calls there', () => {
    const repo = makeRepo('hb-vscode');
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode/settings.json'), '{}');
    const wt = provisionOk(repo, 'hb3');
    rmSync(join(wt, '.vscode'), { recursive: true, force: true });
    const { r, mkdirCalls } = resumeWithFlaggedDir(repo, 'hb3', join(wt, '.vscode'));
    assert.equal(r.code, EXIT.stop);
    assert.ok(!mkdirCalls.some((p) => p.startsWith(join(wt, '.vscode'))));
  });
  it('the copyNode file branch guards mkdir and copyFile separately (a swap between them STOPs the copy)', () => {
    const repo = makeRepo('hb-copy');
    const wt = provisionOk(repo, 'hb4');
    rmSync(join(wt, 'AGENTS.md'));
    let armed = false;
    const copyCalls = [];
    const r = run(['provision', 'hb4', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-hb4.md'], {
      cwd: repo,
      deps: {
        lstat: (p) => (armed && p === wt ? fakeSymlinkStat : lstatSync(p)),
        mkdir: (p) => {
          if (p === dirname(join(wt, 'AGENTS.md'))) armed = true;
          mkdirSync(p, { recursive: true });
        },
        copyFile: (a, b) => copyCalls.push([a, b]),
      },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /symlink/);
    assert.deepEqual(copyCalls, [], 'the copy must never run after the post-mkdir swap');
  });
});

describe('worktrees hardening — .vscode/settings.json is copy-if-missing on resume (R2-B2)', () => {
  it('preserves a user-edited .vscode/settings.json byte-exact and reports kept', () => {
    const repo = makeRepo('hb-vskeep');
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode/settings.json'), '{"editor.tabSize": 2}');
    const wt = provisionOk(repo, 'vsk');
    const userBytes = '{"window.title": "my own title", "user": true}\n';
    writeFileSync(join(wt, '.vscode/settings.json'), userBytes);
    const r = run(['provision', 'vsk', '--resume', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-vsk.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(readFileSync(join(wt, '.vscode/settings.json'), 'utf8'), userBytes);
    assert.match(r.text, /\.vscode: kept \(already present\)/);
  });
});

describe('worktrees hardening — the pre-add sweep is fail-closed on unresolvable sources (R2-M3)', () => {
  it('a dangling ESCAPING symlink root is a pre-add STOP (lexical), no worktree is created', () => {
    const repo = makeRepo('hb-dangle-esc');
    rmSync(join(repo, 'AGENTS.md'));
    symlinkSync('../../outside-missing-target', join(repo, 'AGENTS.md'));
    const before = sh(['worktree', 'list', '--porcelain'], repo);
    const r = run(['provision', 'dgl', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /escapes the main repo/);
    assert.equal(sh(['worktree', 'list', '--porcelain'], repo), before, 'no git mutation');
  });
  it('an inside-root DANGLING symlink is accepted (the copy stage mirrors it as a link)', () => {
    const repo = makeRepo('hb-dangle-in');
    symlinkSync('AGENTS-missing.md', join(repo, 'CLAUDE.md'));
    const wt = provisionOk(repo, 'dgi');
    assert.ok(lstatSync(join(wt, 'CLAUDE.md')).isSymbolicLink());
  });
  it('a non-symlink source whose realpath fails is a typed STOP naming it (never a silent skip)', () => {
    const repo = makeRepo('hb-real-err');
    const r = run(['provision', 'rerr', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], {
      cwd: repo,
      deps: {
        realpath: (p) => {
          if (p === join(repo, 'AGENTS.md')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return realpathSync(p);
        },
      },
    });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /unresolvable \(EACCES\)/);
    assert.match(r.errText, /AGENTS\.md/);
  });
  it('a RESOLVABLE multi-hop escape is still caught by realpath validation', () => {
    const repo = makeRepo('hb-hop');
    const outside = join(TMP, 'hb-hop-outside');
    mkdirSync(outside, { recursive: true });
    const hop = join(TMP, 'hb-hop-mid');
    symlinkSync(outside, hop);
    rmSync(join(repo, '.claude'), { recursive: true, force: true });
    mkdirSync(join(repo, '.claude'), { recursive: true });
    mkdirSync(join(repo, '.claude/skills'), { recursive: true });
    rmSync(join(repo, '.claude/skills'), { recursive: true, force: true });
    symlinkSync(hop, join(repo, '.claude/skills'));
    const r = run(['provision', 'hop', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /escapes the main repo/);
  });
});

describe('worktrees hardening — the rebase report leaks no line content (R2-M4)', () => {
  it('a secret-bearing multi-pin line reports target:line + replacement count only', () => {
    const repo = makeRepo('hb-secret');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(
      join(repo, '.claude/settings.local.json'),
      `{"cmd":"${repo}/tool-a SECRET_TOKEN_XYZ ${repo}/tool-b"}\n`,
    );
    const wt = join(dirname(repo), `${basename(repo)}--sec`);
    const r = run(['provision', 'sec', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-sec.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /rebased \.claude\/settings\.local\.json:1 \(2 replacements?\)/);
    assert.ok(!r.text.includes('SECRET_TOKEN_XYZ'), 'no line content may reach the report');
    const rebased = readFileSync(join(wt, '.claude/settings.local.json'), 'utf8');
    assert.ok(rebased.includes(`${wt}/tool-a`) && rebased.includes(`${wt}/tool-b`), 'both pins rebased');
  });
  it('rebaseAbsolutePins reports a per-line replacement count', () => {
    const { changes } = rebaseAbsolutePins('/a/main/x and /a/main/y\nplain\n/a/main/z\n', '/a/main', '/a/main--w');
    assert.deepEqual(changes.map((c) => ({ line: c.line, count: c.count })), [{ line: 1, count: 2 }, { line: 3, count: 1 }]);
  });
});

describe('worktrees hardening — honest fallback scoping (R2-m7)', () => {
  it('the repo-relative fallback line is scoped to the target repo root with a visible kit checkout', () => {
    const repo = makeRepo('hb-scope');
    const out = [];
    const err = [];
    const code = runCli(['provision', 'scp', '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', 'feature-x.md'], {
      cwd: repo,
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
      mkdirPlain: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); },
    });
    assert.equal(code, EXIT.stop);
    assert.match(err.join('\n'), /from the target repo root, when that checkout carries the kit at agent-workflow-kit\//);
  });
});

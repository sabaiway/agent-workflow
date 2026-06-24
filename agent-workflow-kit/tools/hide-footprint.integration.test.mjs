// Integration acceptance for hide-footprint against a REAL `git` — what injected-git mocks cannot
// prove: real `git rev-parse --git-path info/exclude` (incl. a linked worktree), real precedence
// (tracked .gitignore > .git/info/exclude > global core.excludesFile), and the delegated-memory
// hand-off (fresh + stale). Every test ISOLATES the git environment (per-test HOME + GIT_CONFIG_GLOBAL
// + GIT_CONFIG_NOSYSTEM) so the host's real ~/.gitignore_global — which already hides /AGENTS.md,
// /docs/ai/ — cannot make a real check-ignore pass/fail for host-state reasons (Review fold R2 codex#8).

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hideFootprint, excludePath, START_MARKER } from './hide-footprint.mjs';

let gitOk = true;
before(() => {
  try { execFileSync('git', ['--version'], { encoding: 'utf8' }); } catch { gitOk = false; }
});

const made = [];
const mkdtemp = (tag) => { const d = mkdtempSync(join(tmpdir(), tag)); made.push(d); return d; };
afterEach(() => { while (made.length) { try { rmSync(made.pop(), { recursive: true, force: true }); } catch { /* best effort */ } } });

// An isolated repo: empty global config (no host excludesFile), committer identity in env.
const setup = () => {
  const home = mkdtemp('aw-home-');
  const dir = mkdtemp('aw-repo-');
  const gcfg = join(home, '.gitconfig');
  writeFileSync(gcfg, '');
  const env = {
    ...process.env, HOME: home, GIT_CONFIG_GLOBAL: gcfg, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  };
  const git = (args, cwd = dir) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  return { home, dir, gcfg, env, git, deps: { env, home } };
};
const readExclude = (dir) => { const p = join(dir, '.git/info/exclude'); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
const count = (s, sub) => s.split(sub).length - 1;
const checkIgnoreSource = (git, dir, probe) => {
  try { return git(['check-ignore', '-v', '--', probe], dir).split('\t')[0]; } catch { return null; }
};

describe('hide-footprint integration (real git)', { skip: !gitOk }, () => {
  let env;
  beforeEach(() => { env = setup(); });

  it('resolves info/exclude, writes ONE managed block, and real check-ignore reports it', () => {
    const { dir, git, deps } = env;
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const ep = excludePath(deps, dir);
    assert.ok(ep.endsWith('.git/info/exclude'));
    const r = hideFootprint({ dir }, deps);
    assert.equal(r.action, 'created');
    const content = readExclude(dir);
    assert.equal(count(content, START_MARKER), 1, 'exactly one managed block');
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/);
    // Idempotent: a second run changes nothing.
    const r2 = hideFootprint({ dir }, deps);
    assert.equal(r2.action, 'noop');
    assert.equal(readExclude(dir), content);
  });

  it('works inside a linked git worktree', () => {
    const { dir, git, deps, env: e } = env;
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = mkdtemp('aw-wt-');
    rmSync(wt, { recursive: true, force: true }); // git worktree add wants a non-existent path
    git(['worktree', 'add', '-q', wt]);
    writeFileSync(join(wt, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir: wt }, deps);
    assert.equal(r.visibility, 'hidden');
    assert.equal(count(r.wrote.join('\n'), '/AGENTS.md'), 1);
    assert.match(checkIgnoreSource((a, c) => execFileSync('git', a, { cwd: c, env: e, encoding: 'utf8' }), wt, 'AGENTS.md') ?? '', /exclude/);
  });

  it('precedence: a path in a TRACKED .gitignore is dropped (redundant), reported by .gitignore', () => {
    const { dir, git, deps } = env;
    writeFileSync(join(dir, '.gitignore'), '/docs/ai/\n');
    git(['add', '.gitignore']);
    const r = hideFootprint({ dir }, deps);
    assert.ok(r.dropped.includes('/docs/ai/'), 'covered by tracked .gitignore → dropped');
    assert.ok(!r.wrote.includes('/docs/ai/'));
    assert.match(checkIgnoreSource(git, dir, 'docs/ai/') ?? '', /\.gitignore/);
  });

  it('precedence: a path in BOTH global excludes and the local block is reported by the LOCAL block', () => {
    const { dir, git, deps } = env;
    const globalExcludes = join(env.home, 'gitignore_global');
    writeFileSync(globalExcludes, '/AGENTS.md\n');
    git(['config', 'core.excludesFile', globalExcludes]);
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir }, deps); // default keeps the global block
    assert.ok(r.wrote.includes('/AGENTS.md'));
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/, 'local exclude wins precedence');
    assert.equal(r.global.action, 'kept');
  });

  it('a machine-global core.excludesFile NAMED .gitignore is not mistaken for a project .gitignore (no spurious STOP)', () => {
    const { dir, git, deps } = env;
    const globalGitignore = join(env.home, '.gitignore'); // basename collides with a project .gitignore
    writeFileSync(globalGitignore, '/AGENTS.md\n');
    git(['config', 'core.excludesFile', globalGitignore]);
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir }, deps); // must not STOP probing an outside-repo path
    assert.ok(r.wrote.includes('/AGENTS.md'), 'AGENTS.md hidden project-local, not dropped as a "tracked .gitignore"');
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/);
  });

  it('delegated-hidden, FRESH memory: bare project-local lines are absorbed into ONE canonical fence', () => {
    const { dir, deps } = env;
    // What a 1.1.0 memory writes project-local (bare, no fence):
    writeFileSync(join(dir, '.git/info/exclude'), '/AGENTS.md\n/CLAUDE.md\n/docs/ai/\n');
    const r = hideFootprint({ dir }, deps);
    const content = readExclude(dir);
    assert.equal(count(content, START_MARKER), 1, 'one fence');
    assert.equal(count(content, '/AGENTS.md\n'), 1, 'no duplicate AGENTS.md rule');
    // the bare lines are now INSIDE the fence, not loose above it.
    assert.ok(content.indexOf('/AGENTS.md') > content.indexOf(START_MARKER));
    assert.ok(r.wrote.includes('/AGENTS.md') && r.wrote.includes('/docs/ai/'));
  });

  it('delegated-hidden, STALE memory: a memory-old GLOBAL block is migrated away with --remove-global', () => {
    const { dir, git, deps } = env;
    const globalExcludes = join(env.home, 'gitignore_global');
    writeFileSync(globalExcludes, '# agent-workflow-kit hidden mode (machine-local; remove these lines to un-hide)\n/AGENTS.md\n/docs/ai/\n/docs/ai/.memory-version\n');
    git(['config', 'core.excludesFile', globalExcludes]);
    writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
    const r = hideFootprint({ dir, removeGlobal: true }, deps);
    assert.equal(r.global.action, 'removed');
    assert.ok(!readFileSync(globalExcludes, 'utf8').includes('/AGENTS.md'), 'global block removed');
    assert.match(checkIgnoreSource(git, dir, 'AGENTS.md') ?? '', /info\/exclude/, 'now hidden project-local');
  });

  describe('visibility inference (D16)', () => {
    it('tracked anchor → VISIBLE → --reconcile writes zero bytes', () => {
      const { dir, git, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      git(['add', 'AGENTS.md']);
      const before = readExclude(dir);
      const r = hideFootprint({ dir, reconcile: true }, deps);
      assert.equal(r.visibility, 'visible');
      assert.equal(readExclude(dir), before, 'no bytes written in visible mode');
    });

    it('untracked + ignored anchor → HIDDEN → --reconcile runs the hide', () => {
      const { dir, git, deps } = env;
      const globalExcludes = join(env.home, 'gitignore_global');
      writeFileSync(globalExcludes, '/AGENTS.md\n');
      git(['config', 'core.excludesFile', globalExcludes]);
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const r = hideFootprint({ dir, reconcile: true }, deps);
      assert.equal(r.visibility, 'hidden');
      assert.ok(r.wrote.includes('/AGENTS.md'));
    });

    it('untracked + not ignored anchor → AMBIGUOUS → --reconcile surfaces it, writes nothing', () => {
      const { dir, deps } = env;
      writeFileSync(join(dir, 'AGENTS.md'), '# entry\n');
      const before = readExclude(dir);
      const r = hideFootprint({ dir, reconcile: true }, deps);
      assert.equal(r.ambiguous, true);
      assert.equal(r.visibility, 'ambiguous');
      assert.equal(readExclude(dir), before, 'ambiguous → no write, agent ASKs');
    });
  });
});

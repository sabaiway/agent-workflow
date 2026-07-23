// worktrees-posture-integration.test.mjs — the live-posture contract against REAL git. The proof
// reads the WORKTREE'S OWN LIVE checkout, so a satellite session that COMMITS a manifest change
// and re-runs `--resume` gets a refreshed posture that follows its committed state, in both
// directions — never MAIN's manifests. (An uncommitted tracked edit refuses the resume at the
// shipped clean-tree verify; the committed lane is the real-git path where the refresh completes.)

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, runCli, parseProvisionRecord, handoffBasename } from './worktrees.mjs';
// Authored WITH the fixtures below: imported dynamically so this spec LOADS against the pre-fix
// tree and each fixture fails on its OWN assertion (the red-first doctrine).
const { NO_DEPENDENCIES_POSTURE } = await import('./worktrees.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-posture-int-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''];

const makeRepo = (name, pkg) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify(pkg));
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

const run = (argv, cwd) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out, errText: err.join('\n') };
};

const provisionArgs = (slug, extra = []) =>
  ['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`, ...extra];

const readRecord = (repo, slug) => {
  const worktree = join(dirname(repo), `${basename(repo)}--${slug}`);
  return { worktree, record: parseProvisionRecord(readFileSync(join(worktree, 'docs/plans', handoffBasename(slug)), 'utf8')) };
};

const commitManifest = (worktree, pkg) => {
  writeFileSync(join(worktree, 'package.json'), JSON.stringify(pkg));
  sh(['add', 'package.json'], worktree);
  sh(['commit', '-q', '-m', 'manifest change'], worktree);
};

describe('the live posture follows the satellite\'s own committed state (real git)', () => {
  it('a committed manifest change SHEDDING dependencies survives resume, and the live posture follows it', () => {
    const repo = makeRepo('int-shed', { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } });
    const first = run(provisionArgs('shed'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    const { worktree, record } = readRecord(repo, 'shed');
    assert.notEqual(record.install, NO_DEPENDENCIES_POSTURE, 'declared deps → the advice, at provision time');
    commitManifest(worktree, { name: 'r', version: '1.0.0' });
    const resumed = run(provisionArgs('shed', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.equal(readRecord(repo, 'shed').record.install, NO_DEPENDENCIES_POSTURE, 'the refreshed posture reads the live checkout, not MAIN');
  });

  it('a committed manifest change GAINING dependencies survives resume, and the live posture follows it', () => {
    const repo = makeRepo('int-gain', { name: 'r', version: '1.0.0' });
    const first = run(provisionArgs('gain'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    const { worktree, record } = readRecord(repo, 'gain');
    assert.equal(record.install, NO_DEPENDENCIES_POSTURE, 'dependency-free → the posture, at provision time');
    commitManifest(worktree, { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } });
    const resumed = run(provisionArgs('gain', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.notEqual(readRecord(repo, 'gain').record.install, NO_DEPENDENCIES_POSTURE, 'the refreshed posture reads the live checkout, not MAIN');
  });

  // The manifest carries a real dependency: a dependency-free checkout would short-circuit to
  // the no-install posture and manager selection would never be exercised.
  it('a satellite behind an advanced MAIN reads the SATELLITE checkout', () => {
    const repo = makeRepo('int-advance', { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } });
    writeFileSync(join(repo, 'yarn.lock'), 'fixture\n');
    sh(['add', 'yarn.lock'], repo);
    sh(['commit', '-q', '-m', 'lock'], repo);
    const first = run(provisionArgs('advance'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    sh(['rm', '-q', 'yarn.lock'], repo);
    writeFileSync(join(repo, 'pnpm-lock.yaml'), 'fixture\n');
    sh(['add', '-A'], repo);
    sh(['commit', '-q', '-m', 'advance the lockfile on MAIN'], repo);
    const resumed = run(provisionArgs('advance', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    const { record } = readRecord(repo, 'advance');
    assert.match(record.install, /yarn install/, 'the refreshed advice reads the satellite checkout, not the advanced MAIN');
  });

  it('an uncommitted worktree manifest edit refuses --resume at the shipped clean-tree STOP', () => {
    const repo = makeRepo('int-dirty-stop', { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } });
    const first = run(provisionArgs('dirtystop'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    const { worktree } = readRecord(repo, 'dirtystop');
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
    const resumed = run(provisionArgs('dirtystop', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop, 'a dirty satellite tree refuses the resume');
    assert.equal(
      resumed.errText,
      '[worktrees] [agent-workflow-kit] post-provision verify failed — the worktree status is not clean (everything provision places must be ignored-or-tracked):\n M package.json',
      'the shipped clean-tree STOP, byte-exact — the advice-source flip must not smuggle resume tolerance',
    );
  });
});

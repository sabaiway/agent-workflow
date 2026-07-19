import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, readFileSync,
  fchmodSync, lstatSync, existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXIT, WORKTREES_STOP, CONFIG_REL, SLUG_RE, validateSlug, loadWorktreesConfig, resolveTargetDir,
  realpathThroughExistingParent, nearestExistingDir, resolveProbeDir, parseWorktreeList,
  probeParentWritable, provisionCopySet, copyTreeIfMissing, rebaseAbsolutePins,
  composeHandoffStub, parseProvisionRecord, composeProvisionArgv, parseArgs, runCli,
  handoffBasename, spawnGit,
} from './worktrees.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-worktrees-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const HIDDEN_EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', '/extra-secret.txt', '/.vscode/', ''];

// One shared main-repo fixture per test file (built once); per-scenario repos only where a test
// mutates repo-level state (visible mode, missing excludes, node_modules arms).
const makeRepo = (name, { excludes = HIDDEN_EXCLUDES, footprint = true, nodeModules = 'dir' } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  mkdirSync(join(main, 'agent-workflow-kit', 'tools'), { recursive: true });
  writeFileSync(join(main, 'agent-workflow-kit/tools/review-state.mjs'), 'export {};\n');
  writeFileSync(join(main, 'agent-workflow-kit/tools/coverage-check.mjs'), 'export {};\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), excludes.join('\n'));
  if (footprint) {
    writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
    symlinkSync('AGENTS.md', join(main, 'CLAUDE.md'));
    mkdirSync(join(main, 'docs/ai'), { recursive: true });
    writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({
      gates: [
        { id: 'review-state', title: 't', cmd: `node "${main}/agent-workflow-kit/tools/review-state.mjs" --check` },
        { id: 'coverage-check', title: 't', cmd: `node "${main}/agent-workflow-kit/tools/coverage-check.mjs" --check` },
      ],
    }, null, 2));
    writeFileSync(join(main, 'docs/ai/agent-workflow-review-receipts.jsonl'), '{"fixture":1}\n');
    mkdirSync(join(main, 'docs/plans'), { recursive: true });
    writeFileSync(join(main, 'docs/plans/queue.md'), 'index\n');
    writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# plan body\n');
    mkdirSync(join(main, '.claude/skills'), { recursive: true });
    writeFileSync(join(main, '.claude/skills/dummy.md'), 'skill\n');
    writeFileSync(join(main, '.claude/skills/run.sh'), '#!/bin/sh\n');
    chmodSync(join(main, '.claude/skills/run.sh'), 0o755);
    writeFileSync(join(main, '.claude/settings.json'), JSON.stringify({ note: `${main}/agent-workflow-kit` }, null, 2));
    writeFileSync(join(main, 'extra-secret.txt'), 'secret\n');
    if (nodeModules === 'dir') {
      mkdirSync(join(main, 'node_modules'));
      writeFileSync(join(main, 'node_modules/marker.txt'), 'nm\n');
    } else if (nodeModules === 'outside') {
      const outside = join(TMP, `${name}-nm-outside`);
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(main, 'node_modules'));
    }
  }
  return main;
};

const run = (argv, { cwd, git } = {}) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...(git ? { git } : {}) });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

const recordingGit = (calls, { intercept = null } = {}) => (args, cwd) => {
  calls.push(args.join(' '));
  if (intercept) {
    const hit = intercept(args);
    if (hit) return hit;
  }
  return spawnGit(args, cwd);
};

let MAIN;
before(() => {
  MAIN = makeRepo('main');
});

// ── slug grammar (Decision 2) ──────────────────────────────────────────────────────────

describe('worktrees — slug grammar', () => {
  it('accepts lowercase letters, digits, hyphens, max 64, letter/digit first', () => {
    for (const ok of ['a', 'x1', 'a-b-2', 'a'.repeat(64)]) assert.equal(validateSlug(ok), ok);
  });
  it('refuses uppercase, leading hyphen, underscore, empty, overlong, slash — typed usage STOP', () => {
    for (const bad of ['A', '-a', 'a_b', '', 'a'.repeat(65), 'a/b', 'а-кириллица']) {
      assert.throws(() => validateSlug(bad), (e) => e.code === WORKTREES_STOP && e.exitCode === EXIT.usage);
    }
  });
  it('the regex itself pins the grammar', () => {
    assert.equal(String(SLUG_RE), '/^[a-z0-9][a-z0-9-]{0,63}$/');
  });
});

// ── the parentDir setting (docs/ai/worktrees.json) ─────────────────────────────────────

describe('worktrees — parentDir setting trio', () => {
  it('absent worktrees.json → the computed sibling default <repoParent>/<repoName>--<slug>', () => {
    const config = loadWorktreesConfig(MAIN);
    assert.equal(config.parentDir, null);
    const target = resolveTargetDir({ root: MAIN, slug: 'alpha', dirFlag: null, parentDir: config.parentDir });
    assert.equal(target, join(dirname(MAIN), `${basename(MAIN)}--alpha`));
  });
  it('a set parentDir is honored', () => {
    writeFileSync(join(MAIN, CONFIG_REL), JSON.stringify({ parentDir: join(TMP, 'feature-farm') }));
    try {
      const config = loadWorktreesConfig(MAIN);
      const target = resolveTargetDir({ root: MAIN, slug: 'alpha', dirFlag: null, parentDir: config.parentDir });
      assert.equal(target, join(TMP, 'feature-farm', `${basename(MAIN)}--alpha`));
    } finally {
      rmSync(join(MAIN, CONFIG_REL));
    }
  });
  it('malformed JSON → typed STOP, never a guess', () => {
    writeFileSync(join(MAIN, CONFIG_REL), '{ nope');
    try {
      assert.throws(() => loadWorktreesConfig(MAIN), (e) => e.code === WORKTREES_STOP && /malformed JSON/.test(e.message));
    } finally {
      rmSync(join(MAIN, CONFIG_REL));
    }
  });
  it('an unknown key and a non-string parentDir are typed STOPs', () => {
    writeFileSync(join(MAIN, CONFIG_REL), JSON.stringify({ parentdir: 'x' }));
    try {
      assert.throws(() => loadWorktreesConfig(MAIN), (e) => e.code === WORKTREES_STOP && /unknown key/.test(e.message));
      writeFileSync(join(MAIN, CONFIG_REL), JSON.stringify({ parentDir: 7 }));
      assert.throws(() => loadWorktreesConfig(MAIN), (e) => e.code === WORKTREES_STOP && /non-empty string/.test(e.message));
    } finally {
      rmSync(join(MAIN, CONFIG_REL));
    }
  });
  it('--dir wins over the setting', () => {
    const target = resolveTargetDir({ root: MAIN, slug: 'alpha', dirFlag: join(TMP, 'else', 'here'), parentDir: '/never-used' });
    assert.equal(target, join(TMP, 'else', 'here'));
  });
});

// ── path safety ────────────────────────────────────────────────────────────────────────

describe('worktrees — path safety', () => {
  it('the target resolves through its nearest existing parent realpath (symlink escape caught)', () => {
    const real = join(TMP, 'ps-real');
    mkdirSync(real, { recursive: true });
    const link = join(TMP, 'ps-link');
    symlinkSync(real, link);
    assert.equal(realpathThroughExistingParent(join(link, 'child', 'wt')), join(realpathSync(real), 'child', 'wt'));
  });
  it('paths with spaces survive end-to-end (quoting fixture; missing parents created)', () => {
    const spaced = join(TMP, 'sp ace', 'wt with space');
    const r = run(['provision', 'spc', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-spc.md', '--dir', spaced], { cwd: MAIN });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.equal(sh(['status', '--porcelain'], spaced).trim(), '');
    assert.ok(existsSync(join(spaced, 'docs/plans/feature-spc.md')));
  });
  it('a target inside the main repo and not ignored is a typed STOP', () => {
    const r = run(['provision', 'inside1', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md', '--dir', join(MAIN, 'not-ignored-dir')], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /inside the main repo and not ignored/);
  });
});

// ── porcelain parsing + the writability probe ──────────────────────────────────────────

describe('worktrees — parseWorktreeList / probeParentWritable', () => {
  it('parses main, branch, detached, and prunable porcelain entries', () => {
    const text = [
      'worktree /repo', 'HEAD aaaa', 'branch refs/heads/main', '',
      'worktree /repo--x', 'HEAD bbbb', 'branch refs/heads/aw/x', '',
      'worktree /repo--d', 'HEAD cccc', 'detached', '',
      'worktree /gone', 'HEAD dddd', 'prunable gitdir file points to non-existent location', '',
    ].join('\0');
    const entries = parseWorktreeList(text);
    assert.equal(entries.length, 4);
    assert.deepEqual(entries.map((e) => e.path), ['/repo', '/repo--x', '/repo--d', '/gone']);
    assert.equal(entries[1].branch, 'refs/heads/aw/x');
    assert.equal(entries[2].detached, true);
    assert.equal(entries[3].prunable, true);
  });
  it('probeParentWritable: a real create+delete probe (green on tmp; injected denial honest)', () => {
    assert.deepEqual(probeParentWritable(TMP), { writable: true });
    const denied = probeParentWritable('/anywhere', { mkdirPlain: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } });
    assert.deepEqual(denied, { writable: false, code: 'EROFS' });
  });
  it('a create-OK/delete-FAIL probe is its OWN typed STOP naming the leftover path + code — never writable', () => {
    const out = [];
    const err = [];
    const code = runCli(['provision', 'cfail', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], {
      cwd: MAIN,
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
      rmdir: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
    });
    assert.equal(code, EXIT.stop);
    const text = err.join('\n');
    assert.match(text, /could not clean up its probe dir/);
    assert.match(text, /EBUSY/);
    assert.match(text, /\.aw-write-probe-/, 'the exact leftover path is named');
    assert.doesNotMatch(text, /allowWrite/, 'never the consent STOP');
    assert.ok(!existsSync(join(dirname(MAIN), `${basename(MAIN)}--cfail`)), 'no worktree is created');
  });
  it('resolveProbeDir shares the canonical derivation: realpath-through-existing-parent then nearest-existing', () => {
    const real = join(TMP, 'rpd-real');
    mkdirSync(real, { recursive: true });
    const link = join(TMP, 'rpd-link');
    symlinkSync(real, link);
    assert.equal(resolveProbeDir(join(link, 'absent-a', 'absent-b')), realpathSync(real));
    assert.equal(nearestExistingDir(join(TMP, 'no', 'such', 'dirs')), realpathSync(TMP));
  });
  it('a denied writability probe: STOP text carries the parent dir, the paste-ready consent, the fallback command; git saw NO mutation', () => {
    const calls = [];
    const git = recordingGit(calls);
    const out = [];
    const err = [];
    const code = runCli(['provision', 'denied2', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], {
      cwd: MAIN,
      git,
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
      mkdirPlain: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); },
    });
    assert.equal(code, EXIT.stop);
    const text = err.join('\n');
    assert.match(text, /not writable from this session/);
    assert.match(text, /sandbox\.filesystem\.allowWrite \+= /);
    assert.match(text, /worktrees\.mjs provision denied2/);
    assert.ok(!calls.some((c) => c.startsWith('worktree add')), `no git mutation may precede the probe: ${calls}`);
  });
});

// ── provision: the happy path on a real repo ───────────────────────────────────────────

describe('worktrees — provision (real git)', () => {
  let WT;
  before(() => {
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-alpha.md', '--include', 'extra-secret.txt'], { cwd: MAIN });
    assert.equal(r.code, EXIT.ok, r.errText);
    WT = join(dirname(MAIN), `${basename(MAIN)}--alpha`);
  });

  it('creates the sibling worktree on branch aw/<slug> with the checkout present', () => {
    assert.ok(existsSync(join(WT, 'README.md')));
    assert.match(sh(['branch', '--show-current'], WT), /^aw\/alpha$/m);
  });
  it('writes the handoff stub with the provision record (slug, branch, includes, node_modules, vscode)', () => {
    const text = readFileSync(join(WT, 'docs/plans', handoffBasename('alpha')), 'utf8');
    assert.match(text, /provisioned, nothing done yet/);
    const record = parseProvisionRecord(text);
    assert.equal(record.slug, 'alpha');
    assert.equal(record.branch, 'aw/alpha');
    assert.deepEqual(record.includes, ['extra-secret.txt']);
    assert.equal(record.nodeModules, 'symlinked');
  });
  it('copies the hidden footprint copy-if-missing (dirs and files; tracked files ride the checkout)', () => {
    assert.equal(readFileSync(join(WT, 'AGENTS.md'), 'utf8'), '# agents\n');
    assert.ok(lstatSync(join(WT, 'CLAUDE.md')).isSymbolicLink(), 'a relative symlink is copied as a symlink');
    assert.ok(existsSync(join(WT, '.claude/skills/dummy.md')));
  });
  it('preserves the executable mode on copied files', () => {
    assert.ok((lstatSync(join(WT, '.claude/skills/run.sh')).mode & 0o111) !== 0);
  });
  it('excludes session stores/sidecars from the copy', () => {
    assert.ok(!existsSync(join(WT, 'docs/ai/agent-workflow-review-receipts.jsonl')));
  });
  it('seeds EXACTLY the one feature plan under the bare name', () => {
    assert.equal(readFileSync(join(WT, 'docs/plans/feature-alpha.md'), 'utf8'), '# plan body\n');
    assert.ok(!existsSync(join(WT, 'docs/plans/SEED-PROMPT-feature.md')));
    assert.ok(!existsSync(join(WT, 'docs/plans/queue.md')), 'main docs/plans content is never copied wholesale');
  });
  it('copies --include extras only into ignored destinations', () => {
    assert.equal(readFileSync(join(WT, 'extra-secret.txt'), 'utf8'), 'secret\n');
  });
  it('symlinks node_modules to the main read-only cache', () => {
    assert.ok(lstatSync(join(WT, 'node_modules')).isSymbolicLink());
    assert.equal(realpathSync(join(WT, 'node_modules')), realpathSync(join(MAIN, 'node_modules')));
  });
  it('rebases the absolute main-root pins in the COPIED gates.json and settings.json', () => {
    const gates = readFileSync(join(WT, 'docs/ai/gates.json'), 'utf8');
    assert.ok(!gates.includes(`${MAIN}/agent-workflow-kit`), 'the main pin must be gone');
    assert.ok(gates.includes(`${WT}/agent-workflow-kit`), 'the worktree pin must be present');
    assert.ok(readFileSync(join(WT, '.claude/settings.json'), 'utf8').includes(WT));
  });
  it('leaves the worktree porcelain-clean (everything placed is ignored-or-tracked)', () => {
    assert.equal(sh(['status', '--porcelain'], WT).trim(), '');
  });
  it('list derives the slug from the handoff, shows branch/base/clean, and marks a foreign worktree honestly', () => {
    const foreign = join(TMP, 'foreign-wt');
    sh(['worktree', 'add', '-q', '--detach', foreign], MAIN);
    try {
      const r = run(['list'], { cwd: MAIN });
      assert.equal(r.code, EXIT.ok);
      assert.match(r.text, /alpha · .*--alpha · branch aw\/alpha · base [0-9a-f]{12} · clean, handoff: yes/);
      assert.match(r.text, /unknown \(foreign\) · .*foreign-wt · branch \(detached\)/);
      assert.match(r.text, /open: code -n /);
    } finally {
      sh(['worktree', 'remove', '--force', foreign], MAIN);
    }
  });
  it('list is read-only: every git call it makes is a read query', () => {
    const calls = [];
    const r = run(['list'], { cwd: MAIN, git: recordingGit(calls) });
    assert.equal(r.code, EXIT.ok);
    for (const c of calls) {
      assert.ok(
        c === 'worktree list --porcelain -z' || c === '--no-optional-locks status --porcelain',
        `unexpected git call: ${c}`,
      );
    }
  });

  // ── reservation refusals (git's OWN refusal surfaced, recoveries named) ──
  it('re-provisioning the same slug is a typed STOP naming the recoveries', () => {
    const r = run(['provision', 'alpha', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-alpha.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /git worktree add refused/);
    assert.match(r.errText, /--resume|cleanup/);
  });
  it('an existing branch under a new slug is the same refusal class', () => {
    const r = run(['provision', 'alpha2', '--branch', 'aw/alpha', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /git worktree add refused/);
  });
  it('an existing non-empty target dir is the same refusal class', () => {
    const busy = join(TMP, 'busy-dir');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'x'), 'x');
    const r = run(['provision', 'alpha3', '--dir', busy, '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /git worktree add refused/);
  });

  // ── run-from-satellite refusal ──
  it('provision refuses a cwd inside a linked worktree, naming the main path', () => {
    const r = run(['provision', 'nested', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: WT });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /MAIN worktree/);
    assert.ok(r.errText.includes(realpathSync(MAIN)) || r.errText.includes(MAIN));
  });

  // ── crash restartability: the handoff stub exists from minute zero ──
  it('a provision that dies mid-copy leaves the handoff stub (list/cleanup have an artifact from minute zero)', () => {
    let armed = false;
    const out = [];
    const err = [];
    const code = runCli(['provision', 'crash', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-crash.md'], {
      cwd: MAIN,
      log: (l) => out.push(l),
      logError: (l) => err.push(l),
      write: () => {
        armed = true;
        throw Object.assign(new Error('boom'), { code: 'EIO' });
      },
    });
    assert.equal(code, EXIT.stop);
    assert.ok(armed);
    const crashWt = join(dirname(MAIN), `${basename(MAIN)}--crash`);
    assert.ok(existsSync(join(crashWt, 'docs/plans', handoffBasename('crash'))), 'the stub must exist before copies');
    assert.match(err.join('\n'), /copy failed \(EIO\)/);
    // and --resume completes the half-done provision idempotently
    const resumed = run(['provision', 'crash', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-crash.md'], { cwd: MAIN });
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.match(resumed.text, /resuming provision/);
    assert.equal(sh(['status', '--porcelain'], crashWt).trim(), '');
  });

  // ── --resume identity checks (fail-closed) ──
  it('--resume refuses an unregistered target', () => {
    const r = run(['provision', 'ghost', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /no registered worktree/);
  });
  it('--resume refuses a branch mismatch at the target', () => {
    const r = run(['provision', 'alpha', '--resume', '--branch', 'aw/other', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-alpha.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /identity mismatch/);
  });
  it('--resume refuses a target that does not share this repo git dir', () => {
    // register gamma, then replace its dir with a FOREIGN repo at the same path
    const gammaDir = join(dirname(MAIN), `${basename(MAIN)}--gamma`);
    sh(['worktree', 'add', '-q', '-b', 'aw/gamma', gammaDir], MAIN);
    rmSync(gammaDir, { recursive: true, force: true });
    mkdirSync(gammaDir);
    sh(['init', '-q', '-b', 'main'], gammaDir);
    sh(['config', 'user.email', 'coder-tools@proton.me'], gammaDir);
    sh(['config', 'user.name', 'coder-tool'], gammaDir);
    writeFileSync(join(gammaDir, 'f'), 'x');
    sh(['add', '-A'], gammaDir);
    sh(['commit', '-q', '-m', 'x'], gammaDir);
    sh(['checkout', '-q', '-b', 'aw/gamma'], gammaDir);
    try {
      const r = run(['provision', 'gamma', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: MAIN });
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /does not share this repo/);
    } finally {
      rmSync(gammaDir, { recursive: true, force: true });
      sh(['worktree', 'prune'], MAIN);
      sh(['branch', '-D', 'aw/gamma'], MAIN);
    }
  });

  // ── the exactly-one-plan assert + the porcelain verify ──
  it('a second bare plan in the worktree fails the exactly-one-plan assert on --resume', () => {
    writeFileSync(join(WT, 'docs/plans/second-plan.md'), 'x\n');
    try {
      const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-alpha.md'], { cwd: MAIN });
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /EXACTLY ONE in-flight plan/);
    } finally {
      rmSync(join(WT, 'docs/plans/second-plan.md'));
    }
  });
  it('an untracked-not-ignored leftover fails the post-provision porcelain verify, listed per path', () => {
    writeFileSync(join(WT, 'leftover.txt'), 'x\n');
    try {
      const r = run(['provision', 'alpha', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-alpha.md'], { cwd: MAIN });
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /status is not clean/);
      assert.match(r.errText, /leftover\.txt/);
    } finally {
      rmSync(join(WT, 'leftover.txt'));
    }
  });
});

// ── the R1 fold set: resume preservation · source containment · collision preflight ────

describe('worktrees — resume preserves user work (copy-if-missing everywhere)', () => {
  it('a --resume refreshes only the record while preserving user sections and the seeded plan byte-exact', () => {
    const repo = makeRepo('res-preserve');
    const r1 = run(['provision', 'resp', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-resp.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const wt = join(dirname(repo), `${basename(repo)}--resp`);
    const handoffPath = join(wt, 'docs/plans', handoffBasename('resp'));
    const originalHandoff = readFileSync(handoffPath, 'utf8');
    const recordOffset = originalHandoff.indexOf('## Provision record');
    const userPrefix = originalHandoff.slice(0, recordOffset);
    const userSuffix = '## Progress\n\nreal satellite work notes\n';
    const userHandoff = `${originalHandoff}\n${userSuffix}`;
    writeFileSync(handoffPath, userHandoff);
    const userPlan = '# plan body\n\nuser-refined step\n';
    writeFileSync(join(wt, 'docs/plans/feature-resp.md'), userPlan);
    const r2 = run(['provision', 'resp', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-resp.md'], { cwd: repo });
    assert.equal(r2.code, EXIT.ok, r2.errText);
    const updatedHandoff = readFileSync(handoffPath, 'utf8');
    assert.equal(updatedHandoff.slice(0, updatedHandoff.indexOf('## Provision record')), userPrefix);
    assert.equal(updatedHandoff.slice(updatedHandoff.indexOf('## Progress')), userSuffix);
    assert.equal(readFileSync(join(wt, 'docs/plans/feature-resp.md'), 'utf8'), userPlan, 'the user plan must stay byte-exact');
    assert.match(r2.text, /handoff: provision record refreshed \(user sections preserved\)/);
    assert.match(r2.text, /kept \(already present\): docs\/plans\/feature-resp\.md/);
  });
});

describe('worktrees — provision-source containment (pre-add sweep)', () => {
  it('a registry root symlinked OUTSIDE the main repo is a typed STOP before worktree add (nothing copied)', () => {
    const repo = makeRepo('src-escape');
    const outside = join(TMP, 'src-escape-outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'stolen.md'), 'outside data\n');
    rmSync(join(repo, '.claude/skills'), { recursive: true, force: true });
    symlinkSync(outside, join(repo, '.claude/skills'));
    const beforeCount = parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], repo)).length;
    const r = run(['provision', 'esc', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /provision source escapes the main repo/);
    assert.equal(parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], repo)).length, beforeCount, 'no worktree may be created');
    assert.ok(!existsSync(join(dirname(repo), `${basename(repo)}--esc`)));
  });
});

describe('worktrees — target-inside-source collision preflight (pre-add)', () => {
  it('a check-ignored target INSIDE a copy-set subtree is a typed STOP before worktree add', () => {
    const beforeCount = parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], MAIN)).length;
    const r = run(['provision', 'nest', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md', '--dir', join(MAIN, '.claude/skills/nest')], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /inside a provision source/);
    assert.equal(parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], MAIN)).length, beforeCount, 'no worktree may be registered');
  });
  it('a target inside an --include source dir is the same pre-add STOP', () => {
    mkdirSync(join(MAIN, 'ignored-extras'), { recursive: true });
    writeFileSync(join(MAIN, 'ignored-extras/data.txt'), 'x\n');
    writeFileSync(join(MAIN, '.git/info/exclude'), [...HIDDEN_EXCLUDES.slice(0, -1), '/ignored-extras/', ''].join('\n'));
    try {
      const beforeCount = parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], MAIN)).length;
      const r = run(['provision', 'nesti', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md', '--include', 'ignored-extras', '--dir', join(MAIN, 'ignored-extras/nest')], { cwd: MAIN });
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /inside a provision source/);
      assert.equal(parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], MAIN)).length, beforeCount);
    } finally {
      writeFileSync(join(MAIN, '.git/info/exclude'), HIDDEN_EXCLUDES.join('\n'));
      rmSync(join(MAIN, 'ignored-extras'), { recursive: true, force: true });
    }
  });
  it('an ignored target OUTSIDE every source subtree stays allowed (.claude/worktrees precedent)', () => {
    const r = run(['provision', 'nestok', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nestok.md', '--dir', join(MAIN, '.claude/worktrees/nestok')], { cwd: MAIN });
    assert.equal(r.code, EXIT.ok, r.errText);
    rmSync(join(MAIN, '.claude/worktrees/nestok'), { recursive: true, force: true });
    sh(['worktree', 'prune'], MAIN);
    sh(['branch', '-D', 'aw/nestok'], MAIN);
  });
});

describe('worktrees — rebase decides tracked/untracked via git, byte-safe on user files', () => {
  it('a crash-shaped resume still rebases: the wt gates.json equals the MAIN source bytes', () => {
    const repo = makeRepo('rebase-crash');
    const r1 = run(['provision', 'rbc', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-rbc.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const wt = join(dirname(repo), `${basename(repo)}--rbc`);
    // simulate the crash-before-rebase state: the copied file carries the MAIN pins again
    writeFileSync(join(wt, 'docs/ai/gates.json'), readFileSync(join(repo, 'docs/ai/gates.json'), 'utf8'));
    const r2 = run(['provision', 'rbc', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-rbc.md'], { cwd: repo });
    assert.equal(r2.code, EXIT.ok, r2.errText);
    const gates = readFileSync(join(wt, 'docs/ai/gates.json'), 'utf8');
    assert.ok(!gates.includes(`${repo}/agent-workflow-kit`), 'the main pin must be rebased on resume');
    assert.ok(gates.includes(`${wt}/agent-workflow-kit`));
  });
  it('a USER-modified untracked rebase target is preserved byte-exact and reported', () => {
    const repo = makeRepo('rebase-user');
    const r1 = run(['provision', 'rbu', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-rbu.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    const wt = join(dirname(repo), `${basename(repo)}--rbu`);
    const userGates = JSON.stringify({ gates: [{ id: 'mine', title: 'user gate', cmd: `node "${repo}/agent-workflow-kit/tools/coverage-check.mjs" --check --user-edit` }] }, null, 2);
    writeFileSync(join(wt, 'docs/ai/gates.json'), userGates);
    const r2 = run(['provision', 'rbu', '--resume', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-rbu.md'], { cwd: repo });
    assert.equal(r2.code, EXIT.ok, r2.errText);
    assert.equal(readFileSync(join(wt, 'docs/ai/gates.json'), 'utf8'), userGates, 'user bytes must survive resume');
    assert.match(r2.text, /user-modified — left untouched/);
  });
});

// ── the plan-seed refusal set (validated BEFORE any git mutation) ──────────────────────

describe('worktrees — plan-seed refusals (pre-add, no worktree is created)', () => {
  const worktreeCount = () => parseWorktreeList(sh(['worktree', 'list', '--porcelain', '-z'], MAIN)).length;
  const seedRun = (extra) => run(['provision', 'seedx', '--plan', 'docs/plans/SEED-PROMPT-feature.md', ...extra], { cwd: MAIN });

  for (const scratch of ['queue.md', 'EXECUTE-x.md', 'FEEDBACK-x.md', 'a-PROMPT.md', 'a-prompt.md', 'handoff-x.md']) {
    it(`refuses the scratch-class seeded name ${scratch}`, () => {
      const beforeCount = worktreeCount();
      const r = seedRun(['--as', scratch]);
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /scratch-class plan name/);
      assert.equal(worktreeCount(), beforeCount, 'no worktree may be created on a refused seed');
    });
  }
  it('refuses a --plan outside the main repo', () => {
    const outside = join(TMP, 'outside-plan.md');
    writeFileSync(outside, 'x\n');
    const r = run(['provision', 'seedx', '--plan', outside, '--as', 'feature-x.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /must resolve inside the main repo/);
  });
  it('refuses a --plan that is not a regular non-symlink file', () => {
    const r = run(['provision', 'seedx', '--plan', 'docs/plans', '--as', 'feature-x.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /regular non-symlink file/);
  });
  it('refuses a missing --plan path', () => {
    const r = run(['provision', 'seedx', '--plan', 'docs/plans/nope.md', '--as', 'feature-x.md'], { cwd: MAIN });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /not found/);
  });
  it('refuses a bare (in-flight) plan inside MAIN docs/plans as the source, naming the recovery', () => {
    writeFileSync(join(MAIN, 'docs/plans/bare-feature.md'), 'x\n');
    try {
      const r = run(['provision', 'seedx', '--plan', 'docs/plans/bare-feature.md'], { cwd: MAIN });
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /bare \(in-flight\) plan inside MAIN/);
      assert.match(r.errText, /rename the main copy/);
    } finally {
      rmSync(join(MAIN, 'docs/plans/bare-feature.md'));
    }
  });
  it('refuses --as with a path separator or a non-.md name (usage STOP)', () => {
    for (const bad of ['a/b.md', 'x.txt']) {
      const r = seedRun(['--as', bad]);
      assert.equal(r.code, EXIT.usage, r.errText);
    }
  });
});

// ── --include refusals ─────────────────────────────────────────────────────────────────

describe('worktrees — --include refusals', () => {
  it('refuses an out-of-repo include and a not-ignored destination', () => {
    const outside = join(TMP, 'outside-extra.txt');
    writeFileSync(outside, 'x\n');
    const r1 = run(['provision', 'incl1', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md', '--include', outside], { cwd: MAIN });
    assert.equal(r1.code, EXIT.stop);
    assert.match(r1.errText, /--include must resolve inside the main repo/);
    const r2 = run(['provision', 'incl2', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md', '--include', 'README.md'], { cwd: MAIN });
    assert.equal(r2.code, EXIT.stop);
    assert.match(r2.errText, /not ignored in the worktree/);
    assert.match(r2.errText, /ignore the path|drop the --include/);
    // both failed AFTER worktree creation (include checks need the worktree) — sweep the leftovers
    for (const slug of ['incl1', 'incl2']) {
      rmSync(join(dirname(MAIN), `${basename(MAIN)}--${slug}`), { recursive: true, force: true });
      sh(['worktree', 'prune'], MAIN);
      spawnSync('git', ['branch', '-D', `aw/${slug}`], { cwd: MAIN });
    }
  });
});

// ── node_modules arms + --install ──────────────────────────────────────────────────────

describe('worktrees — node_modules arms', () => {
  it('main without node_modules → the printed install line, record "absent"', () => {
    const repo = makeRepo('nm-absent', { nodeModules: 'none' });
    const r = run(['provision', 'nma', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /npm install/);
    const wt = join(dirname(repo), `${basename(repo)}--nma`);
    assert.ok(!existsSync(join(wt, 'node_modules')));
    assert.equal(parseProvisionRecord(readFileSync(join(wt, 'docs/plans/handoff-nma.md'), 'utf8')).nodeModules, 'absent');
  });
  it('main node_modules resolving OUTSIDE the repo → not symlinked, stated line', () => {
    const repo = makeRepo('nm-outside', { nodeModules: 'outside' });
    const r = run(['provision', 'nmo', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /resolves outside the repo/);
    const wt = join(dirname(repo), `${basename(repo)}--nmo`);
    assert.ok(!existsSync(join(wt, 'node_modules')));
  });
  it('a directory-form ignore pattern (node_modules/) skips the symlink with the stated line', () => {
    const repo = makeRepo('nm-dirslash', { excludes: ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules/', '/extra-secret.txt', ''] });
    const r = run(['provision', 'nmd', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /would not be ignored here/);
    const wt = join(dirname(repo), `${basename(repo)}--nmd`);
    assert.ok(!existsSync(join(wt, 'node_modules')));
    assert.equal(parseProvisionRecord(readFileSync(join(wt, 'docs/plans/handoff-nmd.md'), 'utf8')).nodeModules, 'not-ignored');
  });
  it('the symlink line states the shared MUTABLE cache honestly; --install on resume prints the unlink-first recovery', () => {
    const repo = makeRepo('nm-res');
    const r1 = run(['provision', 'nmr', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nmr.md'], { cwd: repo });
    assert.equal(r1.code, EXIT.ok, r1.errText);
    assert.match(r1.text, /shared MUTABLE cache — writes through it hit MAIN/);
    const wt = join(dirname(repo), `${basename(repo)}--nmr`);
    assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink());
    const r2 = run(['provision', 'nmr', '--resume', '--install', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-nmr.md'], { cwd: repo });
    assert.equal(r2.code, EXIT.ok, r2.errText);
    assert.match(r2.text, /existing symlink kept — for isolation remove it first: rm /);
    assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink(), 'the tool never unlinks it itself');
  });
  it('--install ALWAYS only prints (zero installer spawn, zero node_modules write)', () => {
    const calls = [];
    const r = run(['provision', 'nmi', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md', '--install'], { cwd: MAIN, git: recordingGit(calls) });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /install it yourself \(zero spawn\): cd .* && npm install/);
    const wt = join(dirname(MAIN), `${basename(MAIN)}--nmi`);
    assert.ok(!existsSync(join(wt, 'node_modules')));
    assert.ok(calls.every((c) => !/npm|install/.test(c)), 'no installer may be spawned');
    rmSync(wt, { recursive: true, force: true });
    sh(['worktree', 'prune'], MAIN);
    sh(['branch', '-D', 'aw/nmi'], MAIN);
  });
});

// ── .vscode window-title trio ──────────────────────────────────────────────────────────

describe('worktrees — .vscode window title', () => {
  it('written when main has .vscode/, the file is untracked, and the path is ignored in the worktree', () => {
    const repo = makeRepo('vs-ok');
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode/settings.json'), JSON.stringify({ 'editor.tabSize': 2 }));
    const r = run(['provision', 'vsa', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    const wt = join(dirname(repo), `${basename(repo)}--vsa`);
    const written = JSON.parse(readFileSync(join(wt, '.vscode/settings.json'), 'utf8'));
    assert.equal(written['window.title'], 'vsa');
    assert.equal(written['editor.tabSize'], 2, 'main untracked settings ride along');
    assert.match(r.text, /window\.title = vsa/);
  });
  it('a TRACKED .vscode/settings.json is skipped and stays byte-unchanged in the worktree', () => {
    const repo = makeRepo('vs-tracked', { excludes: ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules/', '/extra-secret.txt', ''] });
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode/settings.json'), '{"tracked": true}\n');
    sh(['add', '.vscode/settings.json'], repo);
    sh(['commit', '-q', '-m', 'vscode'], repo);
    const r = run(['provision', 'vst', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /is tracked — left byte-unchanged/);
    const wt = join(dirname(repo), `${basename(repo)}--vst`);
    assert.equal(readFileSync(join(wt, '.vscode/settings.json'), 'utf8'), '{"tracked": true}\n');
  });
  it('a not-ignored destination is skipped with the stated reason (never a future land leftover)', () => {
    const repo = makeRepo('vs-notign', { excludes: ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules/', '/extra-secret.txt', ''] });
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode/settings.json'), '{}');
    const r = run(['provision', 'vsn', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /not ignored in the worktree — skipped/);
    const wt = join(dirname(repo), `${basename(repo)}--vsn`);
    assert.ok(!existsSync(join(wt, '.vscode/settings.json')));
  });
});

// ── docs/plans-not-ignored STOP ────────────────────────────────────────────────────────

describe('worktrees — docs/plans must be ignored in main', () => {
  it('a repo where docs/plans is not git-ignored is a typed STOP before any mutation', () => {
    const repo = makeRepo('no-excl', { excludes: ['/docs/ai/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules/', '/extra-secret.txt', ''] });
    const calls = [];
    const r = run(['provision', 'x1', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo, git: recordingGit(calls) });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /docs\/plans is not git-ignored/);
    assert.ok(!calls.some((c) => c.startsWith('worktree add')));
  });
});

// ── copy semantics (unit level, injected/real fs) ──────────────────────────────────────

describe('worktrees — copy semantics', () => {
  it('copy-if-missing never overwrites an existing destination', () => {
    const src = join(TMP, 'cs-src');
    const wt = join(TMP, 'cs-wt');
    mkdirSync(src, { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(src, 'f.txt'), 'new\n');
    writeFileSync(join(wt, 'f.txt'), 'old\n');
    const { report } = copyTreeIfMissing({ srcAbs: join(src, 'f.txt'), dstAbs: join(wt, 'f.txt'), wtRoot: wt, rel: 'f.txt' });
    assert.equal(readFileSync(join(wt, 'f.txt'), 'utf8'), 'old\n');
    assert.match(report.join('\n'), /kept \(already present\)/);
  });
  it('an absolute symlink is a typed STOP', () => {
    const src = join(TMP, 'cs-abs');
    mkdirSync(src, { recursive: true });
    symlinkSync('/etc/hostname', join(src, 'lnk'));
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: join(src, 'lnk'), dstAbs: join(TMP, 'cs-abs-wt', 'lnk'), wtRoot: join(TMP, 'cs-abs-wt'), rel: 'lnk' }),
      (e) => e.code === WORKTREES_STOP && /absolute symlink/.test(e.message),
    );
  });
  it('a relative symlink escaping the worktree is a typed STOP; one resolving inside copies as a symlink', () => {
    const src = join(TMP, 'cs-rel');
    const wt = join(TMP, 'cs-rel-wt');
    mkdirSync(src, { recursive: true });
    mkdirSync(wt, { recursive: true });
    symlinkSync('../../outside', join(src, 'esc'));
    symlinkSync('AGENTS.md', join(src, 'ok'));
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: join(src, 'esc'), dstAbs: join(wt, 'esc'), wtRoot: wt, rel: 'esc' }),
      (e) => e.code === WORKTREES_STOP && /escaping the worktree/.test(e.message),
    );
    copyTreeIfMissing({ srcAbs: join(src, 'ok'), dstAbs: join(wt, 'ok'), wtRoot: wt, rel: 'ok' });
    assert.ok(lstatSync(join(wt, 'ok')).isSymbolicLink());
  });
  it('a special file (device/FIFO/socket) is a typed STOP', () => {
    const fake = { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false, mode: 0 };
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: '/x/fifo', dstAbs: join(TMP, 'cs-spec', 'fifo'), wtRoot: join(TMP, 'cs-spec'), rel: 'fifo', deps: { lstat: () => fake } }),
      (e) => e.code === WORKTREES_STOP && /special file/.test(e.message),
    );
  });
  it('a FILE copy through a symlinked destination parent escaping the worktree is a typed STOP', () => {
    const src = join(TMP, 'dc-file');
    const wt = join(TMP, 'dc-file-wt');
    const outside = join(TMP, 'dc-file-outside');
    mkdirSync(src, { recursive: true });
    mkdirSync(wt, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(src, 'f.txt'), 'x\n');
    symlinkSync(outside, join(wt, 'sub'));
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: join(src, 'f.txt'), dstAbs: join(wt, 'sub', 'f.txt'), wtRoot: wt, rel: 'sub/f.txt' }),
      (e) => e.code === WORKTREES_STOP && /symlink/.test(e.message),
    );
    assert.ok(!existsSync(join(outside, 'f.txt')), 'nothing may land outside the worktree');
  });
  it('a SYMLINK copy through a symlinked destination parent is the same STOP', () => {
    const src = join(TMP, 'dc-lnk');
    const wt = join(TMP, 'dc-lnk-wt');
    const outside = join(TMP, 'dc-lnk-outside');
    mkdirSync(src, { recursive: true });
    mkdirSync(wt, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(src, 'target.md'), 'x\n');
    symlinkSync('target.md', join(src, 'lnk'));
    symlinkSync(outside, join(wt, 'sub'));
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: join(src, 'lnk'), dstAbs: join(wt, 'sub', 'lnk'), wtRoot: wt, rel: 'sub/lnk' }),
      (e) => e.code === WORKTREES_STOP,
    );
  });
  it('a DIRECTORY mkdir through a symlinked destination parent is the same STOP', () => {
    const src = join(TMP, 'dc-dir');
    const wt = join(TMP, 'dc-dir-wt');
    const outside = join(TMP, 'dc-dir-outside');
    mkdirSync(join(src, 'inner'), { recursive: true });
    writeFileSync(join(src, 'inner/f'), 'x');
    mkdirSync(wt, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(wt, 'sub'));
    assert.throws(
      () => copyTreeIfMissing({ srcAbs: src, dstAbs: join(wt, 'sub', 'dir'), wtRoot: wt, rel: 'sub/dir' }),
      (e) => e.code === WORKTREES_STOP,
    );
  });
  it('an executable copy applies its mode through the destination descriptor', () => {
    const src = join(TMP, 'dc-chmod');
    const wt = join(TMP, 'dc-chmod-wt');
    mkdirSync(src, { recursive: true });
    mkdirSync(join(wt, 'sub'), { recursive: true });
    writeFileSync(join(src, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(src, 'run.sh'), 0o755);
    const calls = [];
    const deps = {
      fchmod: (fd, mode) => {
        calls.push({ fd, mode });
        fchmodSync(fd, mode);
      },
    };
    const destination = join(wt, 'sub', 'run.sh');
    copyTreeIfMissing({ srcAbs: join(src, 'run.sh'), dstAbs: destination, wtRoot: wt, rel: 'sub/run.sh', deps });
    assert.deepEqual(calls.map((call) => call.mode), [0o755]);
    assert.notEqual(lstatSync(destination).mode & 0o111, 0);
  });
  it('a copy fs error is a typed STOP carrying the code and the path', () => {
    const src = join(TMP, 'cs-err');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'f'), 'x');
    assert.throws(
      () => copyTreeIfMissing({
        srcAbs: join(src, 'f'), dstAbs: join(TMP, 'cs-err-wt', 'f'), wtRoot: join(TMP, 'cs-err-wt'), rel: 'f',
        deps: { write: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } },
      }),
      (e) => e.code === WORKTREES_STOP && /copy failed \(EIO\) at f/.test(e.message),
    );
  });
});

// ── the provision copy set (registry-derived, single source) ───────────────────────────

describe('worktrees — provisionCopySet', () => {
  it('derives present KIT_OWN + KNOWN_FOOTPRINT entries, excludes docs/plans (seeded separately) and absent entries', () => {
    const set = provisionCopySet(MAIN);
    assert.ok(set.includes('/AGENTS.md'));
    assert.ok(set.includes('/CLAUDE.md'));
    assert.ok(set.includes('/docs/ai/'));
    assert.ok(set.includes('/.claude/settings.json'));
    assert.ok(set.includes('/.claude/skills/'));
    assert.ok(!set.includes('/docs/plans/'), 'docs/plans is seeded, never copied wholesale');
    assert.ok(!set.includes('/GEMINI.md'), 'absent footprint entries are not candidates');
  });
  it('the copilot glob expands to concrete present files via expandGlob', () => {
    mkdirSync(join(MAIN, '.github'), { recursive: true });
    writeFileSync(join(MAIN, '.github/copilot-instructions.md'), 'x\n');
    try {
      assert.ok(provisionCopySet(MAIN).includes('/.github/copilot-instructions.md'));
    } finally {
      rmSync(join(MAIN, '.github'), { recursive: true, force: true });
    }
  });
});

// ── the absolute-pin rebase (pure) ─────────────────────────────────────────────────────

describe('worktrees — rebaseAbsolutePins', () => {
  const mainRoot = '/home/u/proj/main';
  const wtRoot = '/home/u/proj/main--x';

  it('rebases forward-slash pins and reports per line', () => {
    const { text, changes } = rebaseAbsolutePins(`node "${mainRoot}/tools/c.mjs" --check\n`, mainRoot, wtRoot);
    assert.equal(text, `node "${wtRoot}/tools/c.mjs" --check\n`);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].line, 1);
  });
  it('rebases Windows-shaped backslash pins in the same slash style', () => {
    const { text } = rebaseAbsolutePins('node "C:\\u\\main\\tools\\c.mjs"', 'C:/u/main', 'C:/u/main--x');
    assert.equal(text, 'node "C:\\u\\main--x\\tools\\c.mjs"');
  });
  it('a longer sibling path sharing the prefix is NOT rebased (boundary-guarded)', () => {
    const { text, changes } = rebaseAbsolutePins(`${mainRoot}2/tool`, mainRoot, wtRoot);
    assert.equal(text, `${mainRoot}2/tool`);
    assert.equal(changes.length, 0);
  });
  it('no-op fixtures: pin-free text, already-rebased text, relative cmds, unrelated absolute paths', () => {
    for (const noop of ['node tools/c.mjs --check\n', `node ${wtRoot}/tools/c.mjs\n`, 'npm run lint\n', '/usr/bin/env node\n']) {
      const { text, changes } = rebaseAbsolutePins(noop, mainRoot, wtRoot);
      assert.equal(text, noop);
      assert.equal(changes.length, 0);
    }
  });
});

// ── visible-mode: the tracked-pin declaration ──────────────────────────────────────────

describe('worktrees — tracked gates.json with a root pin (visible mode)', () => {
  it('is never edited; the report carries the --cwd routing declaration', () => {
    const repo = makeRepo('visible', { footprint: false, excludes: ['/docs/plans/', ''] });
    mkdirSync(join(repo, 'docs/ai'), { recursive: true });
    writeFileSync(join(repo, 'docs/ai/gates.json'), JSON.stringify({
      gates: [{ id: 'coverage-check', title: 't', cmd: `node "${repo}/agent-workflow-kit/tools/coverage-check.mjs" --check` }],
    }, null, 2));
    sh(['add', 'docs/ai/gates.json'], repo);
    sh(['commit', '-q', '-m', 'gates'], repo);
    mkdirSync(join(repo, 'docs/plans'), { recursive: true });
    writeFileSync(join(repo, 'docs/plans/SEED-PROMPT-feature.md'), '# p\n');
    const r = run(['provision', 'vis', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: repo });
    assert.equal(r.code, EXIT.ok, r.errText);
    assert.match(r.text, /tracked declaration is not worktree-portable/);
    assert.match(r.text, /MAIN runner via --cwd/);
    const wt = join(dirname(repo), `${basename(repo)}--vis`);
    assert.ok(readFileSync(join(wt, 'docs/ai/gates.json'), 'utf8').includes(`${repo}/agent-workflow-kit`), 'the tracked pin stays untouched');
  });
});

// ── a non-refusal git error is surfaced verbatim ───────────────────────────────────────

describe('worktrees — git errors surface verbatim', () => {
  it('a failing worktree add carries git own words', () => {
    const git = recordingGit([], {
      intercept: (args) => (args[0] === 'worktree' && args[1] === 'add' ? { status: 128, stdout: '', stderr: 'fatal: disk exploded' } : null),
    });
    const r = run(['provision', 'gerr', '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature-x.md'], { cwd: MAIN, git });
    assert.equal(r.code, EXIT.stop);
    assert.match(r.errText, /fatal: disk exploded/);
  });
});

// ── CLI usage STOPs ────────────────────────────────────────────────────────────────────

describe('worktrees — CLI usage', () => {
  it('an unknown subcommand is a usage STOP naming the surface', () => {
    assert.throws(() => parseArgs(['frobnicate']), (e) => e.exitCode === EXIT.usage && /unknown subcommand/.test(e.message));
  });
  it('provision without the positional slug, --include without an argument, list with a positional — all usage STOPs', () => {
    assert.throws(() => parseArgs(['provision']), (e) => e.exitCode === EXIT.usage);
    assert.throws(() => parseArgs(['provision', 'x', '--include']), (e) => e.exitCode === EXIT.usage);
    assert.throws(() => parseArgs(['list', 'x']), (e) => e.exitCode === EXIT.usage);
    assert.throws(() => parseArgs(['provision', 'x', '--frob']), (e) => e.exitCode === EXIT.usage);
  });
  it('provision without --plan is a usage STOP (the ONE seeded plan is required)', () => {
    const r = run(['provision', 'noplan'], { cwd: MAIN });
    assert.equal(r.code, EXIT.usage);
    assert.match(r.errText, /requires --plan/);
  });
  it('land/cleanup state their build honestly (this half ships with the landing phase)', () => {
    for (const sub of ['land', 'cleanup']) {
      const r = run([sub, 'x'], { cwd: MAIN });
      assert.equal(r.code, EXIT.stop);
      assert.match(r.errText, /not available in this build yet/);
    }
  });
  it('--help prints the four subcommands', () => {
    const r = run(['--help'], { cwd: MAIN });
    assert.equal(r.code, EXIT.ok);
    for (const token of ['provision', 'list', 'land', 'cleanup', '--abandon']) assert.ok(r.text.includes(token));
  });
  it('the usage marks land AND cleanup as arriving with this release landing half (removed in that phase)', () => {
    const r = run(['--help'], { cwd: MAIN });
    const hits = r.text.match(/arrives with this release's landing half/g) ?? [];
    assert.equal(hits.length, 2, 'both land and cleanup carry the marking');
  });
});

// ── the handoff artifact round-trip ────────────────────────────────────────────────────

describe('worktrees — handoff record round-trip', () => {
  it('parseProvisionRecord trims trailing whitespace in values', () => {
    const record = parseProvisionRecord('## Provision record\n\n- slug: s1  \n- branch: aw/s1\t\n- include: a.txt \n- node_modules: symlinked\n- vscode-settings: absent\n');
    assert.equal(record.slug, 's1');
    assert.equal(record.branch, 'aw/s1');
    assert.deepEqual(record.includes, ['a.txt']);
  });
  it('composeProvisionArgv reconstructs the FULL paste-ready invocation with quoting', () => {
    const line = composeProvisionArgv({
      root: '/home/u/my repo',
      slug: 'alpha',
      flags: { plan: 'docs/plans/x.md', as: 'feature a.md', branch: 'aw/alt', dir: '/tmp/w t', include: ['a.txt', 'b dir'], install: true, resume: true },
    });
    assert.match(line, /^cd '\/home\/u\/my repo' && node /);
    assert.match(line, /worktrees\.mjs' provision alpha --plan docs\/plans\/x\.md --as 'feature a\.md' --branch aw\/alt --dir '\/tmp\/w t' --include a\.txt --include 'b dir' --install --resume$/);
  });
  it('composeHandoffStub → parseProvisionRecord is lossless for the record fields', () => {
    const fields = { slug: 's1', branch: 'aw/s1', includes: ['a.txt', 'b/c.txt'], nodeModules: 'symlinked', vscode: 'written' };
    const record = parseProvisionRecord(composeHandoffStub(fields));
    assert.equal(record.slug, 's1');
    assert.equal(record.branch, 'aw/s1');
    assert.deepEqual(record.includes, ['a.txt', 'b/c.txt']);
    assert.equal(record.nodeModules, 'symlinked');
    assert.equal(record.vscode, 'written');
  });
  it('an empty include list round-trips as none', () => {
    const record = parseProvisionRecord(composeHandoffStub({ slug: 's', branch: 'b', includes: [], nodeModules: 'absent', vscode: 'absent' }));
    assert.deepEqual(record.includes, []);
  });
});

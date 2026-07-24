// worktrees-resume-verify-r2.test.mjs — slice R2 of the resume-verify design: the resume verify
// proves PER PLACED PATH (the closed-world placement registry — leaf-only, kind-gated, frozen at
// the verify), never the global tree, so the session's own work is out of scope BY CONSTRUCTION.
// The first-provision lane keeps the blanket clean-tree verify, with its untracked visibility made
// config-independent.
//
// Phase 1 of the plan is CHARACTERIZATION: the arms below pin behavior that must NOT change and are
// GREEN before any worktrees.mjs edit.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// Dynamic import so this spec LOADS against the pre-fix tree (the red-first doctrine).
const {
  EXIT, runCli, handoffBasename, parseProvisionRecord,
  PLACEMENT_REGISTRY, RESUME_VERIFY_RULE, createPlacementJournal,
} = await import('./worktrees.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-wt-rv-r2-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// ── real-git harness (the R1 pattern) ──────────────────────────────────────────────────

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const EXCLUDES = ['/docs/ai/', '/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''];
const VISIBLE_EXCLUDES = ['/docs/plans/', '/.claude/', '/AGENTS.md', '/CLAUDE.md', '/node_modules', ''];

const makeRepo = (name, { pkg = { name: 'r', version: '1.0.0' }, excludes = EXCLUDES, trackDocsAi = false, vscode = false } = {}) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify(pkg));
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  if (trackDocsAi) sh(['add', '-A'], main);
  else sh(['add', 'README.md', 'package.json'], main);
  sh(['commit', '-q', '-m', 'init'], main);
  writeFileSync(join(main, '.git/info/exclude'), excludes.join('\n'));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  if (vscode) {
    mkdirSync(join(main, '.vscode'), { recursive: true });
    writeFileSync(join(main, '.vscode/settings.json'), '{}\n');
  }
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

const wtPath = (repo, slug) => join(dirname(repo), `${basename(repo)}--${slug}`);
const handoffPath = (repo, slug) => join(wtPath(repo, slug), 'docs/plans', handoffBasename(slug));
const readHandoff = (repo, slug) => readFileSync(handoffPath(repo, slug), 'utf8');
const rewriteHandoff = (repo, slug, edit) => writeFileSync(handoffPath(repo, slug), edit(readHandoff(repo, slug)));
const readRecord = (repo, slug) => parseProvisionRecord(readHandoff(repo, slug));

// A post-checkout hook (git runs it at `worktree add`, chdir'ed into the new worktree).
const installHook = (main, script) => {
  const hooks = join(main, '.git/hooks');
  mkdirSync(hooks, { recursive: true });
  const p = join(hooks, 'post-checkout');
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
};

// ── Phase 1: the characterized floor (GREEN before any edit) ───────────────────────────

describe('slice R2 — the floor that must NOT change (real git)', () => {
  it('first-provision-blanket-verify-unchanged', () => {
    // SESSION-class dirt (a path provision never places) refuses the FRESH lane at the blanket
    // clean-tree verify — the deliberately stricter first-provision contract R2 preserves.
    const repo = makeRepo('r2-fresh-blanket');
    const hook = installHook(repo, 'echo scratch > "$PWD/session-scratch.txt"');
    const first = run(provisionArgs('freshblanket'), repo);
    assert.equal(first.code, EXIT.stop, 'the fresh lane refuses any dirt, owned or not');
    assert.match(first.errText, /post-provision verify failed/);
    assert.match(first.errText, /session-scratch\.txt/, 'the offending path is named');
    rmSync(hook);
  });

  it('non-identity-provision-fields-never-authorize-resume', () => {
    const repo = makeRepo('r2-d5-lock');
    const first = run(provisionArgs('d5lock'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    // Non-identity recorded facts are tampered: they must not authorize, refuse, or steer the resume.
    rewriteHandoff(repo, 'd5lock', (text) => text
      .replace(/^- node_modules: .*$/m, '- node_modules: bogus-fact')
      .replace(/^- vscode-settings: .*$/m, '- vscode-settings: bogus-fact'));
    const resumed = run(provisionArgs('d5lock', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, `non-identity fields never authorize: ${resumed.errText}`);
    const record = readRecord(repo, 'd5lock');
    assert.notEqual(record.nodeModules, 'bogus-fact', 'the refresh restores the LIVE fact');
    assert.notEqual(record.vscode, 'bogus-fact', 'the refresh restores the LIVE fact');
    // The identity fields DO authorize — both mismatches stay fail-closed.
    rewriteHandoff(repo, 'd5lock', (text) => text.replace(/^- slug: .*$/m, '- slug: someone-else'));
    const slugMismatch = run(provisionArgs('d5lock', ['--resume']), repo);
    assert.equal(slugMismatch.code, EXIT.stop);
    assert.match(slugMismatch.errText, /identity mismatch: the handoff record slug/);
    rewriteHandoff(repo, 'd5lock', (text) => text.replace(/^- slug: .*$/m, '- slug: d5lock'));
    rewriteHandoff(repo, 'd5lock', (text) => text.replace(/^- branch: .*$/m, '- branch: aw/someone-else'));
    const branchMismatch = run(provisionArgs('d5lock', ['--resume']), repo);
    assert.equal(branchMismatch.code, EXIT.stop);
    assert.match(branchMismatch.errText, /identity mismatch: the handoff record branch/);
  });

  it('legacy-pending-record-resume-completes', () => {
    // A record still carrying the STUB's pending sentinels (a half-done or pre-upgrade provision)
    // carries no completion attestation anyone reads — the resume completes and refreshes it.
    const repo = makeRepo('r2-legacy-pending');
    const first = run(provisionArgs('legacypend'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    rewriteHandoff(repo, 'legacypend', (text) => text
      .replace(/^- node_modules: .*$/m, '- node_modules: pending')
      .replace(/^- vscode-settings: .*$/m, '- vscode-settings: pending')
      .replace(/^- install: .*$/m, '- install: pending'));
    const resumed = run(provisionArgs('legacypend', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.doesNotMatch(readHandoff(repo, 'legacypend'), /- node_modules: pending/,
      'the completing resume refreshed the record away from the pending sentinels');
  });

  it('deleted-owned-tracked-path-is-re-placed', () => {
    // copy-if-missing semantics, stated: an ABSENT owned path is re-placed — deleting an owned
    // file is not preserved. Visible mode makes the owned copy-set leaf a TRACKED path.
    const repo = makeRepo('r2-deleted-owned', { excludes: VISIBLE_EXCLUDES, trackDocsAi: true });
    const first = run(provisionArgs('delowned'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    const owned = join(wtPath(repo, 'delowned'), 'docs/ai/gates.json');
    const before = readFileSync(owned, 'utf8');
    rmSync(owned);
    const resumed = run(provisionArgs('delowned', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.ok(existsSync(owned), 'the deleted owned path is re-placed by copy-if-missing');
    assert.equal(readFileSync(owned, 'utf8'), before, 're-placed from MAIN, byte-identical');
  });
});

// ── the placement registry + journal (injected git/fs) ─────────────────────────────────
// Journal membership is observable ONLY through the verifier's proof set, so these arms prove it
// the way the contract does: a member's lane probe decides the run. The probe-ERROR lane is the
// uniform membership prosecutor — unlike the untracked lane it is reachable for every surface,
// including the ones a shipped provision door gates before the verifier ever sees them.

const MOCK_HEAD = '5555555555555555555555555555555555555555';

const makeMockRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, 'README.md'), 'fixture\n');
  writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } }));
  writeFileSync(join(main, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({ gates: [] }));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-x.md'), '# body\n');
  mkdirSync(join(main, '.vscode'), { recursive: true });
  writeFileSync(join(main, '.vscode/settings.json'), '{}\n');
  mkdirSync(join(main, 'node_modules/left'), { recursive: true });
  writeFileSync(join(main, 'node_modules/left/index.js'), 'module.exports = 1;\n');
  mkdirSync(join(main, 'notes'), { recursive: true });
  writeFileSync(join(main, 'notes/note.md'), '# note\n');
  writeFileSync(join(main, 'notes/sibling.md'), '# sibling\n');
  return main;
};

// A minimal injected git covering the provision call surface. `overrides(args, cwd)` may return a
// result to intercept a call; everything else answers "ignored / untracked / clean".
const makeMockGit = (main, { overrides = () => null } = {}) => {
  const commonDir = join(main, '.git');
  const entries = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const list = () => [
    [`worktree ${main}`, `HEAD ${MOCK_HEAD}`, 'branch refs/heads/main'],
    ...entries.map(({ path, branch }) => [`worktree ${path}`, `HEAD ${MOCK_HEAD}`, `branch refs/heads/${branch}`]),
  ].map((fields) => fields.join('\0')).join('\0\0') + '\0\0';
  const git = (args, cwd) => {
    const hit = overrides(args, cwd);
    if (hit) return hit;
    if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return ok(main);
    if (args[0] === 'rev-parse' && (args.includes('--git-dir') || args.includes('--git-common-dir'))) return ok(`${commonDir}\n`);
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return ok(`${MOCK_HEAD}\n`);
    if (args[0] === 'check-ignore') return ok();
    if (args[0] === 'ls-tree') return ok();
    if (args[0] === 'ls-files') return ok();
    if (args[0] === 'status') return ok();
    if (args[0] === 'worktree' && args[1] === 'list') return ok(list());
    if (args[0] === 'worktree' && args[1] === 'add') {
      const canonical = join(main, '..', basename(args[4]));
      mkdirSync(canonical, { recursive: true });
      entries.push({ path: canonical, branch: args[3] });
      return ok();
    }
    return { status: 128, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
  return git;
};

const runMock = (argv, cwd, git, deps = {}) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, git, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, out, errText: err.join('\n') };
};

const mockArgs = (slug, extra = []) =>
  ['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-x.md', '--as', `feature-${slug}.md`, ...extra];

// The literal pathspec the verifier probes with — a member's probe is armed by matching it.
const isLaneProbeFor = (args, rel) =>
  args[0] === 'ls-files' && args.some((a) => a === `:(literal)${rel}`);
const isIgnoreProbeFor = (args, rel) => args[0] === 'check-ignore' && args[args.length - 1] === rel;

// Provision once with everything ignored, then re-run --resume under an armed override.
const provisionThenResume = ({ name, slug, extra = [], arm }) => {
  const main = makeMockRepo(name);
  let armed = false;
  const git = makeMockGit(main, { overrides: (args, cwd) => (armed ? arm(args, cwd) : null) });
  const first = runMock(mockArgs(slug, extra), main, git);
  assert.equal(first.code, EXIT.ok, `the fresh provision must succeed: ${first.errText}`);
  armed = true;
  return { main, resumed: runMock(mockArgs(slug, [...extra, '--resume']), main, git) };
};

describe('slice R2 — the closed-world placement registry (injected git)', () => {
  it('placement-registry-is-frozen-and-pinned', () => {
    const expected = [
      'handoff-stub', 'seed-plan', 'copy-set-leaf', 'include-leaf',
      'node-modules-link', 'vscode-settings', 'pin-rebase-target', 'record-refresh',
    ];
    assert.ok(Object.isFrozen(PLACEMENT_REGISTRY), 'the registry ships frozen');
    assert.deepEqual([...PLACEMENT_REGISTRY], expected, 'a surface added in code must be added here deliberately');
    assert.deepEqual(expected, [...PLACEMENT_REGISTRY], 'both directions — a removed surface fails too');
  });

  // One positive journaling arm per PLACING surface: arm its lane probe to fail and the run must
  // STOP naming exactly that leaf — proof the path is in this run's proof set.
  for (const [surface, rel] of [
    ['handoff-stub', 'docs/plans/handoff-journal.md'],
    ['seed-plan', 'docs/plans/feature-journal.md'],
    ['copy-set-leaf', 'AGENTS.md'],
    ['include-leaf', 'notes/note.md'],
    ['node-modules-link', 'node_modules'],
    ['vscode-settings', '.vscode/settings.json'],
  ]) {
    it(`journaled surface ${surface} is in the resume proof set`, () => {
      const { resumed } = provisionThenResume({
        name: `r2-journal-${surface}`,
        slug: 'journal',
        extra: surface === 'include-leaf' ? ['--include', 'notes'] : [],
        arm: (args) => (isLaneProbeFor(args, rel)
          ? { status: 128, stdout: '', stderr: `boom: ${surface} lane probe` }
          : null),
      });
      assert.equal(resumed.code, EXIT.stop, `${surface} must be probed by the verifier`);
      assert.ok(resumed.errText.includes(rel), `the STOP names the exact leaf: ${resumed.errText}`);
      assert.match(resumed.errText, /boom/, 'the probe error is surfaced verbatim');
      assert.ok(resumed.errText.includes(RESUME_VERIFY_RULE), 'every resume-verify STOP carries the rule');
    });
  }

  it('pin-rebase-target is in the resume proof set even when MAIN never copied it', () => {
    // A rebase target present in the CHECKOUT but absent from MAIN is not a copy-set member, so
    // this surface is the only thing that can own it.
    const main = makeMockRepo('r2-journal-pin');
    rmSync(join(main, '.vscode'), { recursive: true, force: true });
    let armed = false;
    const rel = '.claude/settings.json';
    const git = makeMockGit(main, {
      overrides: (args) => (armed && isLaneProbeFor(args, rel)
        ? { status: 128, stdout: '', stderr: 'boom: pin-rebase lane probe' }
        : null),
    });
    const first = runMock(mockArgs('pinreb'), main, git);
    assert.equal(first.code, EXIT.ok, first.errText);
    const wt = join(main, '..', `${basename(main)}--pinreb`);
    mkdirSync(join(wt, '.claude'), { recursive: true });
    writeFileSync(join(wt, rel), `{"pin": ${JSON.stringify(main)}}\n`);
    armed = true;
    const resumed = runMock(mockArgs('pinreb', ['--resume']), main, git);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes(rel), `the STOP names the rebase target: ${resumed.errText}`);
  });

  it('kind-mismatched-node-at-owned-path-is-session', () => {
    // A DIRECTORY where the node_modules lane places a symlink is the pre-existing kept-exit
    // residual: kind-gated OUT of the journal, so its lane is never probed and never a STOP.
    const main = makeMockRepo('r2-kind-dir');
    let armed = false;
    const git = makeMockGit(main, {
      overrides: (args) => (armed && isLaneProbeFor(args, 'node_modules')
        ? { status: 128, stdout: '', stderr: 'boom: node_modules lane probe' }
        : null),
    });
    const first = runMock(mockArgs('kinddir'), main, git);
    assert.equal(first.code, EXIT.ok, first.errText);
    const wt = join(main, '..', `${basename(main)}--kinddir`);
    rmSync(join(wt, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(wt, 'node_modules/left'), { recursive: true });
    writeFileSync(join(wt, 'node_modules/left/index.js'), 'user content\n');
    armed = true;
    const resumed = runMock(mockArgs('kinddir', ['--resume']), main, git);
    assert.equal(resumed.code, EXIT.ok, `a kind-mismatched node is SESSION, never probed: ${resumed.errText}`);
    assert.ok(existsSync(join(wt, 'node_modules/left/index.js')), 'and it is left untouched');
  });

  it('kept-symlink-from-symlink-source-stays-journal-owned', () => {
    // The mirror arm: a symlink where the lane's source places a symlink keeps its membership.
    const { resumed } = provisionThenResume({
      name: 'r2-kind-symlink',
      slug: 'kindsym',
      arm: (args) => (isLaneProbeFor(args, 'node_modules')
        ? { status: 128, stdout: '', stderr: 'boom: node_modules lane probe' }
        : null),
    });
    assert.equal(resumed.code, EXIT.stop, 'a kept symlink of the placed kind stays in the proof set');
    assert.ok(resumed.errText.includes('node_modules'));
  });

  it('written-outcome-joins-the-journal-unconditionally', () => {
    // The kind gate is the KEPT-outcome residual, never a hole in provision's own proof: a node
    // THIS attempt created is owned by construction, so a kind that changed between the write and
    // the journal call must NOT drop it silently out of the proof set (D9's fail-safe floor).
    const swapped = { lstat: () => ({ isSymbolicLink: () => true, isFile: () => false }) };
    const journal = createPlacementJournal({ wtRoot: TMP, fs: swapped });
    journal.record({ rel: 'AGENTS.md', surface: 'copy-set-leaf', outcome: 'written', kind: 'file' });
    journal.record({ rel: 'docs/ai/gates.json', surface: 'copy-set-leaf', outcome: 'kept', kind: 'file' });
    assert.deepEqual(journal.freeze(), [{ rel: 'AGENTS.md', surface: 'copy-set-leaf', outcome: 'written' }],
      'written is journaled whatever the live kind; a kind-mismatched KEPT node is SESSION');
  });

  it('placement-registry-refuses-an-unregistered-surface', () => {
    // The closed world has teeth: a future lane that journals under a name the registry does not
    // carry fails closed instead of silently widening the proof set.
    const journal = createPlacementJournal({ wtRoot: TMP, fs: { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }) } });
    assert.throws(
      () => journal.record({ rel: 'AGENTS.md', surface: 'some-new-lane', outcome: 'written' }),
      /is not a registry surface — the placement registry is closed/,
    );
  });

  it('post-verify-refresh-only-at-journaled-path', () => {
    // The freeze lock: after the verify the journal admits writes ONLY at paths it already holds.
    const fs = { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }) };
    const journal = createPlacementJournal({ wtRoot: TMP, fs });
    journal.record({ rel: 'docs/plans/handoff-x.md', surface: 'handoff-stub', outcome: 'written' });
    assert.deepEqual(journal.freeze(), [{ rel: 'docs/plans/handoff-x.md', surface: 'handoff-stub', outcome: 'written' }]);
    journal.record({ rel: 'docs/plans/handoff-x.md', surface: 'record-refresh', outcome: 'kept' });
    assert.throws(
      () => journal.record({ rel: 'docs/plans/other.md', surface: 'record-refresh', outcome: 'written' }),
      /refusing a post-verify write at an unjournaled path: docs\/plans\/other\.md/,
    );
    assert.deepEqual(journal.freeze(), [{ rel: 'docs/plans/handoff-x.md', surface: 'handoff-stub', outcome: 'written' }],
      'a post-freeze write never joins the proof set');
  });

  it('record-refresh-failure-after-a-clean-verify-keeps-the-prior-record', () => {
    // The freeze lock: the record refresh is a registry surface permitted ONLY at the handoff path
    // the stub already journaled. A refresh aimed anywhere else is a fail-closed STOP.
    const main = makeMockRepo('r2-freeze');
    const git = makeMockGit(main);
    const first = runMock(mockArgs('freeze'), main, git);
    assert.equal(first.code, EXIT.ok, first.errText);
    const wt = join(main, '..', `${basename(main)}--freeze`);
    // The refresh renames its atomic temp onto the handoff path; redirect that ONE write.
    const resumed = runMock(mockArgs('freeze', ['--resume']), main, git, {
      rename: (src, dst) => {
        if (basename(dst).startsWith('handoff-')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return renameSync(src, dst);
      },
    });
    assert.equal(resumed.code, EXIT.stop, 'a failed post-verify refresh still STOPs');
    assert.ok(existsSync(join(wt, 'docs/plans', handoffBasename('freeze'))), 'the prior record survives');
  });
});

// ── the tolerance flip: session work is out of scope BY CONSTRUCTION (real git) ─────────

const excludeFile = (repo) => join(repo, '.git/info/exclude');
const deIgnore = (repo, rule) => {
  const kept = readFileSync(excludeFile(repo), 'utf8').split('\n').filter((line) => line !== rule);
  writeFileSync(excludeFile(repo), kept.join('\n'));
};

describe('slice R2 — what --resume tolerates (real git)', () => {
  it('dirty-tracked-manifest-resume-completes', () => {
    // THE headline: the AD-071 byte-exact dirty-resume STOP pin is deliberately retired here (D7).
    const repo = makeRepo('r2-dirty-manifest', { pkg: { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } } });
    const first = run(provisionArgs('dirtyman'), repo);
    assert.equal(first.code, EXIT.ok, first.errText);
    const wt = wtPath(repo, 'dirtyman');
    writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
    const resumed = run(provisionArgs('dirtyman', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, `an uncommitted tracked edit is the session's own work: ${resumed.errText}`);
    assert.equal(JSON.parse(readFileSync(join(wt, 'package.json'), 'utf8')).dependencies, undefined,
      'and it is left untouched');
  });

  it('posture-follows-live-dirty-manifest-on-resume', () => {
    // The AD-067 D1 both-directions lane goes LIVE: an UNCOMMITTED manifest edit now steers the
    // refreshed posture, in both directions — previously unreachable behind the clean-tree STOP.
    const shed = makeRepo('r2-live-shed', { pkg: { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } } });
    assert.equal(run(provisionArgs('liveshed'), shed).code, EXIT.ok);
    assert.notEqual(readRecord(shed, 'liveshed').install, 'no install needed — the project declares no dependencies');
    writeFileSync(join(wtPath(shed, 'liveshed'), 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
    assert.equal(run(provisionArgs('liveshed', ['--resume']), shed).code, EXIT.ok);
    assert.equal(readRecord(shed, 'liveshed').install, 'no install needed — the project declares no dependencies',
      'shed dependencies GRANT the proof from the live dirty checkout');

    const gain = makeRepo('r2-live-gain');
    assert.equal(run(provisionArgs('livegain'), gain).code, EXIT.ok);
    assert.equal(readRecord(gain, 'livegain').install, 'no install needed — the project declares no dependencies');
    writeFileSync(join(wtPath(gain, 'livegain'), 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } }));
    assert.equal(run(provisionArgs('livegain', ['--resume']), gain).code, EXIT.ok);
    assert.notEqual(readRecord(gain, 'livegain').install, 'no install needed — the project declares no dependencies',
      'gained dependencies REVOKE the proof from the live dirty checkout');
  });

  it('untracked-scratch-resume-completes', () => {
    const repo = makeRepo('r2-scratch');
    assert.equal(run(provisionArgs('scratch'), repo).code, EXIT.ok);
    writeFileSync(join(wtPath(repo, 'scratch'), 'scratch.txt'), 'session work\n');
    const resumed = run(provisionArgs('scratch', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.ok(existsSync(join(wtPath(repo, 'scratch'), 'scratch.txt')), 'untouched');
  });

  it('untracked-scratch-in-nested-dir-resume-completes', () => {
    // The porcelain collapse edge: `?? dir/` hid the leaves. There is no porcelain here at all.
    const repo = makeRepo('r2-scratch-nested');
    assert.equal(run(provisionArgs('nested'), repo).code, EXIT.ok);
    const deep = join(wtPath(repo, 'nested'), 'scratch/deep/deeper');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'note.md'), 'session work\n');
    const resumed = run(provisionArgs('nested', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
  });

  it('hook-created-dirt-resume-completes', () => {
    const repo = makeRepo('r2-hook-dirt');
    assert.equal(run(provisionArgs('hookdirt'), repo).code, EXIT.ok);
    writeFileSync(join(wtPath(repo, 'hookdirt'), 'hook-made.txt'), 'from a hook\n');
    const resumed = run(provisionArgs('hookdirt', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
  });

  it('hook-dirt-first-provision-recovers-via-resume', () => {
    // The flow consequence: a post-checkout hook that dirties a fresh checkout used to wedge the
    // worktree PERMANENTLY (both lanes refused at the same blanket verify). The fresh lane still
    // refuses (D2, conservative) — but the kept worktree's stated recovery is now real.
    const repo = makeRepo('r2-hook-wedge');
    const hook = installHook(repo, 'echo dirt > "$PWD/hook-dirt.txt"');
    const first = run(provisionArgs('hookwedge'), repo);
    assert.equal(first.code, EXIT.stop, 'the fresh lane still refuses hook dirt');
    assert.match(first.errText, /post-provision verify failed/);
    rmSync(hook);
    const resumed = run(provisionArgs('hookwedge', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, `the kept worktree now completes via --resume: ${resumed.errText}`);
    assert.ok(existsSync(join(wtPath(repo, 'hookwedge'), 'hook-dirt.txt')), 'the hook content is left alone');
  });

  it('renamed-tracked-file-resume-completes', () => {
    // The porcelain rename-structure edge, gone by construction.
    const repo = makeRepo('r2-rename');
    assert.equal(run(provisionArgs('rename'), repo).code, EXIT.ok);
    const wt = wtPath(repo, 'rename');
    sh(['mv', 'README.md', 'READYOU.md'], wt);
    const resumed = run(provisionArgs('rename', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
  });

  it('status-config-cannot-steer-resume-verify', () => {
    // `status.showUntrackedFiles=no` empties porcelain output. The per-owned-path proof never
    // consults status, so a repo config cannot hide an OWNED failure.
    const repo = makeRepo('r2-status-config');
    assert.equal(run(provisionArgs('statuscfg'), repo).code, EXIT.ok);
    const wt = wtPath(repo, 'statuscfg');
    sh(['config', 'status.showUntrackedFiles', 'no'], wt);
    deIgnore(repo, '/AGENTS.md');
    const resumed = run(provisionArgs('statuscfg', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop, 'the owned leaf still fails its lane proof');
    assert.ok(resumed.errText.includes('AGENTS.md'), resumed.errText);
  });

  it('glob-shaped-owned-path-probes-literally', () => {
    // D11, both directions. The discriminator is a TRACKED session sibling: live-probed on git
    // 2.43, `check-ignore` without --no-index answers for a name that GLOB-matches a tracked path,
    // so a magic-named owned leaf would read "not ignored" purely because `notes.json` is tracked.
    // Its own lane must be decided literally — and the session sibling must never be named.
    const repo = makeRepo('r2-literal');
    writeFileSync(join(repo, 'docs/ai/no[t]es.json'), '{}\n');
    assert.equal(run(provisionArgs('literal'), repo).code, EXIT.ok);
    const wt = wtPath(repo, 'literal');
    writeFileSync(join(wt, 'docs/ai/notes.json'), '{"session":true}\n');
    sh(['add', '-f', '--', 'docs/ai/notes.json'], wt);
    const stillFine = run(provisionArgs('literal', ['--resume']), repo);
    assert.equal(stillFine.code, EXIT.ok,
      `the owned leaf stays IGNORED on its own name, whatever a tracked sibling does: ${stillFine.errText}`);
    // Now the owned leaf itself loses its ignore rule: it — and only it — fails.
    deIgnore(repo, '/docs/ai/');
    const resumed = run(provisionArgs('literal', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes('docs/ai/no[t]es.json'), `the magic-named owned leaf is named: ${resumed.errText}`);
    assert.doesNotMatch(resumed.errText, /docs\/ai\/notes\.json \(/,
      'the SESSION sibling is never listed as a finding');
  });

  it('mixed-tracked-and-untracked-descendants-under-owned-dir', () => {
    // Leaves are probed individually: a tracked one passes, an untracked one fails, and SESSION
    // descendants under the same directory are never enumerated (no subtree aggregation exists).
    const repo = makeRepo('r2-mixed-descendants');
    writeFileSync(join(repo, 'docs/ai/second.json'), '{}\n');
    assert.equal(run(provisionArgs('mixdesc'), repo).code, EXIT.ok);
    const wt = wtPath(repo, 'mixdesc');
    writeFileSync(join(wt, 'docs/ai/session-note.md'), 'session\n');
    deIgnore(repo, '/docs/ai/');
    sh(['add', '-f', '--', 'docs/ai/second.json'], wt);
    const resumed = run(provisionArgs('mixdesc', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes('docs/ai/gates.json'), 'the untracked owned leaf is named');
    assert.doesNotMatch(resumed.errText, /docs\/ai\/second\.json/, 'the TRACKED owned leaf passes its lane');
    assert.doesNotMatch(resumed.errText, /session-note/, 'a SESSION descendant is never listed');
  });

  it('owned-path-untracked-lane-stops-with-surgical-recovery', () => {
    const repo = makeRepo('r2-untracked-owned');
    assert.equal(run(provisionArgs('untrowned'), repo).code, EXIT.ok);
    deIgnore(repo, '/AGENTS.md');
    const resumed = run(provisionArgs('untrowned', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.match(resumed.errText, /AGENTS\.md: restore the ignore rule covering it in this worktree/,
      'a mandatory surface keeps restore-ignore as its only convergent fix');
    assert.doesNotMatch(resumed.errText, /\brm\b|--abandon/, 'no removal command is ever derived');
    assert.ok(resumed.errText.includes(RESUME_VERIFY_RULE), 'the rule rides every resume-verify STOP');
  });

  it('kept-outcome-stop-never-advises-removal', () => {
    // The node_modules link is a KEPT node this attempt did not create; removing it is
    // non-convergent (the next resume re-places it), so the advice never says so.
    // Declared dependencies keep the symlink lane live: a dependency-free checkout short-circuits
    // before it and places no link at all.
    const repo = makeRepo('r2-kept-node', { pkg: { name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } } });
    mkdirSync(join(repo, 'node_modules/left'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/left/index.js'), 'x\n');
    assert.equal(run(provisionArgs('keptnode'), repo).code, EXIT.ok);
    deIgnore(repo, '/node_modules');
    const resumed = run(provisionArgs('keptnode', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes('node_modules (node-modules-link, kept)'), resumed.errText);
    assert.match(resumed.errText, /restore the ignore rule/);
    assert.doesNotMatch(resumed.errText, /\brm\b|remove it/, 'a kept node is never advised away');
  });

  it('untracked-owned-stop-recovery-converges', () => {
    // Follow the advice: the next resume passes AND land's leftover probe finds nothing (the
    // end-to-end bar — convergence through land preflight, not merely the next resume).
    const repo = makeRepo('r2-converge');
    assert.equal(run(provisionArgs('converge'), repo).code, EXIT.ok);
    const before = readFileSync(excludeFile(repo), 'utf8');
    deIgnore(repo, '/AGENTS.md');
    assert.equal(run(provisionArgs('converge', ['--resume']), repo).code, EXIT.stop);
    writeFileSync(excludeFile(repo), before); // the named recovery: restore the ignore rule
    const again = run(provisionArgs('converge', ['--resume']), repo);
    assert.equal(again.code, EXIT.ok, `the advice converges: ${again.errText}`);
    const leftovers = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'],
      { cwd: wtPath(repo, 'converge'), encoding: 'utf8' });
    assert.equal(leftovers.status, 0, leftovers.stderr);
    assert.equal(leftovers.stdout, '', 'land preflight finds no untracked leftover either');
  });

  it('a de-ignored vscode settings file from an earlier run still fails its lane', () => {
    // The door skips WRITING when the path is no longer ignored, but a destination an earlier run
    // placed must still be PROVEN: otherwise the resume completes and leaves a land-blocking file.
    const repo = makeRepo('r2-vscode-deignored', { excludes: [...EXCLUDES, '/.vscode/'], vscode: true });
    assert.equal(run(provisionArgs('vscodedeig'), repo).code, EXIT.ok);
    assert.ok(existsSync(join(wtPath(repo, 'vscodedeig'), '.vscode/settings.json')), 'the first run wrote it');
    const before = readHandoff(repo, 'vscodedeig');
    deIgnore(repo, '/.vscode/');
    const resumed = run(provisionArgs('vscodedeig', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop, 'the owned path is proven even though the door skipped the write');
    assert.ok(resumed.errText.includes('.vscode/settings.json (vscode-settings, kept) — untracked'), resumed.errText);
    assert.match(resumed.errText, /restore the ignore rule/);
    assert.ok(resumed.errText.includes(RESUME_VERIFY_RULE));
    assert.equal(readHandoff(repo, 'vscodedeig'), before, 'prior record bytes intact');
  });

  it('include-root-recovery-converges-end-to-end', () => {
    // Follow the advice for real: move the whole include destination OUT of the worktree and drop
    // the flag — the next resume passes AND land's leftover probe finds nothing.
    const repo = makeRepo('r2-include-converge');
    mkdirSync(join(repo, 'notes'), { recursive: true });
    writeFileSync(join(repo, 'notes/note.md'), '# note\n');
    writeFileSync(join(repo, '.git/info/exclude'), [...EXCLUDES, '/notes/'].join('\n'));
    assert.equal(run(provisionArgs('incconv', ['--include', 'notes']), repo).code, EXIT.ok);
    const wt = wtPath(repo, 'incconv');
    writeFileSync(join(wt, 'notes/foreign.md'), 'session work\n');
    const salvaged = join(TMP, 'salvaged-notes');
    renameSync(join(wt, 'notes'), salvaged);
    const again = run(provisionArgs('incconv', ['--resume']), repo);
    assert.equal(again.code, EXIT.ok, `dropping the flag after relocating converges: ${again.errText}`);
    assert.equal(readFileSync(join(salvaged, 'foreign.md'), 'utf8'), 'session work\n', 'the relocated content is intact');
    const leftovers = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: wt, encoding: 'utf8' });
    assert.equal(leftovers.status, 0, leftovers.stderr);
    assert.equal(leftovers.stdout, '', 'land preflight finds no orphaned leftover');
  });

  it('failed-resume-verify-leaves-prior-record-bytes', () => {
    const repo = makeRepo('r2-prior-bytes');
    assert.equal(run(provisionArgs('priorbytes'), repo).code, EXIT.ok);
    const before = readHandoff(repo, 'priorbytes');
    // The dirty edit is the MANIFEST, so a refresh that ran would write DIFFERENT record bytes.
    writeFileSync(join(wtPath(repo, 'priorbytes'), 'package.json'),
      JSON.stringify({ name: 'r', version: '1.0.0', dependencies: { left: '^1.0.0' } }));
    deIgnore(repo, '/AGENTS.md');
    const resumed = run(provisionArgs('priorbytes', ['--resume']), repo);
    assert.equal(resumed.code, EXIT.stop, 'the untracked-owned STOP survives the flip');
    assert.equal(readHandoff(repo, 'priorbytes'), before, 'a failed resume leaves the PRIOR record bytes');
  });
});

// ── the first-provision visibility pin (D2, real git) ──────────────────────────────────

describe('slice R2 — the first-provision blanket verify sees untracked dirt (real git)', () => {
  it('status-config-cannot-blind-first-provision-verify', () => {
    // `status.showUntrackedFiles=no` EMPTIES porcelain output, so a repo config could silently
    // turn the strict first-provision verify into a no-op. Its untracked visibility is explicit.
    const repo = makeRepo('r2-blind-fresh');
    sh(['config', 'status.showUntrackedFiles', 'no'], repo);
    const hook = installHook(repo, 'echo dirt > "$PWD/hook-dirt.txt"');
    const first = run(provisionArgs('blindfresh'), repo);
    rmSync(hook);
    assert.equal(first.code, EXIT.stop, 'repo config cannot hide dirt from the first-provision verify');
    assert.match(first.errText, /post-provision verify failed/);
    assert.match(first.errText, /hook-dirt\.txt/, 'the hidden untracked path is named');
  });
});

// ── scope, probe errors, and ordering (injected git) ───────────────────────────────────

describe('slice R2 — the verifier scope and its fail-closed lanes (injected git)', () => {
  it('session-paths-are-never-probed', () => {
    const main = makeMockRepo('r2-scope');
    const calls = [];
    let recording = false;
    const git = makeMockGit(main, {
      overrides: (args, cwd) => {
        if (recording) calls.push({ args, cwd });
        return null;
      },
    });
    const first = runMock(mockArgs('scope'), main, git);
    assert.equal(first.code, EXIT.ok, first.errText);
    const wt = join(main, '..', `${basename(main)}--scope`);
    writeFileSync(join(wt, 'session-note.md'), 'session work\n');
    mkdirSync(join(wt, 'session-dir'), { recursive: true });
    writeFileSync(join(wt, 'session-dir/inner.md'), 'session work\n');
    recording = true;
    const resumed = runMock(mockArgs('scope', ['--resume']), main, git);
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    const inWorktree = calls.filter((c) => c.cwd === wt);
    assert.equal(inWorktree.filter((c) => c.args[0] === 'status').length, 0,
      'the resume lane runs no git status at all');
    const mentionsSession = inWorktree.filter((c) => c.args.some((a) => String(a).includes('session-')));
    assert.deepEqual(mentionsSession, [], 'no session path is ever probed');
  });

  it('tracked-probe-error-stops-without-recovery-command', () => {
    const { main, resumed } = provisionThenResume({
      name: 'r2-probe-err-tracked',
      slug: 'errtracked',
      arm: (args) => (isLaneProbeFor(args, 'AGENTS.md')
        ? { status: 128, stdout: '', stderr: 'boom: ls-files' }
        : null),
    });
    assert.equal(resumed.code, EXIT.stop);
    assert.match(resumed.errText, /lane unprovable: git ls-files failed: boom: ls-files/);
    assert.match(resumed.errText, /No recovery command is offered/);
    assert.doesNotMatch(resumed.errText, /restore the ignore rule|salvage|relocate/,
      'an unprovable lane withholds every recovery command');
    assert.ok(existsSync(join(main, '..', `${basename(main)}--errtracked`, 'docs/plans', handoffBasename('errtracked'))));
  });

  it('ignored-probe-error-after-tracked-negative-stops', () => {
    const { resumed } = provisionThenResume({
      name: 'r2-probe-err-ignore',
      slug: 'errignore',
      arm: (args) => (isIgnoreProbeFor(args, 'AGENTS.md')
        ? { status: 128, stdout: '', stderr: 'boom: check-ignore' }
        : null),
    });
    assert.equal(resumed.code, EXIT.stop);
    assert.match(resumed.errText, /lane unprovable: git check-ignore failed: boom: check-ignore/);
    assert.match(resumed.errText, /No recovery command is offered/);
  });

  it('include-leaf-untracked-lane-names-the-droppable-recovery', () => {
    // The include DOOR proves the include ROOT ignored; the VERIFIER proves each placed LEAF. The
    // STOP lists the exact failed leaf, but the RECOVERY is grouped on the include ROOT: dropping
    // the flag orphans every copy under it (cleanup derives ownership from record.includes), so
    // leaf-only advice would not converge. A KEPT sibling under the root forbids removal wording —
    // it may hold content this run did not create.
    const { resumed } = provisionThenResume({
      name: 'r2-include-recovery',
      slug: 'increc',
      extra: ['--include', 'notes'],
      arm: (args) => (isIgnoreProbeFor(args, 'notes/note.md') ? { status: 1, stdout: '', stderr: '' } : null),
    });
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes('notes/note.md (include-leaf, kept)'), resumed.errText);
    assert.doesNotMatch(resumed.errText, /notes\/sibling\.md \(/, 'only the FAILED leaf is listed');
    assert.match(resumed.errText, /notes: salvage or relocate the whole include destination root OUT of the worktree/,
      'the recovery is emitted once, on the include ROOT, and moves it OUT — an orphan left in place stops land');
    assert.match(resumed.errText, /drop `--include notes`/, 'and it pairs with dropping the source');
    assert.doesNotMatch(resumed.errText, /restore the ignore rule/, 'the droppable class gets its own advice');
  });

  it('include-root-recovery-never-derives-a-removal-over-foreign-content', () => {
    // The journal cannot see session content a user dropped inside the include destination, so no
    // derived `rm` over that root could ever be proven safe: the advice offers relocation only,
    // whatever the outcomes of the journaled leaves (here they are all `written`).
    const main = makeMockRepo('r2-include-foreign');
    let armed = false;
    const git = makeMockGit(main, {
      overrides: (args) => (armed && isIgnoreProbeFor(args, 'notes/note.md') ? { status: 1, stdout: '', stderr: '' } : null),
    });
    assert.equal(runMock(mockArgs('incfor', ['--include', 'notes']), main, git).code, EXIT.ok);
    const wt = join(main, '..', `${basename(main)}--incfor`);
    rmSync(join(wt, 'notes'), { recursive: true, force: true });
    armed = true;
    const resumed = runMock(mockArgs('incfor', ['--include', 'notes', '--resume']), main, git);
    assert.equal(resumed.code, EXIT.stop);
    assert.ok(resumed.errText.includes('notes/note.md (include-leaf, written)'), resumed.errText);
    assert.match(resumed.errText, /salvage or relocate the whole include destination root OUT of the worktree/);
    assert.doesNotMatch(resumed.errText, /\bremove\b|\brm\b/,
      'no removal is ever derived over a root whose full contents provision cannot prove it owns');
    // A foreign descendant is present and survives untouched: the advice never claimed it.
    writeFileSync(join(wt, 'notes/foreign.md'), 'session work\n');
    const again = runMock(mockArgs('incfor', ['--include', 'notes', '--resume']), main, git);
    assert.equal(again.code, EXIT.stop);
    assert.doesNotMatch(again.errText, /foreign\.md/, 'the foreign descendant is never listed or claimed');
    assert.equal(readFileSync(join(wt, 'notes/foreign.md'), 'utf8'), 'session work\n', 'and never touched');
  });

  it('descendant-only-ls-files-output-is-not-tracked-proof', () => {
    // Live-probed on git 2.43: a pathspec naming a DIRECTORY lists its tracked DESCENDANTS, so a
    // non-empty result proves nothing about the probed path itself. Only a byte-exact field does.
    const { resumed } = provisionThenResume({
      name: 'r2-descendant-proof',
      slug: 'descproof',
      arm: (args) => {
        if (isLaneProbeFor(args, 'AGENTS.md')) return { status: 0, stdout: 'AGENTS.md/inner.md\0', stderr: '' };
        if (isIgnoreProbeFor(args, 'AGENTS.md')) return { status: 1, stdout: '', stderr: '' };
        return null;
      },
    });
    assert.equal(resumed.code, EXIT.stop, 'a descendant-only result must fall through to the untracked STOP');
    assert.ok(resumed.errText.includes('AGENTS.md (copy-set-leaf, kept) — untracked'), resumed.errText);
  });

  it('refused-owned-dirt-stays-refused-across-resumes', () => {
    // The legalization tombstone: a refused state re-refuses deterministically. The {path · lane ·
    // verdict} triple is stable, while the ADVICE honestly follows the outcome written → kept.
    const main = makeMockRepo('r2-legalization');
    let armed = false;
    const git = makeMockGit(main, {
      overrides: (args) => (armed && isIgnoreProbeFor(args, 'AGENTS.md') ? { status: 1, stdout: '', stderr: '' } : null),
    });
    assert.equal(runMock(mockArgs('legal'), main, git).code, EXIT.ok);
    const wt = join(main, '..', `${basename(main)}--legal`);
    rmSync(join(wt, 'AGENTS.md'));
    armed = true;
    const firstFail = runMock(mockArgs('legal', ['--resume']), main, git);
    const secondFail = runMock(mockArgs('legal', ['--resume']), main, git);
    assert.equal(firstFail.code, EXIT.stop);
    assert.equal(secondFail.code, EXIT.stop);
    assert.ok(firstFail.errText.includes('AGENTS.md (copy-set-leaf, written) — untracked'),
      `the first run created the node: ${firstFail.errText}`);
    assert.ok(secondFail.errText.includes('AGENTS.md (copy-set-leaf, kept) — untracked'),
      `the second run kept it: ${secondFail.errText}`);
    for (const text of [firstFail.errText, secondFail.errText]) {
      assert.match(text, /AGENTS\.md: restore the ignore rule/, 'the same convergent fix both times');
      assert.doesNotMatch(text, /\brm\b/, 'never a removal command, in either outcome');
    }
  });

  it('record-write-follows-the-resume-verify', () => {
    // The R1 ordering spy for the RESUME lane, re-homed onto the per-owned-path proof: the record
    // refresh is still the LAST step, after the verify.
    const main = makeMockRepo('r2-order');
    const order = [];
    let recording = false;
    const git = makeMockGit(main, {
      overrides: (args) => {
        if (recording && args[0] === 'ls-files' && args.some((a) => String(a).startsWith(':(literal)'))) order.push('verify');
        return null;
      },
    });
    assert.equal(runMock(mockArgs('order'), main, git).code, EXIT.ok);
    recording = true;
    const resumed = runMock(mockArgs('order', ['--resume']), main, git, {
      rename: (src, dst) => {
        if (basename(dst).startsWith('handoff-')) order.push('record');
        return renameSync(src, dst);
      },
    });
    assert.equal(resumed.code, EXIT.ok, resumed.errText);
    assert.ok(order.indexOf('verify') !== -1 && order.lastIndexOf('record') !== -1);
    assert.ok(order.indexOf('verify') < order.lastIndexOf('record'),
      `verify → record refresh, got ${order.join(',')}`);
  });
});

// ── the mode-doc contract pins (spec-first — authored WITH the doc edit) ───────────────

describe('slice R2 — mode-doc pins', () => {
  const doc = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'modes', 'worktrees.md'), 'utf8');

  it('the mode doc states the resume-verify contract verbatim', () => {
    assert.ok(doc().includes(RESUME_VERIFY_RULE), 'the exported rule constant renders into the contract doc');
  });

  it('the mode doc classifies record fields as identity / facts / attestation', () => {
    const text = doc();
    assert.ok(text.includes('IDENTITY (`slug`, `branch`, and the seeded plan name — a mismatch STOPs)'),
      'only slug, branch and the seeded plan name are resume identity');
    assert.ok(text.includes('that never authorize a resume (`include`, `node_modules`, `vscode-settings`)'),
      'the recorded provision facts are stated as non-authorizing (the D5 lock)');
  });
});

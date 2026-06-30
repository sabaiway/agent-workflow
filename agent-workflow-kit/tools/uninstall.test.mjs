import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  buildPlan,
  executePlan,
  formatPlan,
  parseArgs,
  SAFE_REMOVE,
  MANAGED_MARKER,
  REPORT_ONLY,
  STOP,
  UNINSTALL_STOP,
} from './uninstall.mjs';
import { OK } from './family-registry.mjs';

// ── synthetic family rows (the surveyFamily shape) ─────────────────────────────
const row = (name, kind, over = {}) => ({
  name, kind, installed: true, skillDir: `/skills/${name}`, manifestState: OK, version: '1.0.0', ...over,
});

const KIT = row('agent-workflow-kit', 'composition-root');
const MEMORY = row('agent-workflow-memory', 'memory-substrate');
const ENGINE = row('agent-workflow-engine', 'methodology-engine');
const CODEX = row('codex-cli-bridge', 'execution-backend');
const ANTIGRAVITY = row('antigravity-cli-bridge', 'execution-backend');

const find = (items, surface, member) => items.find((i) => i.surface === surface && (member ? i.member === member : true));

// A path-keyed mock fs. `symlinks` maps a path → its (absolute) link target; `files` maps path →
// contents; `dirs` is a set of present directories. realpath is identity (no symlinked bindir here).
const mockFs = ({ symlinks = {}, files = {}, dirs = [], manifests = {} } = {}) => {
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const present = (p) => p in symlinks || p in files || dirs.includes(p);
  return {
    exists: (p) => present(p),
    stat: (p) => ({ isFile: () => p in files, isDirectory: () => dirs.includes(p) }),
    lstat: (p) => {
      if (p in symlinks) return { isSymbolicLink: () => true, isFile: () => false };
      if (present(p)) return { isSymbolicLink: () => false, isFile: () => p in files };
      throw enoent(p);
    },
    readlink: (p) => { if (p in symlinks) return symlinks[p]; throw enoent(p); },
    readFile: (p) => { if (p in files) return files[p]; throw enoent(p); },
    realpath: (p) => p,
    readManifest: (skillDir) => { if (skillDir in manifests) return manifests[skillDir]; throw enoent(skillDir); },
  };
};

const CODEX_MANIFEST = {
  name: 'codex-cli-bridge', kind: 'execution-backend',
  roles: {
    execute: { cmd: 'codex-exec', source: 'bin/codex-exec.sh' },
    review: { cmd: 'codex-review', source: 'bin/codex-review.sh' },
  },
};

const AGY_MANIFEST = {
  name: 'antigravity-cli-bridge', kind: 'execution-backend',
  roles: {
    review: { cmd: 'agy-review', source: 'bin/agy-review.sh' },
    probe: { cmd: 'agy-run', source: 'bin/agy.sh' },
  },
};

// ── buildPlan: SKILL axis ──────────────────────────────────────────────────────

describe('buildPlan — skill axis', () => {
  it('plans a proven-managed composition-root for removal, with no shared-global warning', () => {
    const { items } = buildPlan({ family: [KIT] }, mockFs());
    const skill = find(items, 'skill');
    assert.equal(skill.class, SAFE_REMOVE);
    assert.equal(skill.path, '/skills/agent-workflow-kit');
    assert.equal(skill.warn, null);
  });

  it('warns that a shared global (memory/engine/bridge) may be used by other projects', () => {
    const { items } = buildPlan({ family: [MEMORY, ENGINE] }, mockFs());
    assert.match(find(items, 'skill', 'agent-workflow-memory').warn, /GLOBAL skill/);
    assert.match(find(items, 'skill', 'agent-workflow-engine').warn, /GLOBAL skill/);
  });

  it('STOPs (never removes) a present-but-not-ours skill dir', () => {
    const foreign = row('agent-workflow-kit', 'composition-root', { manifestState: 'foreign' });
    const skill = find(buildPlan({ family: [foreign] }, mockFs()).items, 'skill');
    assert.equal(skill.class, STOP);
    assert.match(skill.reason, /not provably ours/);
  });

  it('skips a member that is not installed', () => {
    const { items } = buildPlan({ family: [row('agent-workflow-engine', 'methodology-engine', { installed: false, skillDir: null, manifestState: 'not-installed' })] }, mockFs());
    assert.equal(items.length, 0);
  });

  it('limits to a single member when `member` is given', () => {
    const { items } = buildPlan({ family: [KIT, MEMORY, ENGINE], member: 'agent-workflow-memory' }, mockFs());
    assert.deepEqual(items.map((i) => i.member), ['agent-workflow-memory']);
  });
});

// ── buildPlan: bridge wrappers ─────────────────────────────────────────────────

describe('buildPlan — bridge wrappers', () => {
  const bindir = '/home/u/.local/bin';
  const skillDir = '/skills/codex-cli-bridge';

  it('reverses a wrapper symlink that points at our source (managed-marker)', () => {
    const fs = mockFs({
      manifests: { [skillDir]: CODEX_MANIFEST },
      symlinks: {
        [join(bindir, 'codex-exec')]: join(skillDir, 'bin/codex-exec.sh'),
        [join(bindir, 'codex-review')]: join(skillDir, 'bin/codex-review.sh'),
      },
    });
    const { items } = buildPlan({ family: [CODEX], bindir }, fs);
    const wrappers = items.filter((i) => i.surface === 'wrapper');
    assert.equal(wrappers.length, 2);
    assert.ok(wrappers.every((w) => w.class === MANAGED_MARKER));
    assert.equal(find(wrappers, 'wrapper').expectedSrc, join(skillDir, 'bin/codex-exec.sh'));
  });

  it('antigravity 2.0.0: classifies BOTH managed wrappers (agy-review + agy-run) for removal', () => {
    // The teardown surface widened from one wrapper to two; uninstall derives them dynamically from the
    // installed manifest (deriveLinks), so this pins that both agy-review and agy-run are reversed.
    const agySkill = '/skills/antigravity-cli-bridge';
    const fs = mockFs({
      manifests: { [agySkill]: AGY_MANIFEST },
      symlinks: {
        [join(bindir, 'agy-review')]: join(agySkill, 'bin/agy-review.sh'),
        [join(bindir, 'agy-run')]: join(agySkill, 'bin/agy.sh'),
      },
    });
    const wrappers = buildPlan({ family: [ANTIGRAVITY], bindir }, fs).items.filter((i) => i.surface === 'wrapper');
    assert.equal(wrappers.length, 2);
    assert.ok(wrappers.every((w) => w.class === MANAGED_MARKER));
    assert.deepEqual(
      wrappers.map((w) => w.path).sort(),
      [join(bindir, 'agy-review'), join(bindir, 'agy-run')].sort(),
    );
  });

  it('STOPs on a foreign wrapper symlink (points elsewhere) — never removed', () => {
    const fs = mockFs({
      manifests: { [skillDir]: CODEX_MANIFEST },
      symlinks: {
        [join(bindir, 'codex-exec')]: '/somewhere/else/codex-exec',
        [join(bindir, 'codex-review')]: join(skillDir, 'bin/codex-review.sh'),
      },
    });
    const wrappers = buildPlan({ family: [CODEX], bindir }, fs).items.filter((i) => i.surface === 'wrapper');
    assert.equal(wrappers.find((w) => w.path.endsWith('codex-exec')).class, STOP);
    assert.equal(wrappers.find((w) => w.path.endsWith('codex-review')).class, MANAGED_MARKER);
  });

  it('emits no wrapper item when the link is absent', () => {
    const fs = mockFs({ manifests: { [skillDir]: CODEX_MANIFEST } }); // no symlinks present
    const wrappers = buildPlan({ family: [CODEX], bindir }, fs).items.filter((i) => i.surface === 'wrapper');
    assert.equal(wrappers.length, 0);
  });
});

// ── buildPlan: project deploy axis ─────────────────────────────────────────────

describe('buildPlan — project deploy axis', () => {
  const dir = '/proj';
  const project = { dir, deployed: true, docsAiPresent: true, hiddenFence: true, stamps: [] };

  const projectFs = (extra = {}) => mockFs({
    files: {
      [join(dir, '.git/hooks/pre-commit')]: '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\nset -e\n',
      [join(dir, '.claude/settings.json')]: '{ "includeCoAuthoredBy": false }',
      ...extra.files,
    },
    dirs: [join(dir, 'docs/ai'), join(dir, 'docs/plans'), ...(extra.dirs ?? [])],
  });

  it('plans the hidden fence + marker hook as managed-marker reversals', () => {
    const { items } = buildPlan({ family: [], project, projectDir: dir }, projectFs());
    assert.equal(find(items, 'fence').class, MANAGED_MARKER);
    assert.equal(find(items, 'hook').class, MANAGED_MARKER);
  });

  it('reports (never removes) an UNMARKED pre-commit hook', () => {
    const fs = mockFs({ files: { [join(dir, '.git/hooks/pre-commit')]: '#!/bin/sh\necho mine\n' } });
    const hook = find(buildPlan({ family: [], project: { ...project, hiddenFence: false }, projectDir: dir }, fs).items, 'hook');
    assert.equal(hook.class, REPORT_ONLY);
  });

  it('reports the settings.json includeCoAuthoredBy edit (never auto-edits)', () => {
    const settings = buildPlan({ family: [], project, projectDir: dir }, projectFs()).items.find((i) => i.surface === 'settings');
    assert.equal(settings.class, REPORT_ONLY);
  });

  it('reports velocity permissions.* in settings.json NON-COMMITTALLY (never auto-removed)', () => {
    const fs = projectFs({ files: { [join(dir, '.claude/settings.json')]: JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Bash(git status:*)'] } }) } });
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    const settings = plan.items.find((i) => i.surface === 'settings');
    assert.equal(settings.class, REPORT_ONLY);
    assert.match(settings.reason, /velocity profile seeded them/);
    assert.doesNotMatch(settings.reason, /includeCoAuthoredBy/);
    const out = formatPlan(plan);
    assert.match(out, /permissions\.defaultMode/);
    assert.ok(!/rm -rf .*settings\.json/.test(out), 'settings.json is never rm-ed');
  });

  it('reports BOTH the attribution edit and velocity permissions when both are present', () => {
    const fs = projectFs({ files: { [join(dir, '.claude/settings.json')]: JSON.stringify({ includeCoAuthoredBy: false, permissions: { allow: ['Bash(cat:*)'] } }) } });
    const settings = buildPlan({ family: [], project, projectDir: dir }, fs).items.find((i) => i.surface === 'settings');
    assert.equal(settings.class, REPORT_ONLY);
    assert.match(settings.reason, /includeCoAuthoredBy/);
    assert.match(settings.reason, /permissions\.(defaultMode|allow)/);
  });

  it('falls back to a substring probe on malformed settings JSON (no silent miss of either seam)', () => {
    const broken = '{ "includeCoAuthoredBy": false, "permissions": { "allow": ["Bash(ls:*)"] },, }'; // double comma → JSON.parse throws
    const fs = projectFs({ files: { [join(dir, '.claude/settings.json')]: broken } });
    const settings = buildPlan({ family: [], project, projectDir: dir }, fs).items.find((i) => i.surface === 'settings');
    assert.equal(settings.class, REPORT_ONLY);
    assert.match(settings.reason, /includeCoAuthoredBy/);
    assert.match(settings.reason, /permissions/);
  });

  it('reports docs/ai, AGENTS.md, CLAUDE.md, docs/plans as never-deleted', () => {
    const fs = projectFs({ files: { [join(dir, 'AGENTS.md')]: 'x', [join(dir, 'CLAUDE.md')]: 'x' } });
    const docs = buildPlan({ family: [], project, projectDir: dir }, fs).items.filter((i) => i.surface === 'docs');
    const paths = docs.map((d) => d.path).sort();
    assert.deepEqual(paths, [join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'), join(dir, 'docs/ai'), join(dir, 'docs/plans')].sort());
    assert.ok(docs.every((d) => d.class === REPORT_ONLY));
  });

  it('formatPlan prints rm + git rm guidance for the report-only set', () => {
    const plan = buildPlan({ family: [], project, projectDir: dir }, projectFs());
    const out = formatPlan(plan);
    assert.match(out, /KEEP \(do by hand\)/);
    assert.match(out, /git rm -r --cached/);
  });
});

// ── executePlan: guarded mutation ──────────────────────────────────────────────

describe('executePlan — guarded', () => {
  const okClassify = (reg) => ({ installed: true, manifestState: OK, skillDir: `/skills/${reg.name}` });

  const spyDeps = (over = {}) => {
    const calls = { removeTree: [], unlink: [], unhide: [], rmFile: [] };
    return {
      calls,
      deps: {
        classify: over.classify ?? okClassify,
        removeTree: (p) => { calls.removeTree.push(p); return 'removed'; },
        unlink: (p) => { calls.unlink.push(p); return 'unlinked'; },
        hideFootprint: (opts) => { calls.unhide.push(opts); return { action: 'unhidden' }; },
        rmFile: (p) => { calls.rmFile.push(p); },
        // fs for the wrapper preflight inspect (report 'ours') + the hook marker re-check (present + marked).
        lstat: () => ({ isSymbolicLink: () => true, isFile: () => false }),
        readlink: (p) => p.replace('/home/u/.local/bin/codex-exec', '/skills/codex-cli-bridge/bin/codex-exec.sh'),
        realpath: (p) => p,
        exists: () => true,
        readFile: () => '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\nset -e\n',
        ...over.deps,
      },
    };
  };

  const fullPlan = () => ({
    projectDir: '/proj',
    items: [
      { surface: 'skill', member: 'agent-workflow-kit', path: '/skills/agent-workflow-kit', class: SAFE_REMOVE },
      { surface: 'wrapper', member: 'codex-cli-bridge', path: '/home/u/.local/bin/codex-exec', expectedSrc: '/skills/codex-cli-bridge/bin/codex-exec.sh', class: MANAGED_MARKER },
      { surface: 'fence', path: '/proj/.git/info/exclude', class: MANAGED_MARKER },
      { surface: 'hook', path: '/proj/.git/hooks/pre-commit', class: MANAGED_MARKER },
      { surface: 'docs', path: '/proj/docs/ai', class: REPORT_ONLY },
    ],
  });

  it('--dry-run mutates nothing', () => {
    const { calls, deps } = spyDeps();
    const r = executePlan(fullPlan(), { dryRun: true }, deps);
    assert.equal(r.applied, false);
    assert.deepEqual([calls.removeTree, calls.unlink, calls.unhide, calls.rmFile], [[], [], [], []]);
  });

  it('without --yes mutates nothing (awaiting consent)', () => {
    const { calls, deps } = spyDeps();
    const r = executePlan(fullPlan(), {}, deps);
    assert.equal(r.applied, false);
    assert.equal(calls.removeTree.length, 0);
  });

  it('with --yes applies the auto-removable set and never touches report-only', () => {
    const { calls, deps } = spyDeps();
    const r = executePlan(fullPlan(), { yes: true }, deps);
    assert.equal(r.applied, true);
    assert.deepEqual(calls.removeTree, ['/skills/agent-workflow-kit']);
    assert.deepEqual(calls.unlink, ['/home/u/.local/bin/codex-exec']);
    // The fence is unhidden once for real (mutate) after being validated by a dry-run unhide (preflight).
    assert.ok(calls.unhide.some((o) => o.dryRun === true), 'fence validated by a dry-run unhide in preflight');
    assert.ok(calls.unhide.some((o) => !o.dryRun), 'fence unhidden for real in the mutate phase');
    assert.deepEqual(calls.rmFile, ['/proj/.git/hooks/pre-commit']);
    assert.equal(r.unhidden, true);
    assert.equal(r.hookRemoved, true);
    assert.equal(r.reported.length, 1); // the docs item, untouched
  });

  it('preflight STOPs (zero mutation) when a skill dir is no longer provably ours', () => {
    const { calls, deps } = spyDeps({ classify: () => ({ installed: true, manifestState: 'foreign', skillDir: '/skills/agent-workflow-kit' }) });
    assert.throws(() => executePlan(fullPlan(), { yes: true }, deps), (err) => err.code === UNINSTALL_STOP);
    assert.deepEqual([calls.removeTree, calls.unlink], [[], []]); // nothing mutated
  });

  it('preflight STOPs (zero mutation) when a wrapper turned foreign', () => {
    const { calls, deps } = spyDeps({ deps: { readlink: () => '/somewhere/foreign' } });
    assert.throws(() => executePlan(fullPlan(), { yes: true }, deps), (err) => err.code === UNINSTALL_STOP);
    assert.equal(calls.removeTree.length, 0);
  });

  it('a wrapper that merely VANISHED is benign — teardown proceeds (no abort)', () => {
    const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    const { calls, deps } = spyDeps({ deps: { lstat: (p) => (p.endsWith('codex-exec') ? enoent() : { isSymbolicLink: () => true, isFile: () => false }) } });
    const r = executePlan(fullPlan(), { yes: true }, deps);
    assert.equal(r.applied, true);
    assert.deepEqual(calls.removeTree, ['/skills/agent-workflow-kit']); // skill still removed
  });

  it('refuses (zero mutation) when the pre-commit hook lost OUR marker since the plan', () => {
    const { calls, deps } = spyDeps({ deps: { readFile: () => '#!/bin/sh\n# the user rewrote this hook\n' } }); // no marker
    assert.throws(() => executePlan(fullPlan(), { yes: true }, deps), (err) => err.code === UNINSTALL_STOP);
    assert.deepEqual([calls.removeTree, calls.rmFile], [[], []]); // nothing mutated
  });

  const planWithStop = () => ({
    projectDir: '/proj',
    items: [
      { surface: 'skill', member: 'agent-workflow-kit', path: '/skills/agent-workflow-kit', class: SAFE_REMOVE },
      { surface: 'wrapper', member: 'codex-cli-bridge', path: '/home/u/.local/bin/codex-exec', class: STOP, reason: 'foreign symlink' },
    ],
  });

  it('a plan-time STOP (a not-ours surface) is reported + LEFT; the teardown still removes what IS ours (per-item, not global-abort)', () => {
    const { calls, deps } = spyDeps();
    const r = executePlan(planWithStop(), { yes: true }, deps);
    assert.equal(r.applied, true);
    assert.deepEqual(calls.removeTree, ['/skills/agent-workflow-kit']); // ours removed
    assert.deepEqual(calls.unlink, []); // the foreign wrapper (STOP) is never touched
    assert.ok(r.reported.some((i) => i.class === STOP), 'the STOP surface is surfaced, not silently dropped');
  });

  it('--dry-run never mutates, even with a STOP present', () => {
    const { calls, deps } = spyDeps();
    const r = executePlan(planWithStop(), { dryRun: true }, deps);
    assert.equal(r.applied, false);
    assert.deepEqual([calls.removeTree, calls.unlink], [[], []]);
  });

  it('a malformed fence is caught by the preflight dry-run unhide → abort before any mutation (codex #2)', () => {
    const { calls, deps } = spyDeps({ deps: { hideFootprint: (opts) => { if (opts.dryRun) throw new Error('malformed managed block'); return { action: 'unhidden' }; } } });
    assert.throws(() => executePlan(fullPlan(), { yes: true }, deps), (err) => err.code === UNINSTALL_STOP);
    assert.deepEqual([calls.removeTree, calls.unlink, calls.rmFile], [[], [], []]); // fence threw in preflight → nothing mutated
  });
});

// ── formatPlan: report-only guidance (codex #4) ─────────────────────────────────

describe('formatPlan — report-only guidance', () => {
  it('settings.json gets EDIT guidance (remove the key), never `rm`', () => {
    const plan = { projectDir: '/proj', items: [{ surface: 'settings', path: '/proj/.claude/settings.json', class: REPORT_ONLY, reason: 'x' }] };
    const out = formatPlan(plan);
    assert.match(out, /edit .*settings\.json.* remove the "includeCoAuthoredBy"/);
    assert.ok(!/rm -rf .*settings\.json/.test(out), 'settings.json is never rm-ed');
  });

  it('paths are shell-quoted in the printed rm/git-rm commands', () => {
    const plan = { projectDir: '/p', items: [{ surface: 'docs', path: '/p/docs/ai', class: REPORT_ONLY, reason: 'x' }] };
    const out = formatPlan(plan);
    assert.match(out, /rm -rf '\/p\/docs\/ai'/);
    assert.match(out, /git rm -r --cached '\/p\/docs\/ai'/);
  });
});

// ── buildPlan: an underivable bridge manifest → STOP, not a silent half-removal (codex #3) ──────────

describe('buildPlan — underivable bridge', () => {
  it('emits a STOP for the skill (not SAFE_REMOVE) when deriveLinks throws on the bridge manifest', () => {
    const throwingFs = {
      readManifest: () => { throw new Error('corrupt manifest'); },
    };
    const codex = row('codex-cli-bridge', 'execution-backend');
    const items = buildPlan({ family: [codex], bindir: '/home/u/.local/bin' }, throwingFs).items;
    const skill = items.find((i) => i.surface === 'skill');
    assert.equal(skill.class, STOP);
    assert.ok(!items.some((i) => i.surface === 'skill' && i.class === SAFE_REMOVE));
    assert.ok(!items.some((i) => i.surface === 'wrapper'));
  });
});

// ── parseArgs: strict validation (codex #6) ─────────────────────────────────────

describe('parseArgs — strict', () => {
  it('accepts a clean whole-family teardown', () => {
    const a = parseArgs(['--dir', '/proj', '--dry-run']);
    assert.equal(a.bad, null);
    assert.equal(a.dir, '/proj');
    assert.equal(a.dryRun, true);
    assert.equal(a.member, undefined);
  });

  it('accepts a valid <member>', () => {
    assert.equal(parseArgs(['agent-workflow-memory', '--yes']).bad, null);
    assert.equal(parseArgs(['agent-workflow-memory']).member, 'agent-workflow-memory');
  });

  it('rejects an unknown flag (a typo cannot silently slip past)', () => {
    assert.match(parseArgs(['--yes', '--frce']).bad, /unknown option/);
  });

  it('rejects an unknown member name', () => {
    assert.match(parseArgs(['memory']).bad, /unknown member "memory"/);
  });

  it('rejects --dir / --bindir without a value', () => {
    assert.match(parseArgs(['--dir']).bad, /--dir requires/);
    assert.match(parseArgs(['--dir', '--yes']).bad, /--dir requires/);
    assert.match(parseArgs(['--bindir']).bad, /--bindir requires/);
  });

  it('rejects more than one positional', () => {
    assert.match(parseArgs(['agent-workflow-kit', 'agent-workflow-memory']).bad, /at most one/);
  });
});

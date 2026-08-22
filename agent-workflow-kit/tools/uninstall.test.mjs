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
// The registration constants + the derived allow rules, read from the leaf the planner itself asks —
// a fixture spelling its own server path or rule strings would drift off what is being reported.
import { DEFAULT_SERVER_PATH, MCP_JSON_REL, SERVER_NAME, allowRulesFor } from './mcp-registration.mjs';

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
      // isDirectory is part of what a stat IS — a mock that omits it lets a guard written against the
      // real fs read as untestable, or worse, get written around the omission.
      if (p in symlinks) return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      if (present(p)) return { isSymbolicLink: () => false, isFile: () => p in files, isDirectory: () => dirs.includes(p) };
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

  it('fold: a symlinked or non-regular pre-commit hook is REPORTED unread, never followed', () => {
    const hookPath = join(dir, '.git/hooks/pre-commit');
    for (const [label, stat] of Object.entries({
      symlink: { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false },
      'device or FIFO': { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false },
    })) {
      const base = projectFs();
      const fs = {
        ...base,
        lstat: (p) => (p === hookPath ? stat : base.lstat(p)),
        readFile: (p) => {
          if (p === hookPath) assert.fail(`${label}: a non-regular hook must never be read`);
          return base.readFile(p);
        },
      };
      const item = find(buildPlan({ family: [], project, projectDir: dir }, fs).items, 'hook');
      assert.ok(item, label);
      assert.equal(item.class, REPORT_ONLY, label);
      assert.match(item.reason, /not a regular file/i, label);
      assert.ok(item.hand && !/^rm /.test(item.hand), `${label}: and the hand line is an inspection, never a removal`);
    }
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

  it('gate hook, WIRED ordering: the settings seam is reported and the placed file is preserved as one bundle', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const wired = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-workflow-gates.mjs"', timeout: 30 }] }] },
    });
    const fs = {
      ...projectFs({ files: { [join(dir, '.claude/settings.json')]: wired, [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' } }),
      bundlePath: '/bundle/hook.mjs',
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    const seam = plan.items.find((i) => i.surface === 'settings');
    assert.equal(seam.class, REPORT_ONLY);
    assert.match(seam.reason, /gate-approval hook/);
    assert.match(seam.hand, /remove the PreToolUse entry/);
    const file = find(plan.items, 'gate-hook');
    assert.equal(file.class, REPORT_ONLY);
    assert.match(file.reason, /still WIRED .* re-run uninstall to remove the file/);
    // executing the plan removes NOTHING of the hook bundle (report-only is never mutated)
    const rmFileCalls = [];
    executePlan(plan, { yes: true }, { ...fs, rmFile: (p) => rmFileCalls.push(p), removeTree: () => 'removed', unlink: () => 'unlinked', hideFootprint: () => ({ action: 'unhidden' }) });
    assert.equal(rmFileCalls.includes(hookPath), false);
  });

  it('gate hook, UNWIRED ordering: a byte-identical file is removed and an empty hooks dir is cleaned', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const removedFiles = [];
    const removedTrees = [];
    const filesLeft = new Set([hookPath]);
    const fs = {
      ...projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [join(dir, '.claude/hooks')] }),
      bundlePath: '/bundle/hook.mjs',
      readdir: () => [...filesLeft].filter((p) => p !== hookPath).map(() => 'x'),
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    const file = find(plan.items, 'gate-hook');
    assert.equal(file.class, SAFE_REMOVE);
    assert.match(file.reason, /byte-identical to the current bundle/);
    const result = executePlan(plan, { yes: true }, {
      ...fs,
      rmFile: (p) => { removedFiles.push(p); filesLeft.delete(p); },
      removeTree: (p) => { removedTrees.push(p); return 'removed'; },
      unlink: () => 'unlinked',
      hideFootprint: () => ({ action: 'unhidden' }),
    });
    assert.equal(result.gateHookRemoved, true);
    assert.equal(removedFiles.includes(hookPath), true);
    assert.equal(removedTrees.includes(join(dir, '.claude/hooks')), true);
  });

  it('gate hook: a symlink swapped in AFTER planning aborts the mutation (AD-011, zero changes)', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    // Plan sees a regular bundle-identical file (SAFE_REMOVE); at execute time lstat reports a symlink.
    let lstats = 0;
    const baseFs = projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [join(dir, '.claude/hooks')] });
    const planFs = { ...baseFs, bundlePath: '/bundle/hook.mjs' };
    const plan = buildPlan({ family: [], project, projectDir: dir }, planFs);
    assert.equal(find(plan.items, 'gate-hook').class, SAFE_REMOVE);
    const removedFiles = [];
    // Between the plan and execute, a symlink is swapped in at the hook path: the execute preflight
    // must lstat no-follow, see the symlink, and abort with ZERO mutations (never read-through +
    // remove it, and never partially remove earlier surfaces first).
    const execFs = {
      ...planFs,
      lstat: (p) => (p === hookPath ? { isSymbolicLink: () => true, isFile: () => false } : baseFs.lstat(p)),
      rmFile: (p) => removedFiles.push(p),
      removeTree: () => 'removed',
      unlink: () => 'unlinked',
      hideFootprint: () => ({ action: 'unhidden' }),
    };
    assert.throws(() => executePlan(plan, { yes: true }, execFs), (thrown) => thrown.code === UNINSTALL_STOP);
    assert.equal(removedFiles.includes(hookPath), false);
  });

  it('gate hook: a diverged (non-bundle) unwired file is reported, never removed', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const fs = {
      ...projectFs({ files: { [hookPath]: 'SOMETHING ELSE', ['/bundle/hook.mjs']: 'BUNDLE' } }),
      bundlePath: '/bundle/hook.mjs',
    };
    const file = find(buildPlan({ family: [], project, projectDir: dir }, fs).items, 'gate-hook');
    assert.equal(file.class, REPORT_ONLY);
    assert.match(file.reason, /not byte-identical/);
  });

  it('gate hook: a JSON-escaped path in the wired entry still counts as wired (file preserved)', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    // A valid settings entry whose command escapes the slashes: `.claude\/hooks\/…`. JSON.parse
    // decodes it back to `/`; a raw-text substring scan would MISS it and wrongly remove a still-
    // wired hook. This literal keeps the backslashes so JSON.parse sees the escape.
    const escaped = '{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node \\".claude\\/hooks\\/agent-workflow-gates.mjs\\"" } ] } ] } }';
    const fs = {
      ...projectFs({ files: { [join(dir, '.claude/settings.json')]: escaped, [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' } }),
      bundlePath: '/bundle/hook.mjs',
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    assert.equal(find(plan.items, 'gate-hook').class, REPORT_ONLY, 'escaped-path wiring must read as wired → file preserved');
    assert.match(find(plan.items, 'gate-hook').reason, /still WIRED/);
  });

  it('gate hook: a hand-wired entry in settings.local.json also counts as wired (file preserved)', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const wired = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/agent-workflow-gates.mjs' }] }] } });
    const fs = {
      ...projectFs({ files: { [join(dir, '.claude/settings.local.json')]: wired, [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' } }),
      bundlePath: '/bundle/hook.mjs',
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    const localSeam = plan.items.find((i) => i.surface === 'settings' && i.path.endsWith('settings.local.json'));
    assert.equal(localSeam.class, REPORT_ONLY);
    assert.equal(find(plan.items, 'gate-hook').class, REPORT_ONLY);
  });

  // ── the MCP registration's two seams (mode: mcp) ────────────────────────────
  // Both are REPORT_ONLY for the same reason the settings seam always was: `.mcp.json` may declare
  // servers this kit never placed, and the settings file may hold the user's own rules. The entry is
  // recognized through the registration LEAF's own decision, never a second copy of it here.
  const OUR_ENTRY = { type: 'stdio', command: 'node', args: [DEFAULT_SERVER_PATH] };
  const mcpJsonPath = join(dir, MCP_JSON_REL);

  it('reports the .mcp.json entry as REPORT_ONLY with the exact edit — never an rm', () => {
    const fs = projectFs({ files: { [mcpJsonPath]: JSON.stringify({ mcpServers: { [SERVER_NAME]: OUR_ENTRY } }) } });
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    const item = find(plan.items, 'mcp-json');
    assert.ok(item, 'a registered .mcp.json is reported');
    assert.equal(item.class, REPORT_ONLY);
    assert.match(item.reason, new RegExp(SERVER_NAME));
    assert.match(item.hand, /edit /);
    assert.ok(!/rm .*\.mcp\.json/.test(formatPlan(plan)), '.mcp.json is never rm-ed');
    // report-only is never mutated: a CONSENTED execution touches nothing of it. `{ yes: true }` is
    // load-bearing — without it executePlan returns at the preview branch and the claim is vacuous.
    const removed = [];
    executePlan(plan, { yes: true }, {
      ...fs,
      rmFile: (p) => removed.push(p),
      removeTree: (p) => removed.push(p),
      unlink: (p) => removed.push(p),
      hideFootprint: () => ({ action: 'unhidden' }), // the fence surface needs git; this test is about the .mcp.json one
    });
    assert.ok(!removed.includes(mcpJsonPath), 'the executor never removes a report-only surface');
  });

  it('a .mcp.json holding only FOREIGN servers produces no item at all', () => {
    const fs = projectFs({ files: { [mcpJsonPath]: JSON.stringify({ mcpServers: { other: { command: 'node', args: ['x.mjs'] } } }) } });
    assert.equal(find(buildPlan({ family: [], project, projectDir: dir }, fs).items, 'mcp-json'), undefined);
  });

  it('a SYMLINKED or device-MASKED .mcp.json is reported UNREAD — never followed, never parsed', () => {
    // Both classes reach the same arm because the classification is lstat-keyed: nothing is ever
    // opened, which is the property that matters for a FIFO as much as for a symlink.
    const classes = {
      symlink: { isSymbolicLink: () => true, isFile: () => false },
      'device mask': { isSymbolicLink: () => false, isFile: () => false },
    };
    for (const [label, stat] of Object.entries(classes)) {
      const base = projectFs();
      const fs = {
        ...base,
        exists: (p) => p === mcpJsonPath || base.exists(p),
        lstat: (p) => (p === mcpJsonPath ? stat : base.lstat(p)),
        readFile: (p) => {
          if (p === mcpJsonPath) assert.fail(`a ${label} at .mcp.json must never be read`);
          return base.readFile(p);
        },
      };
      const item = find(buildPlan({ family: [], project, projectDir: dir }, fs).items, 'mcp-json');
      assert.equal(item.class, REPORT_ONLY, label);
      assert.match(item.reason, /not a regular file/, label);
    }
  });

  // The same containment class the registration reader closed, at the teardown's OWN read site: path
  // resolution follows an intermediate symlink, so reading `.claude/settings.json` before classifying
  // `.claude` reports a file from outside the work tree. This guard covers all four settings seams.
  // "Not a directory" is the whole class, and every member of it is a path the reads below cannot
  // traverse: a symlink escapes the tree, and a device / FIFO / socket makes them ENOTDIR. Split in
  // two so each class states its own claim — and so each keeps the observed-red record minted for it.
  const CONTAINER_CLASSES = {
    symlink: { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false },
    'regular file': { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false },
    'device, FIFO or socket': { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false },
  };

  it('fold: a symlinked .claude is reported UNREAD — nothing inside a foreign container is read', () => {
    assertContainerReported({ symlink: CONTAINER_CLASSES.symlink });
  });

  it('fold: ANY non-directory .claude takes that same arm, with a hand line that fits a CONTAINER', () => {
    assertContainerReported(CONTAINER_CLASSES);
  });

  function assertContainerReported(classes) {
    const base = projectFs();
    const claudePath = join(dir, '.claude');
    for (const [label, stat] of Object.entries(classes)) {
      const fs = {
        ...base,
        exists: (p) => p === claudePath || base.exists(p),
        lstat: (p) => (p === claudePath ? stat : base.lstat(p)),
        readFile: (p) => {
          if (p.startsWith(`${claudePath}/`)) assert.fail(`${label}: a file inside a foreign container must never be read (${p})`);
          return base.readFile(p);
        },
      };
      const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
      const item = find(plan.items, 'claude-dir');
      assert.ok(item, `${label}: the container is reported rather than silently skipped`);
      assert.equal(item.class, REPORT_ONLY, label);
      assert.match(item.reason, /not a directory/i, label);
      // The hand line states the CLASS, never a list of shapes that leaves FIFO and socket outside it.
      assert.match(item.hand, /not a directory/i, label);
      // Its own surface AND its own hand line: the settings fallback would tell the maintainer to
      // remove a settings KEY from a directory, and the generic fallback would suggest `rm -rf` it.
      const out = formatPlan(plan);
      assert.doesNotMatch(out, /includeCoAuthoredBy" entry \(keep the rest/, label);
      assert.ok(!new RegExp(`rm -rf .*${claudePath}`).test(out), `${label}: never an rm of the container`);
    }
  }

  // The plan-time container guard makes the tool LOOK container-safe, and mutate time did not honour
  // that: the leaf lstat is no-follow but resolves THROUGH the container, so a `.claude` swapped for
  // a symlink after planning would have had a file outside the project read and removed.
  it('fold: .claude turning foreign BETWEEN plan and mutate is a CONFLICT — nothing is removed', () => {
    const claudePath = join(dir, '.claude');
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const planFs = {
      ...projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [claudePath, join(dir, '.claude/hooks')] }),
      bundlePath: '/bundle/hook.mjs',
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, planFs);
    assert.equal(find(plan.items, 'gate-hook').class, SAFE_REMOVE, 'removable on the tree AS PLANNED');
    const removed = [];
    const raced = {
      ...planFs,
      lstat: (p) => (p === claudePath ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } : planFs.lstat(p)),
      removeTree: (p) => { removed.push(p); return 'removed'; },
      rmFile: (p) => { removed.push(p); },
      // Injected, and load-bearing: without it the REAL fence validator runs, needs git, and throws
      // the same typed code — which made this test green on the strength of an unrelated failure.
      hideFootprint: () => ({ action: 'unhidden' }),
    };
    const err = (() => { try { executePlan(plan, { yes: true }, raced); return null; } catch (e) { return e; } })();
    assert.ok(err, 'a container change since the plan is a conflict');
    assert.equal(err.code, UNINSTALL_STOP);
    assert.ok(
      err.conflicts?.some((c) => c.includes('reachable') || c.includes('not a directory')),
      `the conflict must be about the CONTAINER, not whatever else failed first: ${err.conflicts?.join(' | ') ?? err.message}`,
    );
    assert.deepEqual(removed, [], 'and it is raised BEFORE any mutation');
  });

  // The container check was a LADDER: guard `.claude`, and the next symlink simply moves to
  // `.claude/hooks`, then to `.git`. The whole parent chain from the project root is the actual
  // property, and the kit already owns the primitive that walks it.
  it('fold: a symlinked INTERMEDIATE component blinds nothing — no hook is read or removed through one', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const markerPath = join(dir, '.git/hooks/pre-commit');
    for (const link of [join(dir, '.claude/hooks'), join(dir, '.git')]) {
      const base = projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [join(dir, '.claude'), join(dir, '.claude/hooks')] });
      const read = [];
      const fs = {
        ...base,
        bundlePath: '/bundle/hook.mjs',
        lstat: (p) => (p === link ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } : base.lstat(p)),
        readFile: (p) => { read.push(p); return base.readFile(p); },
      };
      const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
      const through = link.endsWith('.git') ? markerPath : hookPath;
      assert.ok(!read.includes(through), `${link}: a hook reached through a symlinked component must not be read`);
      const removable = plan.items.filter((i) => i.class === SAFE_REMOVE || i.class === MANAGED_MARKER).map((i) => i.path);
      assert.ok(!removable.includes(through), `${link}: and it must never be planned for removal`);
    }
  });

  it('fold: a container that turns foreign at MUTATE time raises a late conflict, never a silent skip', () => {
    const claudePath = join(dir, '.claude');
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const planFs = {
      ...projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [claudePath, join(dir, '.claude/hooks')] }),
      bundlePath: '/bundle/hook.mjs',
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, planFs);
    // The fence surface reaches hideFootprint TWICE — once as the conflict pass's dry-run, once as
    // the real mutation — so flipping on the SECOND call is what isolates the window this test is
    // about. Flipping on the first only re-tests the conflict pass, which already refuses.
    let fenceCalls = 0;
    let flipped = false;
    const removed = [];
    const raced = {
      ...planFs,
      lstat: (p) => (p === claudePath && flipped ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } : planFs.lstat(p)),
      hideFootprint: () => { fenceCalls += 1; if (fenceCalls >= 2) flipped = true; return { action: 'unhidden' }; },
      rmFile: (p) => { removed.push(p); },
      removeTree: (p) => { removed.push(p); return 'removed'; },
      unlink: () => 'unlinked',
    };
    const err = (() => { try { executePlan(plan, { yes: true }, raced); return null; } catch (e) { return e; } })();
    assert.ok(err, 'an incomplete teardown is never reported as a completed one');
    assert.equal(err.code, UNINSTALL_STOP);
    // INCOMPLETE, specifically: a preflight STOP also mentions `.claude`, so matching the path alone
    // would go green on a tree that never reached the mutate-time recheck this test is about.
    assert.match(err.message, /INCOMPLETE/, 'the LATE lane, not the preflight one');
    assert.ok(err.lateConflicts?.length > 0, 'and it names what it could not finish');
    assert.ok(!removed.includes(hookPath), 'the hook under the swapped container is not removed');
  });

  // The wired probe decides whether the placed hook is REMOVED, so a settings file reached through a
  // symlink would let foreign bytes drive a removal. Guarding the hook path alone left that open.
  it('fold: the wired probe never reads a settings file reached through a symlink', () => {
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const settingsPath = join(dir, '.claude/settings.json');
    const base = projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [join(dir, '.claude'), join(dir, '.claude/hooks')] });
    const read = [];
    const fs = {
      ...base,
      bundlePath: '/bundle/hook.mjs',
      lstat: (p) => (p === settingsPath ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false } : base.lstat(p)),
      readFile: (p) => { read.push(p); return base.readFile(p); },
    };
    const plan = buildPlan({ family: [], project, projectDir: dir }, fs);
    assert.ok(!read.includes(settingsPath), 'a symlinked settings file is never read at plan time');
    read.length = 0;
    try {
      executePlan(plan, { yes: true }, { ...fs, hideFootprint: () => ({ action: 'unhidden' }), rmFile: () => {}, removeTree: () => 'removed', unlink: () => 'unlinked' });
    } catch { /* the verdict below is what this test is about */ }
    assert.ok(!read.includes(settingsPath), 'nor at preflight or mutate time');
  });

  // `reachable()` walked the leaf too, so a symlinked settings file or placed hook collapsed to
  // "absent" and its REPORT_ONLY branch became unreachable — the surface vanished from the plan
  // entirely, which is worse than reporting it. Validate the PARENT CHAIN, then classify the leaf.
  it('fold: a symlinked settings.json or placed hook is REPORTED unread, never dropped from the plan', () => {
    const settingsPath = join(dir, '.claude/settings.json');
    const hookPath = join(dir, '.claude/hooks/agent-workflow-gates.mjs');
    const base = projectFs({ files: { [hookPath]: 'BUNDLE', ['/bundle/hook.mjs']: 'BUNDLE' }, dirs: [join(dir, '.claude'), join(dir, '.claude/hooks')] });
    const link = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
    const read = [];
    const fs = {
      ...base,
      bundlePath: '/bundle/hook.mjs',
      lstat: (p) => (p === settingsPath || p === hookPath ? link : base.lstat(p)),
      readFile: (p) => { read.push(p); return base.readFile(p); },
    };
    const items = buildPlan({ family: [], project, projectDir: dir }, fs).items;
    assert.ok(!read.includes(settingsPath) && !read.includes(hookPath), 'neither symlinked leaf is read');
    const gateItem = find(items, 'gate-hook');
    assert.ok(gateItem, 'the symlinked placed hook is still REPORTED');
    assert.equal(gateItem.class, REPORT_ONLY);
    assert.ok(items.some((i) => i.surface === 'settings' && i.path === settingsPath), 'and so is the symlinked settings file');
  });

  // A class-level pin rather than a per-branch one: `.mcp.json` is a SHARED declaration, so no arm
  // of this surface may ever fall through to the generic `rm -rf` guidance.
  it('fold: NO .mcp.json arm ever renders an rm — every one carries its own inspect/edit hand line', () => {
    const arms = {
      registered: JSON.stringify({ mcpServers: { [SERVER_NAME]: OUR_ENTRY } }),
      unparseable: '{ not json',
      'non-object root': '[]',
    };
    for (const [label, body] of Object.entries(arms)) {
      const plan = buildPlan({ family: [], project, projectDir: dir }, projectFs({ files: { [mcpJsonPath]: body } }));
      const item = find(plan.items, 'mcp-json');
      assert.ok(item, label);
      assert.ok(item.hand && !/^rm /.test(item.hand), `${label}: the hand line must not be a removal — ${item.hand}`);
      assert.ok(!new RegExp(`rm -rf .*${mcpJsonPath}`).test(formatPlan(plan)), `${label}: the report must never offer to rm a shared declaration`);
    }
  });

  it('fold: an UNPARSEABLE .mcp.json is reported with its reason, never silently dropped', () => {
    // The entry test is "is ours there?", and a file that cannot be parsed answers neither yes nor no.
    // Treating that as no made the file VANISH from a teardown report whose whole job is completeness.
    const fs = projectFs({ files: { [mcpJsonPath]: '{ not json' } });
    const item = find(buildPlan({ family: [], project, projectDir: dir }, fs).items, 'mcp-json');
    assert.ok(item, 'a file the teardown could not read is still reported');
    assert.equal(item.class, REPORT_ONLY);
    assert.match(item.reason, /could not be read or parsed/i);
  });

  it('the settings seam names the MCP keys when they are present', () => {
    const settings = JSON.stringify({ enabledMcpjsonServers: [SERVER_NAME], permissions: { allow: allowRulesFor() } });
    const fs = projectFs({ files: { [join(dir, '.claude/settings.json')]: settings } });
    const seam = buildPlan({ family: [], project, projectDir: dir }, fs).items.find((i) => i.surface === 'settings');
    assert.equal(seam.class, REPORT_ONLY);
    assert.match(seam.reason, /enabledMcpjsonServers/);
    assert.match(seam.hand, /mcp__/);
  });

  it('a malformed settings.json still surfaces the MCP seam by substring (no silent miss)', () => {
    const broken = `{ "enabledMcpjsonServers": ["${SERVER_NAME}"],, }`;
    const fs = projectFs({ files: { [join(dir, '.claude/settings.json')]: broken } });
    const seam = buildPlan({ family: [], project, projectDir: dir }, fs).items.find((i) => i.surface === 'settings');
    assert.match(seam.reason, /enabledMcpjsonServers/);
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
        // fs for the wrapper preflight inspect (report 'ours') + the hook marker re-check (present +
        // marked). PATH-AWARE: a blanket "everything is a symlink" answer was tuned to the wrapper
        // check alone, and it makes every parent-chain walk read as an escape.
        lstat: (p) => (p === '/home/u/.local/bin/codex-exec'
          ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
          : { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false }),
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
    // The wrapper is GONE (ENOENT); every other path stays an ordinary non-symlink so the parent-chain
    // walks around it answer about the tree rather than about this one fixture knob.
    const { calls, deps } = spyDeps({ deps: { lstat: (p) => (p.endsWith('codex-exec') ? enoent() : { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false }) } });
    const r = executePlan(fullPlan(), { yes: true }, deps);
    assert.equal(r.applied, true);
    assert.deepEqual(calls.removeTree, ['/skills/agent-workflow-kit']); // skill still removed
  });

  // A removal that REFUSES on containment is the same event as a chain that went foreign — it must
  // arrive as the typed incomplete-teardown stop, not as a raw fs error escaping the executor.
  it('fold: a containment failure during removal becomes a typed LATE conflict, never a raw throw', () => {
    const { calls, deps } = spyDeps({
      deps: { rmFile: () => { throw new Error('[agent-workflow-kit] refusing to write through a symlink at /proj/.git'); } },
    });
    const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err, 'a removal that refuses is never swallowed');
    assert.equal(err.code, UNINSTALL_STOP, `a raw fs error escaped instead: ${err.message}`);
    assert.match(err.message, /INCOMPLETE/);
    assert.deepEqual(calls.removeTree, ['/skills/agent-workflow-kit'], 'and what DID complete still completed');
  });

  it('fold: the incomplete-teardown message states what WAS applied, or that nothing was', () => {
    // Only the conflicted hook is in this plan, so there is no earlier removal to speak of and the
    // message must not assert one — it is derived from the result, never from the situation's shape.
    const { deps } = spyDeps({ deps: { rmFile: () => { throw new Error('[agent-workflow-kit] refusing to write through a symlink'); } } });
    const onlyHook = { projectDir: '/proj', items: [{ surface: 'hook', path: '/proj/.git/hooks/pre-commit', class: MANAGED_MARKER }] };
    const err = (() => { try { executePlan(onlyHook, { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err && err.code === UNINSTALL_STOP);
    assert.match(err.message, /nothing had been removed/i, `the message asserted a removal that never happened: ${err.message}`);
  });

  // "Never a silent skip under an applied: true" was MY claim last round, and the mutate-time
  // mismatch arms still did exactly that: a hook whose content changed, or could not be read, between
  // the preflight and its own removal was passed over and the teardown reported success.
  it('fold: a mutate-time mismatch is a LATE conflict, not a silent skip under applied:true', () => {
    let reads = 0;
    // Marked at preflight, rewritten by the user before its own removal.
    const { calls, deps } = spyDeps({
      deps: {
        readFile: () => {
          reads += 1;
          return reads > 1 ? '#!/bin/sh\n# the user rewrote it after the preflight\n' : '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\n';
        },
      },
    });
    const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err, 'a hook that changed under the teardown is never passed over in silence');
    assert.equal(err.code, UNINSTALL_STOP);
    assert.match(err.message, /INCOMPLETE/);
    assert.deepEqual(calls.rmFile, [], 'and the changed hook is NOT removed');
  });

  // `existsSync` answers false for a hook that is merely UNREADABLE, which reads as VANISHED — the
  // one state documented as benign. An unreadable leaf is not benign, and a non-regular one must not
  // be opened at all; both belong in the typed late-conflict lane rather than in silence.
  it('fold: an UNREADABLE hook is refused AS unreadable, and a non-regular one is never read', () => {
    const HOOK = '/proj/.git/hooks/pre-commit';
    const eacces = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const regular = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };

    // (a) The content cannot be read. Both the preflight and the mutate arm decided this by reading
    // and finding no marker, which reports a CAUSE that was never established — the file may carry
    // our marker perfectly well and simply be unreadable right now.
    const { calls, deps } = spyDeps({ deps: { readFile: (p) => (p === HOOK ? eacces() : '') } });
    const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err && err.code === UNINSTALL_STOP, 'an unreadable hook stops the teardown');
    assert.match(err.message, /could not be read/i, `the refusal must name unreadability, not a marker verdict it never made: ${err.message}`);
    assert.doesNotMatch(err.message, /no longer carries our marker/i, 'that cause was not established');
    assert.deepEqual(calls.rmFile, []);

    // (b) A non-regular leaf (a FIFO is the one that matters — a read would BLOCK) is classified and
    // refused, never opened.
    const fifo = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
    const { deps: fifoDeps } = spyDeps({
      deps: {
        lstat: (p) => (p === HOOK ? fifo : regular),
        readFile: (p) => { if (p === HOOK) assert.fail('a non-regular hook must never be read — a FIFO read blocks'); return ''; },
      },
    });
    const fifoErr = (() => { try { executePlan(fullPlan(), { yes: true }, fifoDeps); return null; } catch (e) { return e; } })();
    assert.ok(fifoErr && fifoErr.code === UNINSTALL_STOP, 'a non-regular hook stops the teardown');
    assert.match(fifoErr.message, /not a regular file/i, fifoErr.message);
  });

  // The INCOMPLETE contract was written for two surfaces and documented for all of them. A skill or
  // wrapper removal that refuses mid-teardown escaped as a raw error, which is the same silent-shape
  // failure the contract exists to prevent.
  it('fold: a refusing skill or wrapper removal is a typed INCOMPLETE stop, not a raw error', () => {
    for (const knob of ['removeTree', 'unlink']) {
      const { deps } = spyDeps({ deps: { [knob]: () => { throw new Error('[agent-workflow-kit] refusing to remove through a symlink'); } } });
      const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
      assert.ok(err, `${knob}: a refusal is never swallowed`);
      assert.equal(err.code, UNINSTALL_STOP, `${knob}: a raw error escaped instead — ${err.message}`);
      assert.match(err.message, /INCOMPLETE/, knob);
    }
  });

  // "left untouched" is a claim, and a recursive delete or a fence write that throws PART WAY has
  // already changed the tree. Only a containment refusal is provably pre-mutation; anything else is
  // possibly-partial and must stop the run rather than let later surfaces keep being removed.
  it('fold: a possibly-PARTIAL removal failure says so, and stops — only a refusal is "left untouched"', () => {
    const { calls, deps } = spyDeps({ deps: { removeTree: () => { throw Object.assign(new Error('EIO: half-deleted'), { code: 'EIO' }); } } });
    const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err && err.code === UNINSTALL_STOP, 'a failed removal stops the teardown');
    // Assert the failure's OWN entry, not the whole message: the closing advice legitimately uses the
    // phrase "left untouched" about the OTHER category.
    assert.deepEqual(err.lateConflicts, [], 'an unproven failure is not a refusal');
    assert.equal(err.partialFailures.length, 1, `expected one possibly-partial failure: ${err.message}`);
    assert.match(err.partialFailures[0], /MAY BE PARTIALLY removed/i, err.partialFailures[0]);
    assert.deepEqual(calls.unhide.filter((o) => !o.dryRun), [], 'and no LATER surface was mutated after it');
  });

  it('fold: a skill replaced since the preflight is re-checked for ownership before removal', () => {
    let classifyCalls = 0;
    const { calls, deps } = spyDeps({
      // Ours at the conflict pass, a foreign directory by the time its own removal comes up.
      classify: (reg) => {
        classifyCalls += 1;
        return classifyCalls > 1
          ? { installed: true, manifestState: 'foreign', skillDir: `/skills/${reg.name}` }
          : { installed: true, manifestState: OK, skillDir: `/skills/${reg.name}` };
      },
    });
    const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err && err.code === UNINSTALL_STOP, 'a directory that stopped being ours is never recursively removed');
    assert.deepEqual(calls.removeTree, [], 'and the removal never ran');
  });

  it('fold: a marker hook that becomes UNREADABLE at mutate time is a late conflict, not a guess', () => {
    const HOOK = '/proj/.git/hooks/pre-commit';
    let reads = 0;
    // Readable through the preflight, unreadable by the time its own removal comes up.
    const { calls, deps } = spyDeps({
      deps: {
        readFile: (p) => {
          if (p !== HOOK) return '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\n';
          reads += 1;
          // The preflight reads it once; the mutate arm is the SECOND read, and that is the one this
          // test makes fail.
          if (reads > 1) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          return '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\n';
        },
      },
    });
    const err = (() => { try { executePlan(fullPlan(), { yes: true }, deps); return null; } catch (e) { return e; } })();
    assert.ok(err && err.code === UNINSTALL_STOP, 'never removed on the strength of a read that failed');
    assert.match(err.message, /could not be read at removal time/i, err.message);
    assert.deepEqual(calls.rmFile, []);
  });

  // The three execute-time arms that answer "I cannot decide", each with its own cause: an lstat that
  // fails for a reason other than absence, a chain that is foreign by the conflict pass, and a chain
  // that goes foreign only between that pass and the removal.
  // A chain that is foreign by the conflict pass, and one that goes foreign only between that pass
  // and the removal — two arms, two different sentences, and neither may remove anything.
  it('fold: an unreachable hook chain is refused, whether it goes foreign before or after the preflight', () => {
    const GIT = '/proj/.git';
    const WRAPPER = '/home/u/.local/bin/codex-exec';
    const link = { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
    const regular = { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false };
    // The fixture's own default: the wrapper is a managed SYMLINK and everything else is ordinary.
    // Answering `regular` for every path breaks the wrapper check and refuses for the wrong reason.
    const base = (p) => (p === WRAPPER ? link : regular);

    const b = spyDeps({ deps: { lstat: (p) => (p === GIT ? link : base(p)) } });
    const errB = (() => { try { executePlan(fullPlan(), { yes: true }, b.deps); return null; } catch (e) { return e; } })();
    assert.match(errB?.message ?? '', /no longer reachable/i, `foreign chain: ${errB?.message}`);
    assert.deepEqual(b.calls.rmFile, [], 'and nothing was removed through it');

    // Foreign only AFTER the conflict pass: the fence mutation is the seam, as elsewhere in this file.
    let fence = 0;
    let flipped = false;
    const c = spyDeps({
      deps: {
        lstat: (p) => (p === GIT && flipped ? link : base(p)),
        hideFootprint: () => { fence += 1; if (fence >= 2) flipped = true; return { action: 'unhidden' }; },
      },
    });
    const errC = (() => { try { executePlan(fullPlan(), { yes: true }, c.deps); return null; } catch (e) { return e; } })();
    assert.match(errC?.message ?? '', /INCOMPLETE/, `late chain: ${errC?.message}`);
    assert.deepEqual(c.calls.rmFile, [], 'and the hook under it is left alone');

    // And the LEAF turning NON-REGULAR in that window — a device or FIFO, deliberately not a symlink:
    // the chain walk only refuses symlinks, so this is the class that reaches the leaf classifier and
    // earns its own sentence ("the path stopped being reachable" and "the file stopped being a file"
    // are different facts, and a teardown that reports the wrong one has diagnosed nothing).
    const fifo = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
    let fenceD = 0;
    let leafFlipped = false;
    const d = spyDeps({
      deps: {
        lstat: (p) => (p === '/proj/.git/hooks/pre-commit' && leafFlipped ? fifo : base(p)),
        hideFootprint: () => { fenceD += 1; if (fenceD >= 2) leafFlipped = true; return { action: 'unhidden' }; },
      },
    });
    const errD = (() => { try { executePlan(fullPlan(), { yes: true }, d.deps); return null; } catch (e) { return e; } })();
    assert.match(errD?.lateConflicts?.join(' ') ?? '', /not a regular file/i, `late leaf: ${errD?.message}`);
    assert.deepEqual(d.calls.rmFile, []);
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

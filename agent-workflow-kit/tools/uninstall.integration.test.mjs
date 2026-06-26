// Integration acceptance for the guarded uninstaller against the REAL filesystem — what the mocked
// unit test cannot prove: real validateManifest over real skill dirs, real removeTreeManaged deleting
// a real tree, real unlinkManaged removing OUR symlink while leaving a FOREIGN one, a real marker
// pre-commit hook removed, and user-authored docs/ai LEFT INTACT after a full --yes teardown. The
// git-backed fence unhide is delegated to hideFootprint (already covered by its own integration test),
// so it is injected here as a recording stub — this test owns the uninstaller's own fs mutations.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlan, executePlan, SAFE_REMOVE, MANAGED_MARKER, REPORT_ONLY, STOP } from './uninstall.mjs';
import { surveyFamily, surveyProject } from './family-registry.mjs';
import { START_MARKER } from './hide-footprint.mjs';

const made = [];
const mkdtemp = (tag) => { const d = mkdtempSync(join(tmpdir(), tag)); made.push(d); return d; };
afterEach(() => { while (made.length) { try { rmSync(made.pop(), { recursive: true, force: true }); } catch { /* best effort */ } } });

const writeFile = (p, s) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };

// A minimal but VALID family skill dir (passes the real validateManifest: family/schema/kind/version
// match + SKILL.md metadata.version == capability.json version + role sources exist).
const makeMemorySkill = (skillsRoot) => {
  const dir = join(skillsRoot, 'agent-workflow-memory');
  writeFile(join(dir, 'SKILL.md'), "---\nname: agent-workflow-memory\nmetadata:\n  version: '1.1.1'\n---\n# memory\n");
  writeFile(join(dir, 'capability.json'), JSON.stringify({
    family: 'agent-workflow', schema: 1, name: 'agent-workflow-memory', kind: 'memory-substrate',
    version: '1.1.1', provides: ['context'], roles: {},
    detect: { installed: { env: 'AGENT_WORKFLOW_MEMORY_DIR', default: '~/.claude/skills/agent-workflow-memory', file: 'SKILL.md' } },
  }));
  return dir;
};

const makeCodexBridge = (skillsRoot) => {
  const dir = join(skillsRoot, 'codex-cli-bridge');
  writeFile(join(dir, 'SKILL.md'), "---\nname: codex-cli-bridge\nmetadata:\n  version: '1.0.0'\n---\n# codex\n");
  writeFile(join(dir, 'bin', 'codex-exec.sh'), '#!/bin/sh\n');
  writeFile(join(dir, 'bin', 'codex-review.sh'), '#!/bin/sh\n');
  writeFile(join(dir, 'capability.json'), JSON.stringify({
    family: 'agent-workflow', schema: 1, name: 'codex-cli-bridge', kind: 'execution-backend',
    version: '1.0.0', provides: ['execute', 'review'],
    roles: {
      execute: { cmd: 'codex-exec', source: 'bin/codex-exec.sh' },
      review: { cmd: 'codex-review', source: 'bin/codex-review.sh' },
    },
    detect: { installed: { env: 'CODEX_CLI_BRIDGE_DIR', default: '~/.claude/skills/codex-cli-bridge', file: 'SKILL.md' } },
  }));
  return dir;
};

describe('uninstall integration (real fs)', () => {
  it('plans + applies a full guarded teardown: removes ours, keeps foreign + user-authored', () => {
    const home = mkdtemp('aw-unh-home-');
    const skills = mkdtemp('aw-unh-skills-');
    const bindir = mkdtemp('aw-unh-bin-');
    const proj = mkdtemp('aw-unh-proj-');
    const foreignTarget = mkdtemp('aw-unh-foreign-');

    const memorySkill = makeMemorySkill(skills);
    const codexSkill = makeCodexBridge(skills);

    // ~/.local/bin wrappers: codex-exec is OURS; codex-review is a FOREIGN symlink (must be kept).
    symlinkSync(join(codexSkill, 'bin/codex-exec.sh'), join(bindir, 'codex-exec'));
    writeFileSync(join(foreignTarget, 'codex-review'), '#!/bin/sh\n');
    symlinkSync(join(foreignTarget, 'codex-review'), join(bindir, 'codex-review'));

    // Project surfaces: a hidden fence, OUR marker pre-commit hook, and user-authored docs/ai.
    writeFile(join(proj, '.git/info/exclude'), `# user rule\n${START_MARKER}\n/AGENTS.md\n# <<< agent-workflow-kit hidden mode <<<\n`);
    writeFile(join(proj, '.git/hooks/pre-commit'), '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\nset -e\nnode scripts/check-docs-size.mjs\n');
    writeFile(join(proj, 'docs/ai/handover.md'), '# handover (USER-AUTHORED)\n');
    writeFile(join(proj, 'docs/ai/.workflow-version'), '1.3.0\n');

    // Resolve only memory + codex as installed (env-pointed); other members fall to <home>/.claude → absent.
    const deps = {
      getenv: { AGENT_WORKFLOW_MEMORY_DIR: memorySkill, CODEX_CLI_BRIDGE_DIR: codexSkill },
      home,
    };
    const family = surveyFamily(deps);
    const project = surveyProject(proj, deps);
    assert.equal(project.hiddenFence, true);
    assert.equal(family.find((m) => m.name === 'agent-workflow-memory').manifestState, 'ok');
    assert.equal(family.find((m) => m.name === 'codex-cli-bridge').manifestState, 'ok');

    const plan = buildPlan({ family, project, projectDir: proj, bindir }, deps);
    const cls = (surface, pred) => plan.items.find((i) => i.surface === surface && pred(i));
    assert.equal(cls('skill', (i) => i.member === 'agent-workflow-memory').class, SAFE_REMOVE);
    assert.equal(cls('wrapper', (i) => i.path.endsWith('codex-exec')).class, MANAGED_MARKER);
    assert.equal(cls('wrapper', (i) => i.path.endsWith('codex-review')).class, STOP); // foreign
    assert.equal(cls('fence', () => true).class, MANAGED_MARKER);
    assert.equal(cls('hook', () => true).class, MANAGED_MARKER);
    assert.equal(cls('docs', (i) => i.path.endsWith('docs/ai')).class, REPORT_ONLY);

    // Apply. Inject a recording fence-unhide (its real git path is covered by hide-footprint's own test).
    const unhideCalls = [];
    const r = executePlan(plan, { yes: true }, { ...deps, hideFootprint: (opts) => { unhideCalls.push(opts); return { action: 'unhidden' }; } });

    // Ours is gone:
    assert.equal(existsSync(memorySkill), false, 'memory skill dir removed');
    assert.equal(existsSync(codexSkill), false, 'codex skill dir removed');
    assert.equal(existsSync(join(bindir, 'codex-exec')), false, 'our wrapper symlink removed');
    assert.equal(existsSync(join(proj, '.git/hooks/pre-commit')), false, 'marker hook removed');
    assert.equal(r.unhidden, true);
    // The fence is validated by a dry-run unhide in preflight, then unhidden for real in the mutate phase.
    assert.deepEqual(unhideCalls, [{ dir: proj, unhide: true, dryRun: true }, { dir: proj, unhide: true }]);

    // Foreign + user-authored is KEPT:
    assert.equal(lstatSync(join(bindir, 'codex-review')).isSymbolicLink(), true, 'foreign wrapper kept');
    assert.equal(existsSync(join(foreignTarget, 'codex-review')), true, 'foreign target untouched');
    assert.equal(existsSync(join(proj, 'docs/ai/handover.md')), true, 'user-authored docs/ai NEVER deleted');
  });

  it('preflight refuses (zero mutation) when a skill dir turns foreign between plan and apply', () => {
    const home = mkdtemp('aw-unh2-home-');
    const skills = mkdtemp('aw-unh2-skills-');
    const memorySkill = makeMemorySkill(skills);
    const deps = { getenv: { AGENT_WORKFLOW_MEMORY_DIR: memorySkill }, home };

    const family = surveyFamily(deps);
    const plan = buildPlan({ family }, deps);
    assert.equal(plan.items.find((i) => i.surface === 'skill').class, SAFE_REMOVE);

    // Corrupt the manifest after planning → the preflight re-check must STOP, leaving the dir intact.
    writeFileSync(join(memorySkill, 'capability.json'), '{ not json');
    assert.throws(() => executePlan(plan, { yes: true }, deps), (err) => err.code === 'UNINSTALL_STOP');
    assert.equal(existsSync(memorySkill), true, 'skill dir untouched after a refused preflight');
  });

  it('keeps a pre-commit hook whose marker was removed between plan and apply', () => {
    const home = mkdtemp('aw-unh3-home-');
    const proj = mkdtemp('aw-unh3-proj-');
    writeFile(join(proj, '.git/hooks/pre-commit'), '#!/usr/bin/env bash\n# myproj:install-git-hooks.mjs\nset -e\n');
    const deps = { getenv: {}, home };

    const plan = buildPlan({ family: [], project: surveyProject(proj, deps), projectDir: proj }, deps);
    assert.equal(plan.items.find((i) => i.surface === 'hook').class, MANAGED_MARKER);

    // The user rewrites the hook (dropping our marker) before they apply the teardown.
    writeFileSync(join(proj, '.git/hooks/pre-commit'), '#!/bin/sh\n# my own hook now\n');
    assert.throws(() => executePlan(plan, { yes: true }, deps), (err) => err.code === 'UNINSTALL_STOP');
    assert.equal(existsSync(join(proj, '.git/hooks/pre-commit')), true, 'a now-unmarked (user) hook is NEVER deleted');
  });
});

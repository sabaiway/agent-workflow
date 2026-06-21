// End-to-end acceptance: a standalone substrate bootstrap into a fresh project.
//
// The unit suites cover each module in isolation (the stamp state machine, the atomic
// writer, the hook installer). This drives the documented bootstrap WRITE steps end to end
// over a real temp project + a real git checkout, then asserts the deployed artifact set:
// docs/ai + entry point exist, the pre-commit hook is installed, the deployment-lineage
// stamp is .memory-version (the lineage head) ONLY, and the methodology slot ships empty.
//
// Standalone here means substrate-only: nothing fills the slot, so it stays empty and no
// second (composition-root) stamp appears. The composition path is covered separately.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  readdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeStampAtomic, LINEAGE_HEAD } from './stamp-takeover.mjs';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = join(SKILL_ROOT, 'references', 'templates');
const ENFORCEMENT = join(SKILL_ROOT, 'references', 'scripts');

// The empty delimited slot the substrate ships in its entry point. Hard-coded (not imported
// from the composition root) so this substrate test stays self-contained and dependency-free.
const SLOT_START = '<!-- workflow:methodology:start -->';
const SLOT_END = '<!-- workflow:methodology:end -->';

const tempDirs = [];
const makeProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-bootstrap-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Mirrors the bootstrap WRITE steps: entry point at the root (+ tool alias symlink), every
// other template under docs/ai, enforcement scripts copied in, the hook installed against a
// real checkout, and the lineage head stamped atomically. Returns the docs/ai dir.
const bootstrap = (project) => {
  cpSync(join(TEMPLATES, 'AGENTS.md'), join(project, 'AGENTS.md'));
  symlinkSync('AGENTS.md', join(project, 'CLAUDE.md'));

  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  for (const entry of readdirSync(TEMPLATES)) {
    if (entry === 'AGENTS.md') continue;
    cpSync(join(TEMPLATES, entry), join(docsAi, entry), { recursive: true });
  }

  const projectScripts = join(project, 'scripts');
  mkdirSync(projectScripts, { recursive: true });
  cpSync(ENFORCEMENT, projectScripts, { recursive: true });

  // The hook installer resolves its target from its OWN location, so run the copied-in copy
  // (project/scripts/...) to install into project/.git/hooks — exactly as the procedure does.
  execFileSync('git', ['init', '-q'], { cwd: project });
  execFileSync(process.execPath, [join(projectScripts, 'install-git-hooks.mjs')], {
    cwd: project,
    stdio: 'pipe',
  });

  return docsAi;
};

describe('standalone substrate bootstrap (end-to-end, real temp project)', () => {
  it('deploys docs/ai + entry point and installs the pre-commit hook', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);

    assert.ok(existsSync(join(project, 'AGENTS.md')), 'entry point exists');
    assert.ok(existsSync(docsAi), 'docs/ai exists');
    assert.ok(existsSync(join(docsAi, 'agent_rules.md')), 'a representative docs/ai file landed');

    const hook = join(project, '.git', 'hooks', 'pre-commit');
    assert.ok(existsSync(hook), 'pre-commit hook installed');
    assert.match(readFileSync(hook, 'utf8'), /install-git-hooks\.mjs/, 'hook carries the installer marker');
  });

  it('stamps .memory-version (lineage head) ONLY — no second stamp', async () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    await writeStampAtomic(join(docsAi, '.memory-version'), LINEAGE_HEAD);

    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD);
    assert.ok(!existsSync(join(docsAi, '.workflow-version')), 'no composition-root stamp in a standalone bootstrap');
  });

  it('ships the methodology slot present-but-empty', () => {
    const project = makeProject();
    bootstrap(project);

    const entry = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    const start = entry.indexOf(SLOT_START);
    const end = entry.indexOf(SLOT_END);
    assert.ok(start !== -1 && end !== -1 && end > start, 'an ordered slot marker pair is present');
    assert.equal(entry.slice(start + SLOT_START.length, end).trim(), '', 'the slot is empty as shipped');
  });
});

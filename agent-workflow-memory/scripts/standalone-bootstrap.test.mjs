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
  writeFileSync,
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
const ORCH_START = '<!-- workflow:orchestration:start -->';
const ORCH_END = '<!-- workflow:orchestration:end -->';
// The deployed AGENTS.md line budget the composition root fills BOTH pointers inside (D-CAP). A
// representative single-line fragment per slot models what the composition root injects.
const AGENTS_MD_CAP = 100;
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const extractPair = (text, start, end) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  return a !== -1 && b !== -1 && b > a ? text.slice(a + start.length, b) : null;
};

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
    // AGENTS.md is the entry point (placed at the root above); adr-record.md is a skill-home
    // authoring reference (never deployed — it would be a stray in docs/ai and, under adr/, would
    // fail the ADR store's integrity guard). Both are excluded from the docs/ai copy loop.
    if (entry === 'AGENTS.md' || entry === 'adr-record.md') continue;
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

  // The one-file-per-ADR store seeds a HOT window (decisions.md) + the seed navigator
  // (docs/ai/adr/log.md) but NOT the adr-record.md authoring reference; a fresh bootstrap must pass
  // archive-decisions.mjs --check on first commit (the seed navigator == the generator over the seed).
  it('seeds the ADR store (decisions.md + adr/log.md, no stray adr-record.md) and --check is green', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);

    assert.ok(existsSync(join(docsAi, 'decisions.md')), 'the HOT ADR window is seeded');
    assert.ok(existsSync(join(docsAi, 'adr', 'log.md')), 'the seed ADR navigator is deployed under adr/');
    assert.ok(!existsSync(join(docsAi, 'adr-record.md')), 'the authoring reference is NOT deployed (skill-home only)');
    assert.ok(!existsSync(join(docsAi, 'adr', 'adr-record.md')), 'the authoring reference is NOT placed in the adr/ store');

    // The deployed rotator (project/scripts/) resolves its root from its own location → the project.
    const check = execFileSync(process.execPath, [join(project, 'scripts', 'archive-decisions.mjs'), '--check'], {
      cwd: project,
      encoding: 'utf8',
    });
    assert.match(check, /OK — HOT within cap, store integrity intact, navigator fresh/, 'fresh-bootstrap --check is green');
  });

  it('stamps .memory-version (lineage head) ONLY — no second stamp', async () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    await writeStampAtomic(join(docsAi, '.memory-version'), LINEAGE_HEAD);

    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD);
    assert.ok(!existsSync(join(docsAi, '.workflow-version')), 'no composition-root stamp in a standalone bootstrap');
  });

  it('ships BOTH pointer slots present-but-empty (methodology + orchestration)', () => {
    const project = makeProject();
    bootstrap(project);

    const entry = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    const meth = extractPair(entry, SLOT_START, SLOT_END);
    const orch = extractPair(entry, ORCH_START, ORCH_END);
    assert.notEqual(meth, null, 'an ordered methodology marker pair is present');
    assert.equal(meth.trim(), '', 'the methodology slot is empty as shipped');
    assert.notEqual(orch, null, 'an ordered orchestration marker pair is present');
    assert.equal(orch.trim(), '', 'the orchestration slot is empty as shipped');
  });

  it('seeds docs/ai/orchestration.json from the template (the bootstrap loop deploys it)', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const seeded = join(docsAi, 'orchestration.json');
    assert.ok(existsSync(seeded), 'the orchestration.json config is seeded into docs/ai');
    assert.equal(
      readFileSync(seeded, 'utf8'),
      readFileSync(join(TEMPLATES, 'orchestration.json'), 'utf8'),
      'the seeded config is byte-identical to the template',
    );
    // strict JSON valid + the conservative all-solo default the maintainer chose.
    const config = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(typeof config._README, 'string', 'an onboarding _README is present');
    assert.equal(config['plan-authoring'].review, 'solo', 'default review recipe is solo');
  });

  it('seeds docs/ai/gates.json from the template (the bootstrap loop deploys it)', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const seeded = join(docsAi, 'gates.json');
    assert.ok(existsSync(seeded), 'the gates.json declaration is seeded into docs/ai');
    assert.equal(
      readFileSync(seeded, 'utf8'),
      readFileSync(join(TEMPLATES, 'gates.json'), 'utf8'),
      'the seeded declaration is byte-identical to the template',
    );
    // strict JSON valid + the conservative empty-list default (a project declares its own gates).
    const declaration = JSON.parse(readFileSync(seeded, 'utf8'));
    assert.equal(typeof declaration._README, 'string', 'an onboarding _README is present');
    assert.deepEqual(declaration.gates, [], 'ships an empty gates list');
  });

  // The stamp-independent upgrade "ensure" for gates.json (SKILL.md upgrade step 2): the same
  // create-if-missing / preserve-byte-for-byte contract as orchestration.json — an authored gate
  // matrix is never clobbered, a deleted declaration is re-seeded.
  it('the upgrade ensure preserves an edited gates.json and re-creates a deleted one', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const dest = join(docsAi, 'gates.json');
    const ensureGates = () => {
      if (!existsSync(dest)) cpSync(join(TEMPLATES, 'gates.json'), dest);
    };

    // A user declares their own gate matrix.
    const authored = '{ "gates": [{ "id": "unit-tests", "title": "Unit tests", "cmd": "node --test" }] }\n';
    writeFileSync(dest, authored);
    ensureGates(); // an equal-head upgrade re-runs the ensure
    assert.equal(readFileSync(dest, 'utf8'), authored, 'an authored declaration is preserved byte-for-byte');

    // A missing declaration is re-seeded.
    rmSync(dest);
    ensureGates();
    assert.ok(existsSync(dest), 'a missing declaration is re-created from the template');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(TEMPLATES, 'gates.json'), 'utf8'));
  });

  // The stamp-independent enforcement-script ensure (SKILL.md upgrade step 2, the codex R1 fold):
  // a deployment older than the ADR-cascade feature gains the archive-decisions pair on an
  // equal-head upgrade — copy-if-missing from references/scripts, never overwrite an existing
  // file. Modeled the way the documented prose performs it (the ensureConfig idiom).
  it('the upgrade ensure adds a MISSING archive-decisions pair and preserves an existing one', () => {
    const project = makeProject();
    bootstrap(project);
    const projectScripts = join(project, 'scripts');
    const pair = ['archive-decisions.mjs', 'archive-decisions.test.mjs'];
    // Simulate a PRE-cascade deployment: the pair is absent from the deployed scripts/.
    for (const name of pair) rmSync(join(projectScripts, name));
    const ensureEnforcementPair = () => {
      for (const name of pair) {
        if (!existsSync(join(projectScripts, name))) cpSync(join(ENFORCEMENT, name), join(projectScripts, name));
      }
    };
    ensureEnforcementPair();
    for (const name of pair) {
      assert.equal(
        readFileSync(join(projectScripts, name), 'utf8'),
        readFileSync(join(ENFORCEMENT, name), 'utf8'),
        `${name} seeded byte-identical from references/scripts`,
      );
    }
    // An existing (possibly older) file is preserved — drift repair is a migration's job.
    writeFileSync(join(projectScripts, 'archive-decisions.mjs'), '// locally pinned older copy\n');
    ensureEnforcementPair();
    assert.match(readFileSync(join(projectScripts, 'archive-decisions.mjs'), 'utf8'), /locally pinned/, 'never overwritten');
  });

  // The stamp-independent upgrade "ensure" (SKILL.md upgrade step 2): create-if-missing /
  // preserve-if-edited. Modeled here the way the documented prose performs it — so an equal-head
  // re-run never clobbers a user's edited config, and a deleted one is re-seeded.
  it('the upgrade ensure preserves an edited config and re-creates a deleted one', () => {
    const project = makeProject();
    const docsAi = bootstrap(project);
    const dest = join(docsAi, 'orchestration.json');
    const ensureConfig = () => {
      if (!existsSync(dest)) cpSync(join(TEMPLATES, 'orchestration.json'), dest);
    };

    // A user edits the deployed config.
    writeFileSync(dest, '{ "plan-authoring": { "review": "council" } }\n');
    ensureConfig(); // an equal-head upgrade re-runs the ensure
    assert.match(readFileSync(dest, 'utf8'), /council/, 'an edited config is preserved (never clobbered)');

    // A missing config is re-seeded.
    rmSync(dest);
    ensureConfig();
    assert.ok(existsSync(dest), 'a missing config is re-created from the template');
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(TEMPLATES, 'orchestration.json'), 'utf8'));
  });

  it('stays ≤ the cap when the composition root fills BOTH pointer slots (D-CAP headroom)', () => {
    const project = makeProject();
    bootstrap(project);
    const entry = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.ok(lineCount(entry) <= AGENTS_MD_CAP, `shipped (empty) AGENTS.md is ${lineCount(entry)} lines (cap ${AGENTS_MD_CAP})`);
    // Fill each one-line pointer the way the composition root does (replace the empty body), then re-count.
    const fill = (text, start, end, body) => {
      const a = text.indexOf(start);
      const b = text.indexOf(end);
      return `${text.slice(0, a + start.length)}\n${body}\n${text.slice(b)}`;
    };
    let filled = fill(entry, SLOT_START, SLOT_END, '> methodology pointer (one line)');
    filled = fill(filled, ORCH_START, ORCH_END, '> orchestration recipes pointer (one line)');
    assert.ok(lineCount(filled) <= AGENTS_MD_CAP, `dual-filled AGENTS.md is ${lineCount(filled)} lines (cap ${AGENTS_MD_CAP})`);
  });
});

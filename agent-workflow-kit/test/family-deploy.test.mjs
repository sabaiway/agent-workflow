// End-to-end acceptance for the composition root's two deploy paths, tying the executable
// hand-off contract (detectMemory / handoffPlan) to the artifacts that actually land on disk.
//
//   fallback  (substrate absent)  → bundled entry point, the root reconciles the kit block in at its
//                                   start, .workflow-version ONLY
//   delegate  (substrate present) → substrate writes .memory-version + its entry point; the root
//                                   reconciles the kit block in and writes .workflow-version → BOTH stamps
//
// The delegate path installs the substrate skill via its OWN published installer into a temp dir
// and drives the real installed payload — so this also proves the hand-off seam end to end. The kit
// block is written by the REAL `inject-methodology.mjs reconcile` against the REAL local engine.
//
// Lives outside the package `files` whitelist: it is a dev-only family acceptance test and is not
// shipped in the tarball. Run it explicitly (it is not matched by the tools/*.test.mjs gate glob).

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { detectMemory, handoffPlan, EXPECTED_MEMORY_NAME } from '../tools/delegation.mjs';
import { ENGINE_FRAGMENT_REL, ORCHESTRATION_FRAGMENT_REL, AUTONOMY_FRAGMENT_REL } from '../tools/engine-source.mjs';
import { serializeConfig, CANON_README, KNOWN_PRIOR_README } from '../tools/orchestration-config.mjs';
import { ensureOrchestration } from '../tools/ensure-ops.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAMILY_ROOT = resolve(KIT_ROOT, '..');
const SUBSTRATE_INSTALLER = join(FAMILY_ROOT, 'agent-workflow-memory', 'bin', 'install.mjs');
const KIT_ENTRY_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'AGENTS.md');
const ENGINE_DIR = join(FAMILY_ROOT, 'agent-workflow-engine');
const INJECT = join(KIT_ROOT, 'tools', 'inject-methodology.mjs');

// The shared deployment-lineage head the composition root stamps in BOTH paths. The root knows it
// independently of the substrate package version (SKILL.md bootstrap step 10) — hard-coded here so
// the fallback path asserts it without importing the substrate (which, in fallback, is absent).
const LINEAGE_HEAD = '5.0.0';

// A realistic prior-lineage deployment with no kit block: the reconcile places the block at the
// start of the file and leaves every one of these bytes after it.
const LEGACY_ENTRY = [
  '# AI Agent Algorithm — legacy project',
  '',
  '## 🚀 Session Protocols',
  '',
  'Start-of-session, during-work, and task-completion procedures live in [`docs/ai/agent_rules.md`](./docs/ai/agent_rules.md) §1. **Read it before any code change.**',
  '',
  '---',
  '',
  '## 🚫 Hard Constraints',
  '',
  'project-specific rules the user wrote',
  '',
].join('\n');

const projects = [];
const makeProject = () => {
  const project = mkdtempSync(join(tmpdir(), 'family-project-'));
  projects.push(project);
  const docsAi = join(project, 'docs', 'ai');
  mkdirSync(docsAi, { recursive: true });
  return { project, docsAi };
};
afterEach(() => {
  while (projects.length) rmSync(projects.pop(), { recursive: true, force: true });
});

// The real reconcile CLI against the real local engine; a non-zero exit throws with its output.
const reconcile = (file) => execFileSync(process.execPath, [INJECT, 'reconcile', file], {
  stdio: 'pipe', encoding: 'utf8', env: { ...process.env, AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR },
});
// The block the module found, its lines and every byte after its end marker line.
const kitBlock = async (text) => {
  const { findKitBlock } = await import('../tools/inject-methodology.mjs');
  assert.equal(typeof findKitBlock, 'function', 'inject-methodology.mjs exports findKitBlock');
  const found = findKitBlock(text);
  assert.equal(found.state, 'ok', JSON.stringify(found));
  const lines = text.split('\n');
  return { start: found.start, body: lines.slice(found.start - 1, found.end).join('\n'), after: lines.slice(found.end).join('\n') };
};
const assertBlockAtStart = async (text, original) => {
  const block = await kitBlock(text);
  assert.equal(block.start, 1, 'the block opens the file');
  assert.equal(block.after, `\n${original}`, 'one blank line, then every old byte unchanged');
  return block;
};

// The substrate is installed ONCE via its OWN published installer; the delegate and transition
// paths both drive the real installed payload (the genuine hand-off / upgrade seam), not source.
let substrateDir;
let stamp; // the installed substrate's stamp module
before(async () => {
  substrateDir = mkdtempSync(join(tmpdir(), 'substrate-skill-'));
  execFileSync(process.execPath, [SUBSTRATE_INSTALLER, '--dir', substrateDir], { stdio: 'pipe' });
  stamp = await import(pathToFileURL(join(substrateDir, 'scripts', 'stamp-takeover.mjs')).href);
});
after(() => {
  if (substrateDir) rmSync(substrateDir, { recursive: true, force: true });
});

describe('composition root — fallback (substrate absent)', () => {
  it('detector chooses fallback; the hand-off plans exactly one stamp', () => {
    const decision = detectMemory(join(tmpdir(), 'no-such-substrate-skill-dir'));
    assert.equal(decision.delegate, false);
    const plan = handoffPlan(decision.delegate);
    assert.equal(plan.mode, 'fallback');
    assert.deepEqual(plan.stampsPresent, ['.workflow-version']);
  });

  it('deploys the bundled entry point, reconciles the kit block in at its start, stamps .workflow-version ONLY', async () => {
    const { project, docsAi } = makeProject();
    const entry = join(project, 'AGENTS.md');
    cpSync(KIT_ENTRY_TEMPLATE, entry);
    reconcile(entry);
    await assertBlockAtStart(readFileSync(entry, 'utf8'), readFileSync(KIT_ENTRY_TEMPLATE, 'utf8'));

    writeFileSync(join(docsAi, '.workflow-version'), `${LINEAGE_HEAD}\n`);
    assert.equal(readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim(), LINEAGE_HEAD);
    assert.ok(!existsSync(join(docsAi, '.memory-version')), 'fallback writes no substrate stamp');
  });
});

describe('composition root — delegate (substrate present + healthy)', () => {
  it('detector validates the install and chooses delegation', () => {
    const decision = detectMemory(substrateDir);
    assert.equal(decision.delegate, true, decision.reason);
    assert.equal(decision.name, EXPECTED_MEMORY_NAME);
    assert.equal(decision.kind, 'memory-substrate');
    const plan = handoffPlan(decision.delegate);
    assert.equal(plan.mode, 'delegate');
    assert.deepEqual(plan.stampsPresent, ['.memory-version', '.workflow-version']);
  });

  it('substrate stamps + root reconciles → BOTH stamps present and the kit block at the start of the entry point', async () => {
    const { project, docsAi } = makeProject();
    const entry = join(project, 'AGENTS.md');
    const template = join(substrateDir, 'references', 'templates', 'AGENTS.md');

    // Substrate side: deploy its entry point and stamp .memory-version atomically, both from the
    // INSTALLED payload — the real delegated hand-off.
    cpSync(template, entry);
    await stamp.writeStampAtomic(join(docsAi, '.memory-version'), stamp.LINEAGE_HEAD);

    // Composition-root side: reconcile the kit block in, then write the second stamp.
    reconcile(entry);
    writeFileSync(join(docsAi, '.workflow-version'), `${stamp.LINEAGE_HEAD}\n`);

    const memoryStamp = readFileSync(join(docsAi, '.memory-version'), 'utf8').trim();
    const workflowStamp = readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim();
    assert.equal(memoryStamp, stamp.LINEAGE_HEAD);
    assert.equal(workflowStamp, stamp.LINEAGE_HEAD);
    assert.equal(memoryStamp, LINEAGE_HEAD, 'substrate and root agree on the lineage head');
    await assertBlockAtStart(readFileSync(entry, 'utf8'), readFileSync(template, 'utf8'));
  });
});

// The path most likely to hit a stamp conflict: a project first bootstrapped by the composition
// root's FALLBACK (only .workflow-version), then the substrate is installed and the project is
// upgraded. The substrate's upgrade takeover must reconcile the stamps without a downgrade — and
// must STOP on a stamp newer than the lineage head rather than guess.
describe('transition — a fallback project later adopts the substrate', () => {
  it('takeover copies the fallback stamp verbatim into .memory-version (no STOP), idempotently', async () => {
    const { docsAi } = makeProject();
    writeFileSync(join(docsAi, '.workflow-version'), `${LINEAGE_HEAD}\n`); // a kit-fallback deployment

    const first = await stamp.applyTakeover(docsAi);
    assert.equal(first.status, 'ok', first.note);
    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD, 'copied verbatim');
    assert.equal(readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim(), LINEAGE_HEAD, 'legacy stamp left in place');

    const second = await stamp.applyTakeover(docsAi); // a second upgrade sees .memory-version → no-op
    assert.equal(second.status, 'ok');
    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD, 'idempotent');
  });

  it('a fallback stamp newer than the lineage head halts the takeover (STOP) and writes nothing', async () => {
    const { docsAi } = makeProject();
    writeFileSync(join(docsAi, '.workflow-version'), '9.9.9\n'); // newer than the lineage head

    const decision = await stamp.applyTakeover(docsAi);
    assert.equal(decision.status, 'stop');
    assert.ok(!existsSync(join(docsAi, '.memory-version')), 'STOP writes no stamp');
    assert.equal(readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim(), '9.9.9', 'prior stamp left intact');
  });
});

// Upgrade safety: a prior-lineage entry point with no kit block gets the block at its start, every
// old byte after it unchanged — the old pointer pairs included, whose removal is the lineage migration's.
describe('backward compatibility — a prior-lineage deployment is reconciled on upgrade', () => {
  it('a prior entry point with no kit block gets it at its start, every old byte after it', async () => {
    const { project } = makeProject();
    const entry = join(project, 'AGENTS.md');
    writeFileSync(entry, LEGACY_ENTRY);
    reconcile(entry);
    await assertBlockAtStart(readFileSync(entry, 'utf8'), LEGACY_ENTRY);
  });

  it('a prior entry point holding the old pointer pairs keeps them byte for byte below the block', async () => {
    const { project } = makeProject();
    const entry = join(project, 'AGENTS.md');
    const pairs = ['methodology', 'orchestration', 'autonomy'].map((name) => `<!-- workflow:${name}:start -->\nnotes the user wrote\n<!-- workflow:${name}:end -->`);
    const legacy = `${LEGACY_ENTRY}${pairs.join('\n')}\n`;
    writeFileSync(entry, legacy);
    reconcile(entry);
    await assertBlockAtStart(readFileSync(entry, 'utf8'), legacy);
  });

  it('an upgrade touches only the artifacts it owns — unrelated project files stay intact (block reconcile)', async () => {
    const { project, docsAi } = makeProject();
    const entry = join(project, 'AGENTS.md');
    writeFileSync(entry, LEGACY_ENTRY);
    writeFileSync(join(docsAi, '.workflow-version'), `${LINEAGE_HEAD}\n`);
    mkdirSync(join(project, '.claude'), { recursive: true });
    const settings = `${JSON.stringify({ includeCoAuthoredBy: false }, null, 2)}\n`;
    writeFileSync(join(project, '.claude', 'settings.json'), settings);
    const userDoc = '# my own decisions\n';
    writeFileSync(join(docsAi, 'decisions.md'), userDoc);

    // The two upgrade seams that actually write: the substrate stamp takeover + the block reconcile.
    await stamp.applyTakeover(docsAi);
    reconcile(entry);

    assert.equal(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'), settings, 'user settings untouched');
    assert.ok(!readFileSync(join(project, '.claude', 'settings.json'), 'utf8').includes('permissions'), 'upgrade never seeds velocity permissions.* into settings.json (velocity is never auto-run)');
    assert.equal(readFileSync(join(docsAi, 'decisions.md'), 'utf8'), userDoc, 'user-authored doc untouched');
    assert.equal(readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim(), LINEAGE_HEAD, 'legacy stamp preserved');
    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD, 'takeover reconciled the stamp');
    await assertBlockAtStart(readFileSync(entry, 'utf8'), LEGACY_ENTRY);
  });
});

// AD-019 — the CLI-backed deploy seam: the REAL `inject-methodology.mjs reconcile` against the REAL
// local engine writes the engine's three fragments into the block live (the methodology one carrying
// the procedures auto-discovery route). Plus the kit-fallback config seed: the kit ships
// `references/templates/orchestration.json`, seeds it into docs/ai, and the real op judges its note.
describe('composition root — CLI-backed reconcile + config seed (real engine, AD-019)', () => {
  const KIT_ORCH_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'orchestration.json');

  it('fallback and delegated deploy: the block carries the three engine fragments live, the methodology one routing to procedures', async () => {
    const fragments = [ENGINE_FRAGMENT_REL, ORCHESTRATION_FRAGMENT_REL, AUTONOMY_FRAGMENT_REL].map((rel) => readFileSync(join(ENGINE_DIR, rel), 'utf8').trim());
    for (const template of [KIT_ENTRY_TEMPLATE, join(substrateDir, 'references', 'templates', 'AGENTS.md')]) {
      const { project } = makeProject();
      const entry = join(project, 'AGENTS.md');
      cpSync(template, entry);
      reconcile(entry);
      const { body } = await kitBlock(readFileSync(entry, 'utf8'));
      const at = fragments.map((fragment) => body.indexOf(fragment));
      assert.ok(at.every((index, n) => index > (n === 0 ? -1 : at[n - 1])), `${template}: the three fragments, in order`);
      assert.match(body, /\/agent-workflow-kit procedures/, 'the methodology fragment routes to the procedures advisor');
    }
  });

  it('spec:orchestration-note/S6 fallback deploy: the kit seeds docs/ai/orchestration.json; the real orchestration op writes the note current, keeping every recipe', () => {
    const { project, docsAi } = makeProject();
    const dest = join(docsAi, 'orchestration.json');
    // bootstrap step 6 seed (the template loop copies the kit's own config template into docs/ai)
    cpSync(KIT_ORCH_TEMPLATE, dest);
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(KIT_ORCH_TEMPLATE, 'utf8'), 'seeded byte-identical to the kit template');

    // The kit-owned upgrade config-ensure (upgrade step 3), driven through the real op.
    const ensure = () => ensureOrchestration({ cwd: project, deps: {} });

    // (a) a prior-canonical _README on an edited config → the note is REFRESHED, the recipe preserved.
    writeFileSync(dest, serializeConfig({ _README: KNOWN_PRIOR_README[0], 'plan-execution': { execute: 'delegated' } }));
    ensure();
    const refreshed = JSON.parse(readFileSync(dest, 'utf8'));
    assert.equal(refreshed._README, CANON_README, 'a prior-canonical note is refreshed to the current canon');
    assert.equal(refreshed['plan-execution'].execute, 'delegated', 'the edited recipe is preserved through the refresh');

    // (b) a differing note is written current, the recipe kept.
    writeFileSync(dest, serializeConfig({ _README: 'another note', 'plan-execution': { execute: 'delegated' } }));
    ensure();
    assert.deepEqual(JSON.parse(readFileSync(dest, 'utf8')), { _README: CANON_README, 'plan-execution': { execute: 'delegated' } }, 'a differing note is written current');

    // (c) a malformed config is left untouched (never parsed into a clobber).
    writeFileSync(dest, '{ not valid json');
    ensure();
    assert.equal(readFileSync(dest, 'utf8'), '{ not valid json', 'a malformed config is left byte-identical');

    // (d) a missing config is seeded again, the kit template's bytes.
    rmSync(dest);
    ensure();
    assert.equal(readFileSync(dest, 'utf8'), readFileSync(KIT_ORCH_TEMPLATE, 'utf8'), 'a missing config is seeded again');
  });
});

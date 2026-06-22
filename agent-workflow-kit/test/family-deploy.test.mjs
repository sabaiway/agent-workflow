// End-to-end acceptance for the composition root's two deploy paths, tying the executable
// hand-off contract (detectMemory / handoffPlan) to the artifacts that actually land on disk.
//
//   fallback  (substrate absent)  → bundled entry point with an EMPTY slot the root reconciles +
//                                   fills, .workflow-version ONLY
//   delegate  (substrate present) → substrate writes .memory-version + empty slot; the root injects
//                                   the bounded fragment and writes .workflow-version → BOTH stamps
//
// The delegate path installs the substrate skill via its OWN published installer into a temp dir
// and drives the real installed payload — so this also proves the hand-off seam end to end.
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
import {
  injectMethodology,
  reconcileSlot,
  extractSlot,
  AGENTS_MD_CAP,
  START_MARKER,
  END_MARKER,
} from '../tools/inject-methodology.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAMILY_ROOT = resolve(KIT_ROOT, '..');
const SUBSTRATE_INSTALLER = join(FAMILY_ROOT, 'agent-workflow-memory', 'bin', 'install.mjs');
const KIT_ENTRY_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'AGENTS.md');
const KIT_METHODOLOGY = join(KIT_ROOT, 'tools', 'methodology-slot.md');

// The shared deployment-lineage head the composition root stamps in BOTH paths. The root knows it
// independently of the substrate package version (SKILL.md bootstrap step 10) — hard-coded here so
// the fallback path asserts it without importing the substrate (which, in fallback, is absent).
const LINEAGE_HEAD = '1.3.0';

// A realistic pre-slot ("markerless") deployment: it carries the Session-Protocols ANCHOR line the
// reconcile inserts the slot after, but no slot markers yet (it predates the methodology slot).
const LEGACY_WITH_ANCHOR = [
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

  it('deploys the bundled entry point (empty slot), reconciles it FILLED, stamps .workflow-version ONLY', () => {
    const { project, docsAi } = makeProject();
    cpSync(KIT_ENTRY_TEMPLATE, join(project, 'AGENTS.md'));

    // The bundled entry point now ships an EMPTY methodology slot (Plan 2). The kit reconciles it —
    // ensure (already present) + inject-because-empty — so the fallback path ends with a FILLED slot.
    const fragment = readFileSync(KIT_METHODOLOGY, 'utf8');
    const result = reconcileSlot(readFileSync(join(project, 'AGENTS.md'), 'utf8'), fragment, {
      maxLines: AGENTS_MD_CAP,
    });
    assert.equal(result.status, 'reconciled-filled');
    writeFileSync(join(project, 'AGENTS.md'), result.text);
    assert.equal(extractSlot(readFileSync(join(project, 'AGENTS.md'), 'utf8')).trim(), fragment.trim());

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

  it('substrate stamps + root injects → BOTH stamps present and the slot is filled under cap', async () => {
    const { project, docsAi } = makeProject();

    // Substrate side: deploy its entry point (with the empty slot) and stamp .memory-version
    // atomically, both from the INSTALLED payload — the real delegated hand-off.
    cpSync(join(substrateDir, 'references', 'templates', 'AGENTS.md'), join(project, 'AGENTS.md'));
    await stamp.writeStampAtomic(join(docsAi, '.memory-version'), stamp.LINEAGE_HEAD);

    // Composition-root side: inject the bounded fragment into the slot, then write the second
    // stamp. (Exactly one commit gate would follow injection — not exercised by this test.)
    const fragment = readFileSync(KIT_METHODOLOGY, 'utf8');
    const result = injectMethodology(readFileSync(join(project, 'AGENTS.md'), 'utf8'), fragment, {
      maxLines: AGENTS_MD_CAP,
    });
    assert.equal(result.status, 'injected', 'the empty slot accepts the fragment');
    writeFileSync(join(project, 'AGENTS.md'), result.text);
    writeFileSync(join(docsAi, '.workflow-version'), `${stamp.LINEAGE_HEAD}\n`);

    const memoryStamp = readFileSync(join(docsAi, '.memory-version'), 'utf8').trim();
    const workflowStamp = readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim();
    assert.equal(memoryStamp, stamp.LINEAGE_HEAD);
    assert.equal(workflowStamp, stamp.LINEAGE_HEAD);
    assert.equal(memoryStamp, LINEAGE_HEAD, 'substrate and root agree on the lineage head');

    const filled = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.equal(extractSlot(filled).trim(), fragment.trim(), 'the slot now carries the bounded fragment');
    const lineCount = filled.split('\n').length - (filled.endsWith('\n') ? 1 : 0);
    assert.ok(lineCount <= AGENTS_MD_CAP, `entry point within the ${AGENTS_MD_CAP}-line cap (got ${lineCount})`);
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

// Upgrade safety (Plan 2): a markerless prior-lineage entry point (one that predates the
// methodology slot) now gets the slot ADDED at its Session-Protocols anchor, with every other byte
// preserved; an empty slot is filled; a user-customized slot is preserved verbatim.

describe('backward compatibility — a prior-lineage deployment is reconciled on upgrade', () => {
  it('a markerless prior entry point gets the slot inserted at the anchor, all other bytes preserved', () => {
    const legacy = LEGACY_WITH_ANCHOR;
    assert.equal(legacy.includes('workflow:methodology'), false, 'precondition: the fixture predates the slot');
    const fragment = readFileSync(KIT_METHODOLOGY, 'utf8');
    const result = reconcileSlot(legacy, fragment, { maxLines: AGENTS_MD_CAP });
    assert.equal(result.status, 'reconciled-inserted');
    assert.equal(extractSlot(result.text).trim(), fragment.trim(), 'the inserted slot is filled');
    for (const line of legacy.split('\n').filter(Boolean)) {
      assert.ok(result.text.includes(line), `original line preserved: ${line}`);
    }
  });

  it('a user-customized slot is preserved verbatim on reconcile (never regenerated)', () => {
    const custom = 'methodology notes the user wrote\nand a second line';
    const entry = `# Entry\n\n${START_MARKER}\n${custom}\n${END_MARKER}\n\n# Tail\n`;
    assert.equal(extractSlot(entry).trim(), custom, 'the user content is what lives in the slot');

    const result = reconcileSlot(entry, readFileSync(KIT_METHODOLOGY, 'utf8'), { maxLines: AGENTS_MD_CAP });
    assert.equal(result.status, 'present-filled');
    assert.equal(result.text, entry, 'the customization survives byte-for-byte — not replaced by the bundled fragment');
  });

  it('an upgrade touches only the artifacts it owns — unrelated project files stay intact', async () => {
    const { project, docsAi } = makeProject();
    const legacy = LEGACY_WITH_ANCHOR;
    writeFileSync(join(project, 'AGENTS.md'), legacy);
    writeFileSync(join(docsAi, '.workflow-version'), `${LINEAGE_HEAD}\n`);
    mkdirSync(join(project, '.claude'), { recursive: true });
    const settings = `${JSON.stringify({ includeCoAuthoredBy: false }, null, 2)}\n`;
    writeFileSync(join(project, '.claude', 'settings.json'), settings);
    const userDoc = '# my own decisions\n';
    writeFileSync(join(docsAi, 'decisions.md'), userDoc);

    // The two upgrade seams that actually write: the substrate stamp takeover + the slot reconcile.
    await stamp.applyTakeover(docsAi);
    const fragment = readFileSync(KIT_METHODOLOGY, 'utf8');
    const reconciled = reconcileSlot(readFileSync(join(project, 'AGENTS.md'), 'utf8'), fragment, {
      maxLines: AGENTS_MD_CAP,
    });
    assert.equal(reconciled.status, 'reconciled-inserted');
    writeFileSync(join(project, 'AGENTS.md'), reconciled.text);

    assert.equal(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'), settings, 'user settings untouched');
    assert.equal(readFileSync(join(docsAi, 'decisions.md'), 'utf8'), userDoc, 'user-authored doc untouched');
    assert.equal(readFileSync(join(docsAi, '.workflow-version'), 'utf8').trim(), LINEAGE_HEAD, 'legacy stamp preserved');
    assert.equal(readFileSync(join(docsAi, '.memory-version'), 'utf8').trim(), LINEAGE_HEAD, 'takeover reconciled the stamp');
    const entry = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    assert.equal(extractSlot(entry).trim(), fragment.trim(), 'the entry point now carries the filled slot');
    assert.ok(entry.includes('Read it before any code change.'), 'the anchor and surrounding content survive');
  });
});

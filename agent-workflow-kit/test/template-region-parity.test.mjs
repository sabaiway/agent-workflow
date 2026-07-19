// template-region-parity.test.mjs — the AD-038 discovery-line template guard: the §1.1 session-start
// region of the kit and memory `agent_rules.md` templates, and the "Active recipes:" handover slot
// line of the kit and memory `handover.md` templates, stay BYTE-IDENTICAL across the two packages
// (the two templates deliberately diverge elsewhere — §1.3/§2.x/§5 — so the whole-file parity guard
// cannot cover these regions). Both regions stay PATH-NEUTRAL: the memory substrate names no sibling
// skill (AD-019 knows-nobody DAG), so `/agent-workflow-kit` never appears in either template region —
// the kit-command convenience lives only in the kit SKILL/README and a project's own dogfood files.
// Non-vacuity: an injected divergence must be caught by the same extractor + comparator.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_TEMPLATES = join(HERE, '..', 'references', 'templates');
const MEMORY_TEMPLATES = join(HERE, '..', '..', 'agent-workflow-memory', 'references', 'templates');

const read = (root, name) => readFileSync(join(root, name), 'utf8');

// The §1.1 region: its heading line through (exclusive) the next `### ` heading.
const extractSessionStartRegion = (text) => {
  const heading = '### 1.1. Start of Session';
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, 'the §1.1 heading exists');
  const next = text.indexOf('### ', start + heading.length);
  return text.slice(start, next === -1 ? text.length : next);
};

// The handover slot: the single line starting `**Active recipes:**`.
const extractActiveRecipesLine = (text) => {
  const lines = text.split('\n').filter((l) => l.startsWith('**Active recipes:**'));
  assert.equal(lines.length, 1, 'exactly one "**Active recipes:**" slot line');
  return lines[0];
};

describe('agent_rules.md §1.1 — kit and memory template regions are byte-identical', () => {
  const kit = extractSessionStartRegion(read(KIT_TEMPLATES, 'agent_rules.md'));
  const memory = extractSessionStartRegion(read(MEMORY_TEMPLATES, 'agent_rules.md'));

  it('the two §1.1 regions match byte-for-byte', () => {
    assert.equal(kit, memory, 'kit and memory agent_rules.md §1.1 regions have drifted — edit both in the same change');
  });

  it('the region carries the orchestration.json discovery step, before the pick-a-task step', () => {
    assert.match(kit, /orchestration\.json/);
    assert.match(kit, /CONFIGURED orchestration recipes/);
    assert.ok(
      kit.indexOf('orchestration.json') < kit.indexOf('active_plan.md'),
      'the config is read BEFORE a task is picked',
    );
    assert.match(kit, /silent recipe downgrade/);
  });

  it('the region is path-neutral in BOTH templates (no sibling-skill mention)', () => {
    for (const region of [kit, memory]) {
      assert.ok(!region.includes('agent-workflow-kit'), 'template §1.1 never names the kit');
      assert.ok(!region.includes('--active-line'), 'template §1.1 never names the kit flag');
    }
  });

  it('non-vacuous: an injected divergence is caught by the same extractor + comparator', () => {
    const mutated = read(KIT_TEMPLATES, 'agent_rules.md').replace('orchestration.json', 'orchestration.json5');
    assert.notEqual(extractSessionStartRegion(mutated), memory, 'the guard detects a one-byte region divergence');
  });
});

// The §2.5 Communication region: its heading line through (exclusive) the next `### ` heading.
// AD-061 supersedes the AD-054 memory-only Communication-twin pin: BOTH templates now carry the
// section byte-identically (the kit fallback deploy path must communicate under the same bar).
const extractCommunicationRegion = (text) => {
  const heading = '### 2.5. Communication (user-facing messages)';
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, 'the §2.5 Communication heading exists');
  const next = text.indexOf('### ', start + heading.length);
  return text.slice(start, next === -1 ? text.length : next);
};

describe('agent_rules.md §2.5 Communication — kit and memory template regions are byte-identical (AD-061)', () => {
  const kit = extractCommunicationRegion(read(KIT_TEMPLATES, 'agent_rules.md'));
  const memory = extractCommunicationRegion(read(MEMORY_TEMPLATES, 'agent_rules.md'));

  it('the two §2.5 regions match byte-for-byte', () => {
    assert.equal(kit, memory, 'kit and memory agent_rules.md §2.5 regions have drifted — edit both in the same change');
  });

  it('the region carries the plain-language bar (the AD-061 communication contract)', () => {
    for (const token of [
      'Plain language',
      'plain words of the dialogue language',
      'transliterated English jargon is banned',
      'NAME of a thing',
      'glossed in plain words',
      'plain English stays plain',
    ]) {
      assert.ok(kit.includes(token), `the §2.5 region is missing the plain-language token "${token}"`);
    }
  });

  it('the region keeps the report-facts bullet (the AD-054 tokens ride into both templates)', () => {
    for (const token of ['live tool output', 'context, never report facts']) {
      assert.ok(kit.includes(token), `the §2.5 region is missing the report-facts token "${token}"`);
    }
  });

  it('non-vacuous: an injected divergence is caught by the same extractor + comparator', () => {
    const mutated = read(KIT_TEMPLATES, 'agent_rules.md').replace('Plain language', 'Fancy language');
    assert.notEqual(extractCommunicationRegion(mutated), memory, 'the guard detects a region divergence');
  });

  it('the §2.5 region is immediately followed by the §2.6 lens heading in BOTH templates (the renumber pin)', () => {
    for (const [label, text] of [
      ['kit', read(KIT_TEMPLATES, 'agent_rules.md')],
      ['memory', read(MEMORY_TEMPLATES, 'agent_rules.md')],
    ]) {
      const region = extractCommunicationRegion(text);
      const after = text.slice(text.indexOf(region) + region.length);
      assert.ok(after.startsWith('### 2.6. Planning, review & process-fidelity invariants'),
        `${label}: §2.5 Communication must be immediately followed by the §2.6 lens heading`);
      assert.equal((text.match(/^### 2\.5\./gm) ?? []).length, 1, `${label}: exactly one §2.5 heading`);
      assert.equal((text.match(/^### 2\.6\./gm) ?? []).length, 1, `${label}: exactly one §2.6 heading`);
    }
  });

  it('non-vacuous: a doctored kit template with the lens back at 2.5 fails the renumber pin (injected)', () => {
    const doctored = read(KIT_TEMPLATES, 'agent_rules.md').replace('### 2.6. Planning', '### 2.5. Planning');
    const region = extractCommunicationRegion(doctored);
    const after = doctored.slice(doctored.indexOf(region) + region.length);
    assert.ok(!after.startsWith('### 2.6. Planning'), 'the doctored regression must be caught by pin (a)');
  });
});

describe('handover.md "Active recipes:" slot — kit and memory template lines are byte-identical', () => {
  const kitFile = read(KIT_TEMPLATES, 'handover.md');
  const memoryFile = read(MEMORY_TEMPLATES, 'handover.md');
  const kit = extractActiveRecipesLine(kitFile);
  const memory = extractActiveRecipesLine(memoryFile);

  it('the two slot lines match byte-for-byte', () => {
    assert.equal(kit, memory, 'kit and memory handover.md "Active recipes:" slot lines have drifted — edit both in the same change');
  });

  it('the slot points at the config and demands a refresh-on-change (path-neutral)', () => {
    assert.match(kit, /orchestration\.json/);
    assert.match(kit, /refresh/);
    assert.ok(!kit.includes('agent-workflow-kit'), 'the template slot line never names the kit');
  });

  it('non-vacuous: an injected divergence is caught by the same extractor + comparator', () => {
    const mutated = kitFile.replace('**Active recipes:**', '**Active recipes:** DRIFTED —');
    assert.notEqual(extractActiveRecipesLine(mutated), memory, 'the guard detects a slot-line divergence');
  });
});

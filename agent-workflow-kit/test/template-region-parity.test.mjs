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
const LF = String.fromCharCode(10);
const RULES_FILE = 'agent_rules.md';
const SESSION_CLOSE_LEAD = '- **Two blocks for the user.**';
const TASK_PHRASE = 'one task per session';
const KIT_PATH_RE = /agent-workflow-kit|<kit>|tools\//;
const FOR_THE_USER = '## For the user';
const LABELS = ['**What was done, and for what:**', '**What is next, and why:**'];
const PLACEHOLDER_RE = /\{\{|TODO|<[a-z]/i;
const STORY_HEADING = '### 2.7. Story sessions';
const LENS_HEADING = '### 2.6. Planning, review & process-fidelity invariants';
const STRUCTURAL_BOUNDARY = /^(---$|## |### )/;
// The literal Story sessions canon, split at its em dashes so no source line passes the line cap.
const STORY_CANON = [
  "A story ",
  " one row of an epic's ledger, carried by one plan ",
  " runs as five sessions, each ending at its own review checkpoint: **spec** (the contract under `docs/ai/specs/`, drafted and reviewed on the `plan-authoring` recipe), **plan** (the ledger, same recipe), **tests** (one task per ledger row, red first), **code** (one task per row, to green), and **diff review, release and record** (the review of the staged tree on the `plan-execution` recipe, the release where the story ships one, then the changelog and handover entries and the plan's Phase: Cleanup). Tests and code never share a session, and a spec and its plan never share one either. A storyless plan runs the same five. **Exception ",
  " a split:** moving code and its existing cases into modules, with no new logic and no new case, is one session: a short spec (the Module list), the split, the diff review, the release, Cleanup. Inside the tests and code sessions it is one task per session: each task runs as its own carrier session ",
  " one brief, one run, never one run for a whole wave ",
  " and the orchestrator's session briefs, checks, verifies and folds.",
].join(String.fromCharCode(8212));

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

const extractStoryRegion = (text, heading = STORY_HEADING) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `${heading} exists in the template`);
  const tail = lines.slice(start + 1);
  const boundary = tail.findIndex((line) => STRUCTURAL_BOUNDARY.test(line));
  return [heading, ...tail.slice(0, boundary === -1 ? undefined : boundary)].join(LF) + (boundary === -1 ? '' : LF);
};

describe('Story sessions template twins spec:rules-regions/S19', () => {
  it('the two Story sessions regions match byte-for-byte', () => {
    const kit = extractStoryRegion(read(KIT_TEMPLATES, RULES_FILE));
    const memory = extractStoryRegion(read(MEMORY_TEMPLATES, RULES_FILE));
    assert.equal(kit, memory);
  });
  it('section 2.6 is immediately followed by section 2.7 in both templates', () => {
    for (const root of [KIT_TEMPLATES, MEMORY_TEMPLATES]) {
      const text = read(root, RULES_FILE);
      const lens = extractStoryRegion(text, LENS_HEADING);
      assert.ok(text.slice(text.indexOf(lens) + lens.length).startsWith(STORY_HEADING), root);
    }
  });
  it('both Story sessions bodies equal the literal canon', () => {
    for (const root of [KIT_TEMPLATES, MEMORY_TEMPLATES]) {
      const region = extractStoryRegion(read(root, RULES_FILE));
      assert.equal(region, [STORY_HEADING, STORY_CANON, '', ''].join(LF), root);
    }
  });
  it('the parity comparison rejects a twin changed in memory', () => {
    const kit = extractStoryRegion(read(KIT_TEMPLATES, RULES_FILE));
    const memory = extractStoryRegion(read(MEMORY_TEMPLATES, RULES_FILE));
    assert.equal(kit, memory);
    const changed = memory.replace(STORY_CANON, STORY_CANON.toUpperCase());
    assert.notEqual(memory, changed);
    assert.throws(() => assert.equal(kit, changed), assert.AssertionError);
  });
});

describe('spec:session-rules/S1 the session-close bullet and the one-task sentence in both templates', () => {
  for (const [label, root] of [['kit', KIT_TEMPLATES], ['memory', MEMORY_TEMPLATES]]) {
    it(`the Communication region ends with the Two blocks for the user bullet: ${label}`, () => {
      const lines = extractCommunicationRegion(read(root, RULES_FILE)).split(LF).filter((line) => line.trim() !== '');
      assert.ok(lines.at(-1).startsWith(SESSION_CLOSE_LEAD), lines.at(-1));
      assert.equal(lines.filter((line) => line.includes('Two blocks for the user')).length, 1);
    });

    it(`the Story sessions body line ends with the one-task sentence: ${label}`, () => {
      const [, body] = extractStoryRegion(read(root, RULES_FILE)).split(LF);
      assert.match(body.slice(body.lastIndexOf('. ') + 2), new RegExp(TASK_PHRASE));
      assert.equal(body.split(TASK_PHRASE).length, 2);
    });

    it(`neither region names a kit path: ${label}`, () => {
      const text = read(root, RULES_FILE);
      for (const region of [extractCommunicationRegion(text), extractStoryRegion(text)]) assert.doesNotMatch(region, KIT_PATH_RE);
    });
  }
});

describe('spec:session-rules/S4 the handover section and the changelog field in both templates', () => {
  for (const [label, root] of [['kit', KIT_TEMPLATES], ['memory', MEMORY_TEMPLATES]]) {
    it(`the handover carries the section once, after the Active recipes line and before the last-session block: ${label}`, () => {
      const lines = read(root, 'handover.md').split(LF);
      const start = lines.indexOf(FOR_THE_USER);
      assert.equal(lines.filter((line) => line === FOR_THE_USER).length, 1);
      assert.ok(lines.findIndex((line) => line.startsWith('**Active recipes:**')) < start);
      assert.ok(start < lines.indexOf('## What was done last session'));
      const section = lines.slice(start + 1, lines.findIndex((line, index) => index > start && line.startsWith('## ')));
      const at = LABELS.map((label) => section.indexOf(label));
      assert.deepEqual(LABELS.map((label) => section.filter((line) => line === label).length), [1, 1]);
      assert.ok(at[0] < at[1], 'the labels stand in order');
      for (const [index, from] of at.entries()) {
        const text = section.slice(from + 1, index === 0 ? at[1] : undefined).filter((line) => line.trim() !== '');
        assert.equal(text.length, 1, LABELS[index]);
        assert.ok(text[0].startsWith('- '), text[0]);
        assert.doesNotMatch(text[0], PLACEHOLDER_RE);
      }
    });

    it(`the changelog entry carries the For the user field line after Goal and no such heading: ${label}`, () => {
      const lines = read(root, 'changelog.md').split(LF);
      const field = lines.findIndex((line) => line.startsWith('**For the user:** '));
      assert.equal(lines.filter((line) => line.startsWith('**For the user:**')).length, 1);
      assert.ok(lines.findIndex((line) => line.startsWith('**Goal:**')) < field);
      assert.ok(field < lines.findIndex((line) => line.startsWith('**Changes:**')));
      assert.ok(!lines.some((line) => /^#+ .*For the user/.test(line)));
    });
  }

  it('the kit mirrors of both templates are byte-identical to the memory originals', () => {
    for (const name of ['handover.md', 'changelog.md']) {
      assert.ok(readFileSync(join(KIT_TEMPLATES, name)).equals(readFileSync(join(MEMORY_TEMPLATES, name))), name);
    }
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

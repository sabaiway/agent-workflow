import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, OUTCOME_LINES, frontmatterMaxLines } from '../lens-region.mjs';
import { PROFILE_GAPS } from '../profile-gaps.mjs';

const lens = await import('../lens-region.mjs').catch(() => ({}));
const regions = await import('../rules-regions.mjs').catch(() => ({}));
const requireExport = (module, name) => module[name] ?? (() => {
  throw new Error(name + ' is absent');
});
const reconcileStoryText = requireExport(lens, 'reconcileStoryText');
const extractStoryRegion = requireExport(lens, 'extractStoryRegion');
const normalizeStoryBody = requireExport(lens, 'normalizeStoryBody');
const renderStory = requireExport(lens, 'renderStory');
const exceedsCap = requireExport(regions, 'exceedsCap');

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', '..', '..', 'agent-workflow-engine');
const TEMPLATE_PATH = join(HERE, '..', '..', 'references', 'templates', 'agent_rules.md');
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const BACKTICK = String.fromCharCode(96);
const CONTROL_BYTE = String.fromCharCode(1);
const SERVED_TARGET = 'docs/ai/agent_rules.md';
const PREVIEW_CAP = 150;
const EXIT_OK = 0;
const EXIT_STOP = 1;
const NOT_FOUND = -1;
const TARGET_CAP = 12;
const REFRESHED_LINE_COUNT = 13;
const OWN_NUMBER = '19';
const COMMS_LABEL = '### 2.x. Communication (user-facing messages)';
const STORY_LABEL = '### 2.x. Story sessions';
const LENS_LABEL = '### 2.x. Planning, review & process-fidelity invariants';
const COMMS_REGION = ['### 2.5. Communication (user-facing messages)', 'Communicate plainly.'].join(LF);
const STORY_HEADING = '### 2.7. Story sessions';
const OWN_HEADING = '### 2.' + OWN_NUMBER + '. Story sessions';
const STORY_BODY = ['Review the specification.', 'Review the plan.', 'Write tests.', 'Implement and review.'];
const STORY_REGION = [STORY_HEADING, ...STORY_BODY].join(LF);
const STORY_CANON = [STORY_LABEL, ...STORY_BODY].join(LF);
const OWN_STORY = [OWN_HEADING, ...STORY_BODY].join(LF);
const PRIOR_BODY = 'The earlier story procedure.';
const PRIOR_CANON = [STORY_LABEL, PRIOR_BODY].join(LF);
const PRIOR_REGION = [OWN_HEADING, PRIOR_BODY].join(LF);
const CUSTOM_STORY = [STORY_HEADING, '  Keep my wording and spacing.  ', '', 'My local rule.'].join(LF);
const CUSTOM_LENS = ['### 2.6. Planning, review & process-fidelity invariants', 'My local lens policy.'].join(LF);
const TEMPLATE = [COMMS_REGION, '', STORY_REGION, '', '---', ''].join(LF);
const REINSTALL = 'npx @sabaiway/agent-workflow-kit@latest init';
const STORY_CURRENT_RE = /story[- ]sessions.*current/i;
const NOTE_RE = /note:/i;
const STOP_RE = /STOP/;
const REFUSED_RE = /refused/i;
const NUMBERS_RE = /[0-9]+/g;
const FIRST_SPAN_RE = new RegExp(BACKTICK + '([^' + BACKTICK + ']+)' + BACKTICK);
const PLACEHOLDER_RE = /<kit>|<project>/;
const CONSENT_RE = /(^|[^a-z])yes([^a-z]|$)/i;
const DOUBLED_REGIONS = [
  { name: 'Communication', region: COMMS_REGION, label: COMMS_LABEL },
  { name: 'story sessions', region: STORY_REGION, label: STORY_LABEL },
  { name: 'lens', region: CUSTOM_LENS, label: LENS_LABEL },
];
const ABSENT_NOTES = [
  { name: 'Communication', composer: 'commsNoRegion' },
  { name: 'story sessions', composer: 'storyNoRegion' },
];

const createDocument = (blocks, cap = TARGET_CAP) => [
  '---', 'maxLines: ' + cap, '---', '# Rules', '',
  ...blocks.flatMap((block) => [block, '']),
  '## Tail', 'Keep tail.', '',
].join(LF);

const composeOutcome = (name, ...args) => {
  assert.equal(typeof OUTCOME_LINES[name], 'function', name + ' must exist');
  return OUTCOME_LINES[name](...args);
};

const createWriteSpy = () => {
  const calls = [];
  const wrap = (name) => async (...args) => {
    calls.push({ name, args });
    return fs[name](...args);
  };
  return {
    calls,
    methods: { writeFile: wrap('writeFile'), rename: wrap('rename'), rm: wrap('rm') },
  };
};

const createFixture = async (context, text, { served = false, suffix = '' } = {}) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'story-sessions-' + suffix));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = join(root, served ? SERVED_TARGET : 'agent_rules.md');
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, text, 'utf8');
  const before = await fs.readFile(target);
  const spy = createWriteSpy();
  return { root, target, before, spy };
};

const reconcileFixture = async (fixture, { template = TEMPLATE, engine = ENGINE_DIR } = {}) => {
  const logs = [];
  const errors = [];
  const events = [];
  const record = (channel, line) => {
    events.push({ channel, line });
    (channel === 'stdout' ? logs : errors).push(line);
  };
  const code = await runCli(['reconcile', fixture.target], {
    fs: {
      ...fs,
      ...fixture.spy.methods,
      readFile: async (path, encoding) => path === TEMPLATE_PATH ? template : fs.readFile(path, encoding),
    },
    env: { AGENT_WORKFLOW_ENGINE_DIR: engine },
    home: fixture.root,
    log: (line) => record('stdout', line),
    logError: (line) => record('stderr', line),
  });
  return { code, logs, errors, events };
};

const assertUnchanged = async (fixture) => {
  assert.deepEqual(await fs.readFile(fixture.target), fixture.before);
  assert.deepEqual(fixture.spy.calls, []);
};

const assertEmitted = (logs, lines) => {
  assert.ok(Array.isArray(lines));
  for (const line of lines) assert.ok(logs.includes(line), 'missing outcome: ' + line);
};

const readFirstSpan = (note) => {
  const match = note.match(FIRST_SPAN_RE);
  assert.ok(match, 'the note must contain a command span');
  return match[1];
};

const assertNoCommand = (fixture, result) => {
  assert.ok(result.logs.every((line) => !line.includes('rules-insert')));
  for (const { composer } of ABSENT_NOTES) {
    const lines = composeOutcome(composer, fixture.target, '');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(BACKTICK));
    assertEmitted(result.logs, lines);
  }
};

describe('story-sessions verdicts spec:rules-regions/S13', () => {
  it('reports the template canon current with no byte changed', async (context) => {
    const fixture = await createFixture(context, createDocument([COMMS_REGION, STORY_REGION]));
    const result = await reconcileFixture(fixture);
    assert.equal(result.code, EXIT_OK);
    await assertUnchanged(fixture);
    assert.ok(result.logs.some((line) => STORY_CURRENT_RE.test(line)), 'story current outcome is missing');
    assert.ok(result.logs.includes(composeOutcome('storyCurrent')));
  });

  it('preserves a custom story body byte-for-byte with its note', async (context) => {
    const text = createDocument([COMMS_REGION, CUSTOM_STORY]).split(LF).join(CRLF);
    const fixture = await createFixture(context, text);
    const result = await reconcileFixture(fixture);
    assert.equal(result.code, EXIT_OK);
    await assertUnchanged(fixture);
    const lines = composeOutcome('storyCustom');
    assertEmitted(result.logs, lines);
    assert.ok(lines.some((line) => NOTE_RE.test(line)), 'custom preservation must carry a note');
  });

  it('refreshes an injected prior at the document own section number', async (context) => {
    const fixture = await createFixture(context, createDocument([PRIOR_REGION]));
    const result = reconcileStoryText(fixture.before.toString('utf8'), STORY_CANON, [PRIOR_CANON]);
    assert.deepEqual(result, { status: 'refreshed', text: createDocument([OWN_STORY]) });
    assert.equal(extractStoryRegion(result.text).number, OWN_NUMBER);
    assert.equal(normalizeStoryBody(extractStoryRegion(result.text).body), STORY_CANON);
    assert.equal(renderStory(STORY_CANON, OWN_NUMBER), OWN_STORY);
    await assertUnchanged(fixture);
  });

  it('refuses the refreshed text over its own cap and composes the count without writing', async (context) => {
    const fixture = await createFixture(context, createDocument([PRIOR_REGION]));
    const original = fixture.before.toString('utf8');
    const cap = frontmatterMaxLines(original);
    const refreshed = reconcileStoryText(original, STORY_CANON, [PRIOR_CANON]);
    assert.equal(cap, TARGET_CAP);
    assert.deepEqual(refreshed, { status: 'refreshed', text: createDocument([OWN_STORY]) });
    const decision = exceedsCap(refreshed.text, cap);
    assert.equal(decision.over, true);
    assert.equal(decision.count, REFRESHED_LINE_COUNT);
    const line = composeOutcome('storyCapRefused', fixture.target, decision.count, cap);
    assert.ok(line.includes(fixture.target));
    const numbers = line.replace(fixture.target, '').match(NUMBERS_RE) ?? [];
    assert.ok(numbers.includes(String(REFRESHED_LINE_COUNT)));
    assert.ok(numbers.includes(String(cap)));
    assert.match(line, REFUSED_RE);
    await assertUnchanged(fixture);
  });

  for (const row of DOUBLED_REGIONS) {
    it('preserves doubled ' + row.name + ' headings with a shared note and no write', async (context) => {
      const text = createDocument([COMMS_REGION, STORY_REGION, CUSTOM_LENS, row.region]);
      const fixture = await createFixture(context, text);
      const result = await reconcileFixture(fixture);
      assert.equal(result.code, EXIT_OK);
      await assertUnchanged(fixture);
      const lines = composeOutcome('regionHeadingTwice', row.label, fixture.target);
      assertEmitted(result.logs, lines);
      assert.ok(lines.some((line) => NOTE_RE.test(line)), 'doubled heading must carry a note');
    });
  }
});

describe('story-sessions order and absent notes spec:rules-regions/S14', () => {
  it('prints the story verdict before an absent-engine STOP', async (context) => {
    const fixture = await createFixture(context, createDocument([COMMS_REGION, STORY_REGION, CUSTOM_LENS]));
    const result = await reconcileFixture(fixture, { engine: join(fixture.root, 'absent-engine') });
    assert.equal(result.code, EXIT_STOP);
    const storyIndex = result.events.findIndex((event) =>
      event.channel === 'stdout' && STORY_CURRENT_RE.test(event.line));
    const stopIndex = result.events.findIndex((event) =>
      event.channel === 'stderr' && STOP_RE.test(event.line));
    assert.notEqual(storyIndex, NOT_FOUND, 'story outcome is missing before the engine STOP');
    assert.notEqual(stopIndex, NOT_FOUND, 'engine STOP is missing');
    assert.ok(storyIndex < stopIndex);
    await assertUnchanged(fixture);
  });

  for (const row of ABSENT_NOTES) {
    it('offers the insert preview and waits for a yes in the absent ' + row.name + ' note', async (context) => {
      const fixture = await createFixture(context, createDocument([]), { served: true });
      const result = await reconcileFixture(fixture);
      assert.equal(result.code, EXIT_OK);
      await assertUnchanged(fixture);
      const lines = composeOutcome(row.composer, fixture.target, PROFILE_GAPS[0].apply(fixture.root));
      assertEmitted(result.logs, lines);
      const notes = lines.filter((line) => NOTE_RE.test(line)).join(LF);
      const command = 'node ' + join(HERE, '..', 'rules-insert.mjs') + ' --cwd ' + fixture.root;
      assert.equal(readFirstSpan(notes), command);
      assert.ok(result.events.every(({ line }) => !PLACEHOLDER_RE.test(line)));
      assert.ok(notes.includes(BACKTICK + '--apply' + BACKTICK));
      assert.match(notes, CONSENT_RE);
    });
  }
});

describe('runnable absent-section offers spec:rules-regions/S21', () => {
  for (const suffix of ['', 'with space-']) {
    it('runs the printed story preview for ' + (suffix || 'plain root'), async (context) => {
      const text = createDocument([COMMS_REGION], PREVIEW_CAP);
      const fixture = await createFixture(context, text, { served: true, suffix });
      const result = await reconcileFixture(fixture);
      assert.equal(result.code, EXIT_OK);
      const absent = composeOutcome('storyNoRegion', fixture.target, PROFILE_GAPS[0].apply(fixture.root))[0];
      const storyIndex = result.logs.indexOf(absent);
      assert.notEqual(storyIndex, NOT_FOUND);
      const span = readFirstSpan(result.logs[storyIndex + 1]);
      const preview = spawnSync('/bin/sh', ['-c', span], { encoding: 'utf8' });
      assert.equal(preview.status, EXIT_OK, preview.stderr);
      assert.ok(preview.stdout.includes('story-sessions: planned'));
      await assertUnchanged(fixture);
    });
  }

  it('prints only the absent lines for a target outside the served path', async (context) => {
    const fixture = await createFixture(context, createDocument([]));
    const result = await reconcileFixture(fixture);
    assert.equal(result.code, EXIT_OK);
    assertNoCommand(fixture, result);
    await assertUnchanged(fixture);
  });

  for (const [name, suffix] of [['control byte', CONTROL_BYTE], ['backtick', BACKTICK]]) {
    it('offers no command for a served root holding a ' + name, async (context) => {
      const fixture = await createFixture(context, createDocument([]), { served: true, suffix });
      const result = await reconcileFixture(fixture);
      assert.equal(result.code, EXIT_OK);
      assertNoCommand(fixture, result);
      assert.equal(PROFILE_GAPS[0].apply(fixture.root), '');
      await assertUnchanged(fixture);
    });
  }
});

it('STOPs before judging any region when a template heading occurs twice', async (context) => {
  const fixture = await createFixture(context, createDocument([COMMS_REGION, STORY_REGION]));
  const template = [COMMS_REGION, '', COMMS_REGION, '', STORY_REGION, '', '---', ''].join(LF);
  const result = await reconcileFixture(fixture, { template });
  assert.equal(result.code, EXIT_STOP);
  assert.deepEqual(result.logs, []);
  assert.ok(result.errors.some((line) => STOP_RE.test(line) && line.includes(REINSTALL)));
  await assertUnchanged(fixture);
});

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { SEED_CONFIG, serializeConfig } from '../tools/orchestration-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, '..');
const LF = String.fromCharCode(10);
const COMMUNICATION = `## ${String.fromCodePoint(0x1f5e3, 0xfe0f)} Communication language`;
const ATTRIBUTION = `## ${String.fromCodePoint(0x270d, 0xfe0f)} Attribution`;
const MEMORY_MAP = `## ${String.fromCodePoint(0x1f9ed)} Memory Map`;
const STORY_HEADING = '### 2.7. Story sessions';
const LENS_HEADING = '### 2.6. Planning, review & process-fidelity invariants';
const RULES_PATH = 'docs/ai/agent_rules.md';
const RULES_TEMPLATE = 'references/templates/agent_rules.md';
const RULES_CAP = 'maxLines: 150';
const SECTION_BOUNDARY = '---';
const INSERT_TOOL = 'rules-insert.mjs';
const APPLY_ARGS = ['--apply'];
const ENTRY_ARTIFACT = { path: 'AGENTS.md', key: 'entryPoint' };
const RULES_ARTIFACT = { path: RULES_PATH, key: 'rules' };
const CONFIG_PATH = 'docs/ai/orchestration.json';
const CONFIG_ARTIFACT = { path: CONFIG_PATH, key: 'config' };
const EPICS_PATH = 'docs/ai/epics';
const OFFER_TOOL = 'tier-preview.mjs';
const GATES_ARTIFACT = { path: 'docs/ai/gates.json', key: 'gates' };
const STORE_ROOT_PATH = 'docs/ai/specs/index.md';
const CHECKER_TOOL = 'checker-gates.mjs';
const DECLARED = [['plan-shape', 'plan-shape-cli.mjs', '--check --in-flight'], ['spec-check', 'spec-check-cli.mjs', '--all']];
// The SLOT_RECIPES value set of each target slot's type, written out by hand.
const SLOT_VALUES = [
  ['epic', 'author', ['solo', 'subagent']],
  ['epic', 'review', ['solo', 'reviewed', 'council']],
  ['task', 'author', ['solo', 'delegated', 'subagent']],
  ['task', 'execute', ['solo', 'delegated', 'subagent']],
];
const PRINTED_SLOT_RE = /^ {2}([a-z]+)\.([a-z]+) = ([a-z]+)/;
const PAYLOAD = ['references', 'launchers', 'migrations', 'tools', 'bridges'];
const STORIES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const ITEM_IDS = [
  'migration-notes-delivered',
  'migration-blocks-placed',
  'payload-converged',
  'story-sessions-section',
  'epic-task-slots',
  'epic-store-seeded',
  'checker-gates-declared',
  'session-close-rules',
  'named-queue-row-seed',
  'profile-gap-screen',
];
const DIGEST = '26479c9e029977963d5799bf2c564166c898fa4ba31e9199c56d7c8076e3d277';
const LANDED = new Set(['S1', 'S2', 'S3', 'S4']);
const PENDING = () => ({ reason: 'detector pending' });
const fixture = {};

const removeSpan = (text, heading) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return [...lines.slice(0, start), ...lines.slice(next < 0 ? lines.length : next)].join(LF);
};

const findRegion = (text, heading) => {
  const lines = text.split(LF);
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start
    && (line === SECTION_BOUNDARY || line.startsWith('## ') || line.startsWith('### ')));
  return { lines, start, end: next < 0 ? lines.length : next };
};

const removeRulesSpan = (text, heading) => {
  const region = findRegion(text, heading);
  if (!region) return text;
  const { lines, start, end } = region;
  return [...lines.slice(0, start), ...lines.slice(end)].join(LF);
};

const writeFixture = (path, bytes) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
};

const readProjectFile = (project, path) => {
  try {
    return { bytes: readFileSync(join(project, path)) };
  } catch (error) {
    return { error: error.message };
  }
};

const runTool = (home, project, name, extra = [], artifact = ENTRY_ARTIFACT) => {
  const tool = join(home, 'tools', name);
  if (!existsSync(tool)) {
    return { name, result: { absent: true }, [artifact.key]: readProjectFile(project, artifact.path) };
  }
  const result = spawnSync(process.execPath, [tool, '--cwd', project, ...extra], { encoding: 'utf8' });
  return {
    name,
    result: { code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message },
    [artifact.key]: readProjectFile(project, artifact.path),
  };
};

// S3's second artifact: the epic store listing, null when absent, else each entry with its kind and size.
const listEpics = (project) => {
  const path = join(project, EPICS_PATH);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory()) return [`${EPICS_PATH} is not a directory`];
  return readdirSync(path).sort().map((name) => {
    const entry = lstatSync(join(path, name));
    return `${name} ${entry.isFile() ? 'file' : 'other'} ${entry.size}`;
  });
};

const runOffer = (home, project, extra = []) => ({ ...runTool(home, project, OFFER_TOOL, extra, CONFIG_ARTIFACT), epics: listEpics(project) });

const listRegularFiles = (root, relative = '') => {
  const path = join(root, relative);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => {
    const child = relative ? `${relative}/${name}` : name;
    return listRegularFiles(root, child);
  }).sort();
};

const capturePayload = (home) => {
  try {
    return {
      trees: PAYLOAD.map((entry) => ({
        entry,
        installed: listRegularFiles(join(home, entry)),
        packaged: listRegularFiles(join(KIT, entry)),
      })),
      keptDirectory: lstatSync(join(home, 'references/user-kept-dir'), { throwIfNoEntry: false })?.isDirectory(),
      keptSymlink: lstatSync(join(home, 'tools/user-link'), { throwIfNoEntry: false })?.isSymbolicLink(),
      runtimeBytes: readFileSync(join(home, 'runtime-state.json')),
    };
  } catch (error) {
    return { error: error.message };
  }
};

const findCallGap = (calls) => {
  const failed = calls.find(({ result }) => result.absent || result.code !== 0);
  if (!failed) return null;
  if (failed.result.absent) return { reason: `${failed.name} is absent` };
  const detail = failed.result.stderr || failed.result.error || '';
  return { reason: `${failed.name} exited ${failed.result.code}: ${detail}` };
};

const detectNotes = (record) => {
  const gap = findCallGap(record.slices.S1);
  if (gap) return gap;
  const notes = [
    ['1.1.0', '1.1.0-communication-language.md', 'Migration 1.1.0-communication-language'],
    ['1.2.0', '1.2.0-agent-attribution.md', 'Migration 1.2.0-agent-attribution'],
    ['3.0.0', '3.0.0-hardened-core-loop.md', 'Migration 3.0.0-hardened-core-loop'],
    ['4.0.0', '4.0.0-full-flow-offer.md', 'Migration 4.0.0-full-flow-offer'],
  ];
  const expected = notes.map(([version, name, headline]) =>
    `note ${version} ${join(record.home, 'migrations', name)} :: ${headline}`);
  return record.slices.S1[0].result.stdout === expected.join(LF) + LF
    ? null : { reason: 'selected notes differ from the four pinned paths and headlines' };
};

const detectBlocks = (record) => {
  const gap = findCallGap(record.slices.S1);
  if (gap) return gap;
  const unreadable = record.slices.S1.find(({ entryPoint }) => entryPoint.error);
  if (unreadable) return { reason: `entry point unreadable: ${unreadable.entryPoint.error}` };
  const [notes, preview, apply, repeated] = record.slices.S1;
  if (!preview.entryPoint.bytes.equals(notes.entryPoint.bytes)) {
    return { reason: 'preview changed the entry point' };
  }
  const text = apply.entryPoint.bytes.toString('utf8');
  const lines = text.split(LF).map((line) => line.trimEnd());
  const communication = lines.indexOf(COMMUNICATION);
  const attribution = lines.indexOf(ATTRIBUTION);
  const memoryMap = lines.indexOf(MEMORY_MAP);
  const headingsPlaced = lines.filter((line) => line === COMMUNICATION).length === 1
    && lines.filter((line) => line === ATTRIBUTION).length === 1
    && communication < attribution && attribution < memoryMap;
  if (!headingsPlaced) return { reason: 'blocks are not present once in the required order' };
  if (!text.includes('Esperanto') || !text.includes('Agent attribution: off') || text.includes('{{COMM_LANGUAGE}}') || text.includes('{{AGENT_ATTRIBUTION}}')) {
    return { reason: 'block answers or placeholder substitution are incomplete' };
  }
  return repeated.entryPoint.bytes.equals(apply.entryPoint.bytes)
    ? null : { reason: 'second apply changed the entry point' };
};

const detectPayload = (record) => {
  const gap = findCallGap(record.slices.S1);
  if (gap) return gap;
  const payload = record.payload;
  if (payload.error) return { reason: `payload unreadable: ${payload.error}` };
  const mismatch = payload.trees.find(({ installed, packaged }) => !isDeepStrictEqual(installed, packaged));
  if (mismatch) return { reason: `${mismatch.entry} regular-file paths did not converge` };
  if (!payload.keptDirectory || !payload.keptSymlink) {
    return { reason: 'the seeded directory or symlink was not preserved' };
  }
  return payload.runtimeBytes.equals(record.runtimeBefore)
    ? null : { reason: 'runtime-state.json changed' };
};

const detectStorySessions = (record) => {
  const gap = findCallGap(record.slices.S2);
  if (gap) return gap;
  const unreadable = record.slices.S2.find(({ rules }) => rules.error);
  if (unreadable) return { reason: `rules unreadable: ${unreadable.rules.error}` };
  const [preview, apply, repeated] = record.slices.S2;
  if (!preview.rules.bytes.equals(record.rulesBefore)) {
    return { reason: 'preview changed the rules file' };
  }
  const text = apply.rules.bytes.toString('utf8');
  const lines = text.split(LF);
  const lens = lines.indexOf(LENS_HEADING);
  const story = findRegion(text, STORY_HEADING);
  if (!story || lens < 0 || story.start <= lens
    || lines.filter((line) => line === STORY_HEADING).length !== 1) {
    return { reason: 'story sessions heading is not present once after the lens' };
  }
  const template = findRegion(record.rulesTemplate, STORY_HEADING);
  if (!template) return { reason: 'story sessions template span is absent' };
  if (!isDeepStrictEqual(story.lines.slice(story.start, story.end),
    template.lines.slice(template.start, template.end))) {
    return { reason: 'story sessions span differs from the template bound to 2.7' };
  }
  return repeated.rules.bytes.equals(apply.rules.bytes)
    ? null : { reason: 'second apply changed the rules file' };
};

const parseConfig = (bytes) => {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
};

const detectSlots = (record) => {
  const gap = findCallGap(record.slices.S3);
  if (gap) return gap;
  const unreadable = record.slices.S3.find(({ config }) => config.error);
  if (unreadable) return { reason: `config unreadable: ${unreadable.config.error}` };
  const [preview, apply, repeated] = record.slices.S3;
  const unchanged = preview.config.bytes.equals(record.configBefore) && preview.epics === null;
  if (!unchanged) return { reason: 'preview changed the config or the epic store' };
  const config = parseConfig(apply.config.bytes);
  if (config === null) return { reason: 'the applied config is not strict JSON' };
  const printed = new Map(preview.result.stdout.split(LF).map((line) => line.match(PRINTED_SLOT_RE))
    .filter(Boolean).map(([, activity, slot, value]) => [`${activity}.${slot}`, value]));
  for (const [activity, slot, values] of SLOT_VALUES) {
    const value = config[activity]?.[slot];
    if (!values.includes(value)) return { reason: `${activity}.${slot} is not a value of its slot type` };
    if (printed.get(`${activity}.${slot}`) !== value) return { reason: `${activity}.${slot} differs from the preview` };
  }
  const kept = Object.entries(parseConfig(record.configBefore)).every(([activity, slots]) => activity === '_README'
    || Object.entries(slots).every(([slot, value]) => config[activity]?.[slot] === value));
  if (!kept) return { reason: 'a slot declared before the apply changed' };
  return repeated.config.bytes.equals(apply.config.bytes) ? null : { reason: 'second apply changed the config' };
};

const detectStore = (record) => {
  const gap = findCallGap(record.slices.S3);
  if (gap) return gap;
  const [, apply, repeated] = record.slices.S3;
  const seeded = isDeepStrictEqual(apply.epics, ['.gitkeep file 0']);
  if (!seeded) return { reason: 'the epic store does not hold exactly an empty .gitkeep' };
  return isDeepStrictEqual(repeated.epics, apply.epics) ? null : { reason: 'second apply changed the epic store' };
};

const detectCheckerGates = (record) => {
  const gap = findCallGap(record.slices.S4);
  if (gap) return gap;
  const unreadable = record.slices.S4.find(({ gates }) => gates.error);
  if (unreadable) return { reason: `gates.json unreadable: ${unreadable.gates.error}` };
  const [preview, apply, repeated] = record.slices.S4;
  if (!preview.gates.bytes.equals(record.gatesBefore)) return { reason: 'preview changed gates.json' };
  const declaration = parseConfig(apply.gates.bytes);
  if (declaration === null) return { reason: 'the applied gates.json is not strict JSON' };
  if (declaration._README !== parseConfig(record.gatesBefore)._README) return { reason: 'the _README changed' };
  const expected = DECLARED.map(([id, tool, tail]) => [id, `node "${join(record.home, 'tools', tool)}" ${tail}`]);
  if (!isDeepStrictEqual(declaration.gates.map(({ id, cmd }) => [id, cmd]), expected)) {
    return { reason: 'gates.json does not carry exactly plan-shape and spec-check with the installed tool paths' };
  }
  if (!repeated.gates.bytes.equals(apply.gates.bytes)) return { reason: 'second apply changed gates.json' };
  const lines = repeated.result.stdout.split(LF);
  return lines.includes('plan-shape: declared') && lines.includes('spec-check: declared')
    ? null : { reason: 'the second apply does not report plan-shape and spec-check declared' };
};

const DETECTORS = {
  'migration-notes-delivered': detectNotes,
  'migration-blocks-placed': detectBlocks,
  'payload-converged': detectPayload,
  'story-sessions-section': detectStorySessions,
  'epic-task-slots': detectSlots,
  'epic-store-seeded': detectStore,
  'checker-gates-declared': detectCheckerGates,
  'session-close-rules': PENDING,
  'named-queue-row-seed': PENDING,
  'profile-gap-screen': PENDING,
};

const computeDigest = (profile) => {
  const lines = [profile.lineage, ...profile.items.map(({ id, story }) => `${id} ${story}`)];
  return createHash('sha256').update(lines.join(LF) + LF, 'utf8').digest('hex');
};

const assertStory = (story, profile, record) => {
  const items = profile.items.filter((item) => item.story === story);
  const gaps = items.map(({ id }) => {
    assert.equal(typeof DETECTORS[id], 'function', `missing detector: ${id}`);
    return DETECTORS[id](record);
  }).filter((gap) => gap !== null);
  for (const gap of gaps) {
    assert.equal(typeof gap.reason, 'string');
    assert.ok(gap.reason.length > 0);
  }
  if (LANDED.has(story)) {
    assert.deepEqual(gaps, [], `${story}: ${JSON.stringify(gaps)}`);
    for (const { id } of items) {
      assert.notEqual(DETECTORS[id], PENDING, `${story}: ${id} is pending`);
    }
  } else {
    assert.ok(gaps.length > 0, `${story} is unlanded but reports no gap`);
  }
};

describe('full flow upgrade delivery', () => {
  before(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'upgrade-full-flow-'));
    fixture.tmp = tmp;
    const home = join(tmp, 'home', 'agent-workflow-kit');
    const project = join(tmp, 'project');
    const runtimeBefore = Buffer.from('{"retained":true}' + LF);
    for (const path of [
      'tools/old-dir/deeper/stale.mjs',
      'references/planning.md',
      'tools/methodology-slot.md',
      'references/my-notes.md',
    ]) {
      writeFixture(join(home, path), `old ${path}${LF}`);
    }
    writeFixture(join(home, 'SKILL.md'), ['---', 'name: agent-workflow-kit', '---', ''].join(LF));
    mkdirSync(join(home, 'references/user-kept-dir'));
    writeFixture(join(tmp, 'outside/keep.txt'), `keep${LF}`);
    symlinkSync(join(tmp, 'outside'), join(home, 'tools/user-link'));
    writeFixture(join(home, 'runtime-state.json'), runtimeBefore);
    writeFixture(join(project, 'docs/ai/.workflow-version'), `1.0.0${LF}`);
    const template = readFileSync(join(KIT, 'references/templates/AGENTS.md'), 'utf8');
    const withoutCommunication = removeSpan(template.replace('{{PROJECT_NAME}}', 'fixture'), COMMUNICATION);
    const initialBytes = Buffer.from(removeSpan(withoutCommunication, ATTRIBUTION));
    writeFixture(join(project, 'AGENTS.md'), initialBytes);
    const rulesTemplate = readFileSync(join(KIT, RULES_TEMPLATE), 'utf8');
    const rulesBefore = Buffer.from(removeRulesSpan(rulesTemplate, STORY_HEADING));
    writeFixture(join(project, RULES_PATH), rulesBefore);
    const configBefore = Buffer.from(serializeConfig(SEED_CONFIG));
    writeFixture(join(project, CONFIG_PATH), configBefore);
    const gatesBefore = readFileSync(join(KIT, 'references/templates/gates.json'));
    writeFixture(join(project, GATES_ARTIFACT.path), gatesBefore);
    writeFixture(join(project, STORE_ROOT_PATH), readFileSync(join(KIT, 'references/templates/specs/index.md')));
    const installer = spawnSync(process.execPath, [
      join(KIT, 'bin', 'install.mjs'), '--dir', home,
      '--no-launchers', '--no-engine', '--no-memory', '--no-bridges',
    ], { encoding: 'utf8' });
    assert.equal(installer.status, 0, installer.stderr || installer.error?.message || installer.stdout);
    const answers = ['--language', 'Esperanto', '--attribution', 'off', '--apply'];
    const s1Calls = [
      runTool(home, project, 'migration-notes.mjs'),
      runTool(home, project, 'migration-blocks.mjs'),
      runTool(home, project, 'migration-blocks.mjs', answers),
      runTool(home, project, 'migration-blocks.mjs', answers),
    ];
    const s2Calls = [
      runTool(home, project, INSERT_TOOL, [], RULES_ARTIFACT),
      runTool(home, project, INSERT_TOOL, APPLY_ARGS, RULES_ARTIFACT),
      runTool(home, project, INSERT_TOOL, APPLY_ARGS, RULES_ARTIFACT),
    ];
    const s3Calls = [runOffer(home, project), runOffer(home, project, APPLY_ARGS), runOffer(home, project, APPLY_ARGS)];
    const s4Calls = [[], APPLY_ARGS, APPLY_ARGS].map((extra) => runTool(home, project, CHECKER_TOOL, extra, GATES_ARTIFACT));
    fixture.record = {
      home, project, initialBytes, runtimeBefore, rulesBefore, rulesTemplate, configBefore, gatesBefore,
      slices: { S1: s1Calls, S2: s2Calls, S3: s3Calls, S4: s4Calls }, payload: capturePayload(home),
    };
    fixture.profile = JSON.parse(readFileSync(join(KIT, 'references/reference-profile.json'), 'utf8'));
  });

  after(() => {
    if (fixture.tmp) rmSync(fixture.tmp, { recursive: true, force: true });
  });

  it('spec:upgrade-delivery/S17 pins the closed profile and detects each identity mutation', () => {
    const profile = fixture.profile;
    assert.deepEqual(Object.keys(profile), ['schema', 'name', 'lineage', 'items']);
    assert.equal(profile.schema, 1);
    assert.equal(profile.name, 'full-flow');
    assert.equal(profile.lineage, '4.0.0');
    assert.ok(Array.isArray(profile.items));
    assert.deepEqual(profile.items.map(({ id }) => id), ITEM_IDS);
    assert.equal(new Set(profile.items.map(({ id }) => id)).size, ITEM_IDS.length);
    for (const item of profile.items) {
      assert.deepEqual(Object.keys(item), ['id', 'story', 'has']);
      assert.ok(STORIES.includes(item.story));
      assert.equal(typeof item.has, 'string');
      assert.ok(item.has.trim().length > 0);
      assert.doesNotMatch(item.has, /[\p{Cc}\p{Zl}\p{Zp}]/u);
    }
    for (const story of STORIES) {
      assert.ok(profile.items.some((item) => item.story === story), `${story} has no item`);
    }
    assert.equal(computeDigest(profile), DIGEST);
    const renamed = structuredClone(profile);
    renamed.items[0].id = 'changed-id';
    const reordered = structuredClone(profile);
    [reordered.items[0], reordered.items[1]] = [reordered.items[1], reordered.items[0]];
    const newLineage = structuredClone(profile);
    newLineage.lineage = '5.0.0';
    const rekeyed = structuredClone(profile);
    rekeyed.items[0].story = 'S2';
    for (const changed of [renamed, reordered, newLineage, rekeyed]) {
      assert.notEqual(computeDigest(changed), DIGEST);
    }
  });

  it('spec:upgrade-delivery/S18 compares S1 delivery and carries the profile in the installed payload', () => {
    assertStory('S1', fixture.profile, fixture.record);
    assert.equal(fixture.record.payload.error, undefined);
    const paths = fixture.record.payload.trees.flatMap(({ entry, installed }) =>
      installed.map((path) => `${entry}/${path}`));
    assert.ok(paths.includes('references/reference-profile.json'));
  });

  it('spec:rules-regions/S20 inserts story sessions into older rules with a read-only preview and repeat', () => {
    const text = fixture.record.rulesBefore.toString('utf8');
    const lines = text.split(LF);
    assert.ok(!lines.includes(STORY_HEADING));
    assert.ok(lines.includes(RULES_CAP));
    const lens = findRegion(text, LENS_HEADING);
    assert.ok(lens, 'seeded rules retain the lens');
    assert.equal(lens.lines[lens.end], SECTION_BOUNDARY, 'seeded rules retain the section 2 boundary');
    assertStory('S2', fixture.profile, fixture.record);
  });

  it('spec:tier-offer/S17 offers the epic and task slots and seeds the store in the older project', () => {
    const before = JSON.parse(fixture.record.configBefore.toString('utf8'));
    assert.deepEqual(before, SEED_CONFIG);
    for (const [activity] of SLOT_VALUES) assert.equal(before[activity], undefined);
    assertStory('S3', fixture.profile, fixture.record);
  });

  it('spec:checker-gates/S16 declares the two applicable kit checkers in the older project, a second apply a no-op', () => {
    const before = JSON.parse(fixture.record.gatesBefore.toString('utf8'));
    assert.deepEqual(before.gates, []);
    assert.equal(existsSync(join(fixture.record.project, '.git')), false);
    assertStory('S4', fixture.profile, fixture.record);
  });

  it('spec:upgrade-delivery/S19 binds every detector to an item and every story to the landed register', () => {
    const ids = fixture.profile.items.map(({ id }) => id);
    assert.deepEqual(Object.keys(DETECTORS).sort(), [...ids].sort());
    for (const id of ids) {
      assert.equal(Object.keys(DETECTORS).filter((key) => key === id).length, 1);
      assert.equal(typeof DETECTORS[id], 'function');
    }
    for (const story of STORIES) {
      assertStory(story, fixture.profile, fixture.record);
    }
  });
});

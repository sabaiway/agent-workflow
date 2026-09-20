import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const loaded = await import('./profile-gaps.mjs').catch(() => ({}));
const getRegistry = loaded.PROFILE_GAPS === undefined ? () => {
  throw new Error('profile-gaps.mjs is absent');
} : () => loaded.PROFILE_GAPS;
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, '..');
const ROOT = join(HERE, 'profile-gaps-fixture');
const TARGET = join(ROOT, 'docs', 'ai', 'agent_rules.md');
const TEMPLATE_PATH = join(KIT, 'references', 'templates', 'agent_rules.md');
const PROFILE_PATH = join(KIT, 'references', 'reference-profile.json');
const MODULE_PATH = join(HERE, 'profile-gaps.mjs');
const TOOL_PATH = join(HERE, 'rules-insert.mjs');
const GAP_ID = 'story-sessions-section';
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
// A lone continuation byte: valid in cp1251 or latin-1, never valid UTF-8.
const INVALID_UTF8 = Buffer.from([0xA0]);
const TAB = String.fromCharCode(9);
const COMMUNICATION = '### 2.5. Communication (user-facing messages)';
const STORY = '### 2.7. Story sessions';
const COMMUNICATION_SPAN = [COMMUNICATION, 'Communication body.', ''].join(LF) + LF;
const STORY_SPAN = [STORY, 'Story body.', ''].join(LF) + LF;
const TEMPLATE = COMMUNICATION_SPAN + STORY_SPAN + '---' + LF;
const PRESENT = TEMPLATE.replace('Story body.', 'Hand-edited story body.');
const MISSING = COMMUNICATION_SPAN + '---' + LF;
const NO_ANCHOR = '## Rules' + LF + 'No numbered sections.' + LF;
const BOTH_MISSING = '### 2.4. Existing section' + LF + 'Preserved body.' + LF;
const TARGET_CAP = 7;
const CAPPED = ['---', 'maxLines: ' + TARGET_CAP, '---', MISSING].join(LF);
const ENTRY_KEYS = ['apply', 'detect', 'id'];
const VERDICT_KEYS = ['verdict'];
const UNDECIDABLE_KEYS = ['reason', 'verdict'];
const VERDICTS = ['present', 'absent', 'undecidable'];
const WRITE_PRIMITIVES = ['writeFile', 'rename', 'rm'];
const IMPORT_RE = /import[^;]+;/g;
const REGIONS_IMPORT_RE = new RegExp(
  `from[ ${LF}${CR}${TAB}]+['"][.]/rules-regions[.]mjs['"]`,
);
const WRITER_IMPORT_RE = /atomic-write|writeFile|appendFile|createWriteStream|rename|unlink|[ {,]rm(?:Sync)?[ ,}]/;

const getEntry = () => {
  const entry = getRegistry().find(({ id }) => id === GAP_ID);
  assert.ok(entry, 'The registry includes ' + GAP_ID);
  assert.equal(typeof entry.detect, 'function');
  assert.equal(typeof entry.apply, 'function');
  return entry;
};
const createFixture = ({
  body = MISSING, kind = 'file', template = TEMPLATE, failRead, invalidTarget,
} = {}) => {
  const files = new Map([
    [TEMPLATE_PATH, { kind: 'file', text: template }],
    [TARGET, { kind, text: body }],
  ]);
  const before = structuredClone(files);
  const reads = [];
  const probes = [];
  const writes = [];
  const normalizePath = (path) => path instanceof URL ? fileURLToPath(path) : resolve(String(path));
  const getFile = (path) => {
    const file = files.get(path);
    if (!file || file.kind === 'absent') {
      throw Object.assign(new Error('Missing fixture file'), { code: 'ENOENT' });
    }
    return file;
  };
  const deps = {
    lstatSync: (path) => {
      const normalized = normalizePath(path);
      probes.push(normalized);
      const file = getFile(normalized);
      return {
        isFile: () => file.kind === 'file',
        isDirectory: () => file.kind === 'directory',
        isSymbolicLink: () => file.kind === 'symlink',
      };
    },
    readFileSync: (path, encoding) => {
      const normalized = normalizePath(path);
      reads.push(normalized);
      if (normalized === failRead) throw new Error('read boom');
      const file = getFile(normalized);
      if (file.kind !== 'file') throw new Error('Non-regular fixture file');
      if (normalized === TARGET && invalidTarget) {
        return Buffer.concat([Buffer.from(file.text), INVALID_UTF8]);
      }
      return encoding ? file.text : Buffer.from(file.text);
    },
    ...Object.fromEntries(WRITE_PRIMITIVES.map((name) => [
      name, (...args) => { writes.push([name, args]); },
    ])),
  };
  return { root: ROOT, deps, files, before, reads, probes, writes };
};
const assertVerdict = (result, verdict, reason) => {
  assert.ok(!(result instanceof Promise), 'detect returns synchronously');
  assert.ok(VERDICTS.includes(result.verdict));
  assert.deepEqual(Reflect.ownKeys(result).sort(), reason ? UNDECIDABLE_KEYS : VERDICT_KEYS);
  assert.deepEqual(result, reason ? { verdict, reason } : { verdict });
  if (result.verdict === 'undecidable') {
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.trim().length > 0);
    assert.ok(!result.reason.includes(LF));
    assert.ok(!result.reason.includes(CR));
  }
};
const assertDetection = (options, verdict, reason) => {
  const fixture = createFixture(options);
  const entry = getEntry();
  const observed = {};
  assert.doesNotThrow(() => {
    observed.result = entry.detect({ root: fixture.root, deps: fixture.deps });
  });
  assertVerdict(observed.result, verdict, reason);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.files, fixture.before);
  assert.ok(fixture.reads.includes(TEMPLATE_PATH), 'The template read uses deps');
  if (reason === 'template') {
    assert.ok(!fixture.probes.includes(TARGET), 'Template defects precede the file probe');
    assert.ok(!fixture.reads.includes(TARGET), 'Template defects precede the file read');
  } else {
    assert.ok(fixture.probes.includes(TARGET), 'The target probe uses lstatSync');
    if (!options.kind || options.kind === 'file') {
      assert.ok(fixture.reads.includes(TARGET), 'The target read uses deps');
    } else {
      assert.ok(!fixture.reads.includes(TARGET), 'An unsafe target is never read');
    }
  }
};

describe('spec:rules-regions/S16 closed registry and synchronous verdicts', () => {
  it('freezes every entry and keeps unique ids in reference-profile order', () => {
    const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    const profileIds = profile.items.map(({ id }) => id);
    const registry = getRegistry();
    assert.ok(Array.isArray(registry));
    assert.ok(Object.isFrozen(registry));
    const ids = registry.map(({ id }) => id);
    assert.ok(ids.includes(GAP_ID));
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, profileIds.filter((id) => ids.includes(id)));
    for (const entry of registry) {
      assert.ok(Object.isFrozen(entry));
      assert.deepEqual(Reflect.ownKeys(entry).sort(), ENTRY_KEYS);
      assert.equal(typeof entry.detect, 'function');
      assert.equal(typeof entry.apply, 'function');
    }
  });
});

describe('spec:rules-regions/S17 story-sessions detection without writes', () => {
  for (const [name, options, verdict, reason] of [
    ['one heading with a custom body', { body: PRESENT }, 'present'],
    ['only story sessions planned', { body: MISSING }, 'absent'],
    ['both template regions planned', { body: BOTH_MISSING }, 'absent'],
    ['absent target', { kind: 'absent' }, 'undecidable', 'file-absent'],
    ['symlink target', { kind: 'symlink' }, 'undecidable', 'file-symlink'],
    ['directory target', { kind: 'directory' }, 'undecidable', 'file-unreadable'],
    ['other non-regular target', { kind: 'socket' }, 'undecidable', 'file-unreadable'],
    ['target read fails after probe', { failRead: TARGET }, 'undecidable', 'file-unreadable'],
    ['target bytes are not UTF-8', { invalidTarget: true }, 'undecidable', 'file-unreadable'],
    ['story heading twice', { body: PRESENT + STORY_SPAN }, 'undecidable', 'heading-twice'],
    ['communication twice before an insert', { body: MISSING + COMMUNICATION_SPAN }, 'undecidable', 'heading-twice'],
    ['no numbered anchor', { body: NO_ANCHOR }, 'undecidable', 'anchor-absent'],
    ['planned insert exceeds own cap', { body: CAPPED }, 'undecidable', 'cap'],
  ]) {
    it(name, () => assertDetection(options, verdict, reason));
  }
  for (const [name, template, failRead] of [
    ['template read failure', TEMPLATE, TEMPLATE_PATH],
    ['Communication heading absent', STORY_SPAN],
    ['Communication heading twice', TEMPLATE + COMMUNICATION_SPAN],
    ['Story sessions heading absent', COMMUNICATION_SPAN],
    ['Story sessions heading twice', TEMPLATE + STORY_SPAN],
  ]) {
    for (const [state, body] of [
      ['story heading absent', MISSING],
      ['story heading present', PRESENT],
    ]) {
      it(name + ' before ' + state, () => {
        assertDetection({ body, template, failRead }, 'undecidable', 'template');
      });
    }
  }
});

describe('spec:rules-regions/S18 preview command and read-only imports', () => {
  it('offers one absolute preview command with the supplied project root', () => {
    const fixture = createFixture();
    const entry = getEntry();
    const line = entry.apply(fixture.root);
    assert.ok(isAbsolute(TOOL_PATH));
    assert.equal(line, 'node ' + TOOL_PATH + ' --cwd ' + fixture.root);
    assert.ok(!line.includes('--apply'));
    assert.ok(!line.includes(LF));
    assert.ok(!line.includes(CR));
  });
  it('imports the regions leaf and no writer', () => {
    const fixture = createFixture();
    getEntry().apply(fixture.root);
    const source = readFileSync(MODULE_PATH, 'utf8');
    const imports = (source.match(IMPORT_RE) ?? []).join(LF);
    assert.match(imports, REGIONS_IMPORT_RE);
    assert.doesNotMatch(imports, WRITER_IMPORT_RE);
  });
});

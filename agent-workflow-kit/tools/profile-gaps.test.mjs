// profile-gaps.test.mjs — the registry's closed shape, the two builders moved into the module, and no
// detector reading the rules file (docs/ai/specs/kit/tier/gap-screen/, session-rules S12). Red first:
// the module is imported dynamically; every fixture is built in its cell.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProject } from './tier-preview.test/harness.test.mjs';

const loaded = await import('./profile-gaps.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = JSON.parse(readFileSync(resolve(HERE, '..', 'references', 'reference-profile.json'), 'utf8'));
const MODULE_PATH = join(HERE, 'profile-gaps.mjs');
const REGISTRY = ['epic-task-slots', 'epic-store-seeded', 'checker-gates-declared', 'named-queue-row-seed'];
const RETIRED = ['story-sessions-section', 'session-close-rules'];
const RULES = 'docs/ai/agent_rules.md';
const TOOL = '/kit/tools/tier-preview.mjs';
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CONTROL_BYTE = String.fromCharCode(1);
const BACKTICK = String.fromCharCode(96);
const BOM = String.fromCharCode(0xFEFF);
// A lone continuation byte: valid in cp1251 or latin-1, never valid UTF-8.
const INVALID_UTF8 = Buffer.from([0x41, 0xA0]);
const IMPORT_RE = /import[^;]+;/g;
const RETIRED_IMPORT_RE = /['"][.]\/(?:lens-region|rules-regions)[.]mjs['"]/;
const REAL_FS = Object.freeze({ readFileSync, lstatSync });

const exported = (name) => {
  assert.ok(name in loaded, `profile-gaps.mjs exports no ${name}`);
  return loaded[name];
};
const registry = () => exported('PROFILE_GAPS');
// detectAll(root) → each entry's answer over the real tree, checked synchronous and of the closed shape.
const detectAll = (root) => registry().map(({ id, detect }) => {
  const result = detect({ root, deps: REAL_FS });
  assert.ok(!(result instanceof Promise), `${id} answers synchronously`);
  const keys = Reflect.ownKeys(result).sort();
  assert.deepEqual(keys, result.verdict === 'undecidable' ? ['reason', 'verdict'] : ['verdict'], id);
  assert.ok(['present', 'absent', 'undecidable'].includes(result.verdict), id);
  if (result.verdict === 'undecidable') assert.ok(typeof result.reason === 'string' && result.reason.trim() !== '' && !/[\r\n]/.test(result.reason), id);
  return { id, ...result };
});

describe('spec:gap-screen/S13 the registry is the closed shape of the four entries', () => {
  it('PROFILE_GAPS is a frozen ordered array of exactly the four ids, in the shipped profile order, each entry frozen and closed', () => {
    const gaps = registry();
    assert.ok(Array.isArray(gaps) && Object.isFrozen(gaps));
    const ids = gaps.map(({ id }) => id);
    assert.deepEqual(ids, REGISTRY);
    assert.deepEqual(ids, PROFILE.items.map(({ id }) => id).filter((id) => ids.includes(id)), 'the profile order');
    assert.deepEqual(ids.filter((id) => RETIRED.includes(id)), []);
    for (const entry of gaps) {
      assert.ok(Object.isFrozen(entry), entry.id);
      assert.deepEqual(Reflect.ownKeys(entry).sort(), ['apply', 'detect', 'id']);
      assert.equal(typeof entry.detect, 'function');
      assert.equal(typeof entry.apply, 'function');
    }
  });

  it('every detect answers exactly { verdict, reason } synchronously, the reason key only on undecidable', () => {
    const bare = mkdtempSync(join(tmpdir(), 'profile-gaps-bare-'));
    try {
      assert.deepEqual(detectAll(bare).map(({ verdict }) => verdict), REGISTRY.map(() => 'undecidable'), 'an undeployed root');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
    const { root } = makeProject({ files: { 'docs/plans/queue.md': '# Queue\n', 'docs/ai/epics': { kind: 'directory' } } });
    const answers = detectAll(root);
    assert.ok(answers.some(({ verdict }) => verdict !== 'undecidable'), answers.map(({ id, verdict }) => `${id} ${verdict}`).join(', '));
  });
});

describe('spec:gap-screen/S14 the moved builders and no import of the retired modules', () => {
  it('buildInsertPreview takes its tool path as a required argument with no default', () => {
    assert.equal(exported('buildInsertPreview').length, 2);
  });

  for (const [name, root, toolPath, expected] of [
    ['a plain root', '/projects/plain-root', TOOL, `node ${TOOL} --cwd /projects/plain-root`],
    ['a root holding a space', '/projects/my project', TOOL, `node ${TOOL} --cwd '/projects/my project'`],
    ['a root carrying a control byte', `/projects/a${CONTROL_BYTE}b`, TOOL, ''],
    ['a root carrying a backtick', `/projects/a${BACKTICK}b`, TOOL, ''],
    ['a tool path carrying a control byte', '/projects/plain-root', `/kit${CONTROL_BYTE}/tool.mjs`, ''],
    ['a tool path carrying a backtick', '/projects/plain-root', `/kit${BACKTICK}/tool.mjs`, ''],
  ]) {
    it(`buildInsertPreview answers ${expected === '' ? 'the empty string' : 'its node line'} for ${name}`, () => {
      assert.equal(exported('buildInsertPreview')(root, toolPath), expected);
    });
  }

  it('decodeUtf8Strict answers the text of UTF-8 bytes, a byte-order mark kept, and throws for bytes that do not round-trip', () => {
    const decodeUtf8Strict = exported('decodeUtf8Strict');
    assert.equal(decodeUtf8Strict(Buffer.from('\u00fc text\n')), '\u00fc text\n');
    assert.equal(decodeUtf8Strict(Buffer.from(`${BOM}text`)), `${BOM}text`);
    assert.throws(() => decodeUtf8Strict(INVALID_UTF8));
  });

  it('profile-gaps.mjs imports no lens-region.mjs and no rules-regions.mjs', () => {
    const imports = (readFileSync(MODULE_PATH, 'utf8').match(IMPORT_RE) ?? []).join(LF);
    assert.match(imports, /reference-profile[.]mjs/, 'the import text is read');
    assert.doesNotMatch(imports, RETIRED_IMPORT_RE);
  });
});

describe('spec:session-rules/S12 no detector reads the rules file', () => {
  it('the module names no docs/ai/agent_rules.md, imports neither retired module and exports no STORY_REGION_ABSENT', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    assert.equal(source.includes(RULES), false, RULES);
    assert.doesNotMatch((source.match(IMPORT_RE) ?? []).join(LF), RETIRED_IMPORT_RE);
    assert.ok(Object.keys(loaded).length > 0 && !('STORY_REGION_ABSENT' in loaded), Object.keys(loaded).join(', '));
  });

  it('a rules file absent, a symlink or a body of the user\'s own leaves every verdict unchanged', () => {
    const verdictsWith = (rules) => detectAll(makeProject({ files: { [RULES]: rules, 'docs/ai/epics': { kind: 'directory' } } }).root)
      .map(({ id, verdict, reason }) => `${id} ${verdict} ${reason ?? ''}`);
    const baseline = verdictsWith(null);
    for (const [name, rules] of [
      ['a symlink', { kind: 'symlink', text: '# Rules\n' }],
      ["a body of the user's own", `# Our rules${LF}${LF}Our own rule.${CR}${LF}`],
    ]) {
      assert.deepEqual(verdictsWith(rules), baseline, name);
    }
  });
});

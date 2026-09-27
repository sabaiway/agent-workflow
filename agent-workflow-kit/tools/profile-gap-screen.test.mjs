// profile-gap-screen.test.mjs — the read-only leaf the advisor renders the profile gaps from
// (docs/ai/specs/kit/tier/gap-screen/, part profile-gap-screen). Red first: the leaf is imported
// dynamically; every fixture is built in its cell over the real registry entries.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIBRARY_ONLY_MODULES, libraryOnlyLine } from './direct-run.mjs';
import { PROFILE_GAPS } from './profile-gaps.mjs';
import { ITEM_LINE_CAP } from './recommendations.mjs';
import { makeProject } from './tier-preview.test/harness.test.mjs';

const loaded = await import('./profile-gap-screen.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'profile-gap-screen.mjs');
const PURITY_TEST = join(HERE, '..', 'test', 'read-graph-purity.test.mjs');
const SHIPPED = JSON.parse(readFileSync(join(HERE, '..', 'references', 'reference-profile.json'), 'utf8'));
const HAS = Object.fromEntries(SHIPPED.items.map(({ id, has }) => [id, has]));
const TEMPLATE = readFileSync(join(HERE, '..', 'references', 'templates', 'agent_rules.md'), 'utf8');
const STORYLESS = TEMPLATE.replace('### 2.7. Story sessions', '### 2.7. Session notes');
const CUSTOMIZED = TEMPLATE.replace('- **Plain language.**', '- **My own plain language.**');
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const WRITE_MODULES_RE = /const WRITE_MODULES = \[([^\]]*)\]/;
const RULES = 'docs/ai/agent_rules.md';
const DECLINES = 'docs/ai/profile-declines.json';
const LINEAGE = SHIPPED.lineage;
const OTHER_LINEAGE = '3.0.0';
const SENTENCE = 'no runnable command — the root or the kit path carries a control byte or a backtick';
const UNENTERED = ['migration-notes-delivered', 'migration-blocks-placed', 'payload-converged', 'profile-gap-screen'];
const ABSENT_PARTS = { 'docs/ai/orchestration.json': '{}\n', 'docs/ai/gates.json': '{"gates":[]}\n' };
const record = (declined) => JSON.stringify({ schema: 1, declined });

const entryOf = (id) => PROFILE_GAPS.find((entry) => entry.id === id);
const gapOf = (id, root) => ({ id, what: `${id}: ${HAS[id]}`, apply: entryOf(id).apply(root) });
// One call of the leaf: synchronous, exactly { gaps, skips }, never a gap and a skip for one id.
const screen = (root, deps = {}) => {
  const compose = loaded.composeProfileGapScreen ?? (() => { throw new Error('composeProfileGapScreen is absent'); });
  const result = compose({ root, deps });
  assert.ok(!(result instanceof Promise), 'the leaf answers synchronously');
  assert.deepEqual(Object.keys(result).sort(), ['gaps', 'skips']);
  const skipped = result.skips.map((reason) => reason.split(': ')[0]);
  assert.deepEqual(result.gaps.filter(({ id }) => skipped.includes(id)), [], 'never a gap and a skip for one id');
  return result;
};
const screenIn = (files, options = {}) => {
  const { root } = makeProject({ files, ...options });
  return { root, ...screen(root) };
};
const fsError = (code) => Object.assign(new Error(`${code}: injected`), { code });
// The detectors' two keys, every call recorded; the readers read through open, fstat and readFile instead.
const detectorSpy = () => {
  const calls = [];
  const deps = {
    lstatSync: (path, ...rest) => { calls.push(path); return lstatSync(path, ...rest); },
    readFileSync: (path, ...rest) => { calls.push(path); return readFileSync(path, ...rest); },
  };
  return { deps, calls };
};

describe('spec:gap-screen/S3 the leaf answers one disposition per judged entry', () => {
  it('answers a gap per offered entry and a skip per undecidable one, in registry order', () => {
    const { root, gaps, skips } = screenIn({ ...ABSENT_PARTS, 'docs/plans': 'not a directory' });
    assert.deepEqual(gaps, ['epic-task-slots', 'epic-store-seeded', 'checker-gates-declared'].map((id) => gapOf(id, root)));
    assert.deepEqual(skips, ['named-queue-row-seed: plans-not-directory']);
  });

  it('answers nothing for a present entry and for a current decline, and a gap for a decline at another lineage', () => {
    const declined = { 'story-sessions-section': LINEAGE, 'epic-store-seeded': LINEAGE, 'named-queue-row-seed': OTHER_LINEAGE };
    const { root, gaps, skips } = screenIn({ ...ABSENT_PARTS, [DECLINES]: record(declined) });
    assert.deepEqual(gaps, ['epic-task-slots', 'checker-gates-declared', 'named-queue-row-seed'].map((id) => gapOf(id, root)));
    assert.deepEqual(skips, []);
  });

  it('answers the no-command skip for an offered entry whose apply is empty', () => {
    const { root, gaps, skips } = screenIn(ABSENT_PARTS, { name: `pro${String.fromCharCode(96)}ject` });
    assert.equal(entryOf('epic-store-seeded').apply(root), '', 'the fixture root makes every apply empty');
    assert.deepEqual(gaps, []);
    assert.deepEqual(skips, ['epic-task-slots', 'epic-store-seeded', 'checker-gates-declared', 'named-queue-row-seed'].map((id) => `${id}: ${SENTENCE}`));
  });

  it('answers the detector reason verbatim for an undecidable entry, a customized Communication region included', () => {
    assert.deepEqual(screenIn({ ...ABSENT_PARTS, [RULES]: CUSTOMIZED }).skips, ['session-close-rules: region-customized']);
    assert.deepEqual(screenIn({ [RULES]: TEMPLATE }).skips, ['epic-task-slots: config-absent', 'checker-gates-declared: declaration-absent']);
  });

  for (const [name, files, story] of [
    ['offered', { [RULES]: STORYLESS }, 'gap'],
    ['currently declined', { [RULES]: STORYLESS, [DECLINES]: record({ 'story-sessions-section': LINEAGE }) }, 'nothing'],
    ['undecidable', { [RULES]: STORYLESS.replace('maxLines: 150', 'maxLines: 10') }, 'story-sessions-section: cap'],
  ]) {
    it(`answers nothing for session-close-rules on story-sessions-absent while story-sessions-section is ${name}`, () => {
      const { root, gaps, skips } = screenIn({ ...ABSENT_PARTS, ...files });
      assert.deepEqual(skips.filter((reason) => reason.startsWith('session-close-rules')), []);
      const storyGaps = gaps.filter(({ id }) => id === 'story-sessions-section');
      const storySkips = skips.filter((reason) => reason.startsWith('story-sessions-section'));
      assert.deepEqual({ storyGaps, storySkips }, {
        storyGaps: story === 'gap' ? [gapOf('story-sessions-section', root)] : [],
        storySkips: story.includes(':') ? [story] : [],
      });
    });
  }

  it('answers the missing-id skip for a registry id the read profile does not carry', () => {
    const partial = { ...SHIPPED, items: SHIPPED.items.filter(({ id }) => id !== 'epic-store-seeded') };
    const { root, base } = makeProject({ files: { ...ABSENT_PARTS, '../profile.json': JSON.stringify(partial) } });
    const { gaps, skips } = screen(root, { profilePath: join(base, 'profile.json') });
    assert.deepEqual(skips, ['epic-store-seeded: not in the shipped profile']);
    assert.deepEqual(gaps.map(({ id }) => id), ['epic-task-slots', 'checker-gates-declared', 'named-queue-row-seed']);
  });
});

describe('spec:gap-screen/S4 a reader refusal is one skip and nothing else', () => {
  for (const [refusal, name, build, files = {}, docsAi = 'directory'] of [
    ['profile-unreadable', 'no profile file', ({ base }) => ({ profilePath: join(base, 'absent.json') })],
    ['profile-malformed', 'a profile that is not one', ({ base }) => ({ profilePath: join(base, 'profile.json') })],
    ['declines-symlink', 'a symlinked record', () => ({}), { [DECLINES]: { kind: 'symlink', text: record({}) } }],
    ['declines-unreadable', 'a record that is a directory', () => ({}), { [DECLINES]: { kind: 'directory' } }],
    ['declines-unreadable', 'a docs/ai that is a regular file', () => ({}), {}, 'file'],
    ['declines-malformed', 'a record that is not one', () => ({}), { [DECLINES]: '{}\n' }],
  ]) {
    it(`answers ${refusal} alone for ${name}, and no detector ran`, () => {
      const project = makeProject({ files: { ...ABSENT_PARTS, '../profile.json': '{}\n', ...files }, docsAi });
      const spy = detectorSpy();
      assert.deepEqual(screen(project.root, { ...spy.deps, ...build(project) }), { gaps: [], skips: [refusal] });
      assert.deepEqual(spy.calls, []);
    });
  }
});

describe('spec:gap-screen/S5 the seam and the purity', () => {
  it('fills readFileSync and lstatSync from node:fs only where the bag lacks them', () => {
    const { root } = makeProject({ files: ABSENT_PARTS });
    const spy = detectorSpy();
    const observed = screen(root, spy.deps);
    assert.deepEqual(observed, screen(root));
    assert.ok(spy.calls.includes(resolve(root, RULES)) && spy.calls.includes(resolve(root, 'docs/plans')), 'the bag keys reach the detectors');
    const failing = {
      readFileSync: (path, ...rest) => {
        if (path === resolve(root, RULES)) throw fsError('EIO');
        return readFileSync(path, ...rest);
      },
    };
    assert.deepEqual(screen(root, failing).skips, ['story-sessions-section: file-unreadable', 'session-close-rules: file-unreadable']);
  });

  it("hands the same bag to the readers, each reader's own keys driving its reads", () => {
    const { root } = makeProject({ files: { ...ABSENT_PARTS, [DECLINES]: record({}) } });
    const open = (path, ...rest) => {
      if (path === resolve(root, DECLINES)) throw fsError('EACCES');
      return openSync(path, ...rest);
    };
    assert.deepEqual(screen(root, { open }), { gaps: [], skips: ['declines-unreadable'] });
  });

  it('makes a reader refuse, never throw, under a descriptor-blind stub', () => {
    const { root } = makeProject({ files: ABSENT_PARTS });
    const readFile = (path) => {
      if (typeof path !== 'string') throw new TypeError('the stub reads paths only');
      return readFileSync(path);
    };
    assert.deepEqual(screen(root, { readFile }), { gaps: [], skips: ['profile-unreadable'] });
  });

  it('imports STORY_REGION_ABSENT and carries no copied literal of it', () => {
    const source = readFileSync(MODULE, 'utf8');
    assert.match(source, /import \{[^}]*\bSTORY_REGION_ABSENT\b[^}]*\} from '\.\/profile-gaps\.mjs'/);
    assert.equal(source.includes('story-sessions-absent'), false);
  });

  it('reaches no write module through its import closure', () => {
    const listed = readFileSync(PURITY_TEST, 'utf8').match(WRITE_MODULES_RE);
    assert.ok(listed, 'read-graph-purity.test.mjs declares WRITE_MODULES');
    const writers = [...listed[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(writers.includes('atomic-write.mjs'), 'the write-module list is not vacuous');
    const seen = new Set();
    const queue = [MODULE];
    while (queue.length > 0) {
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) queue.push(resolve(dirname(file), match[1]));
    }
    const names = [...seen].map((file) => relative(HERE, file));
    assert.ok(names.includes('profile-gaps.mjs') && names.includes('reference-profile.mjs'), names.join(', '));
    assert.deepEqual(names.filter((name) => writers.includes(name)), []);
  });

  it('is library-only: a direct run points at the recommendations command and exits 2', () => {
    assert.equal(LIBRARY_ONLY_MODULES['profile-gap-screen.mjs'], '/agent-workflow-kit recommendations');
    const run = spawnSync(process.execPath, [MODULE], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr.trim(), libraryOnlyLine('profile-gap-screen.mjs'));
  });
});

describe('spec:gap-screen/S6 the pins against the shipped profile', () => {
  it("composes every registry id's WHAT as one line within ITEM_LINE_CAP", () => {
    for (const { id } of PROFILE_GAPS) {
      const what = `${id}: ${HAS[id]}`;
      assert.ok(HAS[id] !== undefined && !/[\r\n]/.test(what) && what.length <= ITEM_LINE_CAP, `${id}: ${what.length}`);
    }
  });

  it("leaves exactly the four unentered ids outside the registry", () => {
    const entered = PROFILE_GAPS.map(({ id }) => id);
    assert.deepEqual(SHIPPED.items.map(({ id }) => id).filter((id) => !entered.includes(id)), UNENTERED);
  });
});

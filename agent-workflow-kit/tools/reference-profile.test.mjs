import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITIES, SLOT_RECIPES } from './carriers.mjs';
import { LIBRARY_ONLY_MODULES, libraryOnlyLine } from './direct-run.mjs';
import { failAt, makeProject } from './tier-preview.test/harness.test.mjs';

const loaded = await import('./reference-profile.mjs').catch(() => ({}));
const need = (name) => {
  if (loaded[name] === undefined) throw new Error(`reference-profile.mjs ${name} is absent`);
  return loaded[name];
};
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'reference-profile.mjs');
const SHIPPED = join(HERE, '..', 'references', 'reference-profile.json');
const PURITY_TEST = join(HERE, '..', 'test', 'read-graph-purity.test.mjs');
const RECORD_REL = 'docs/ai/profile-declines.json';
const PROFILE_REL = 'profile.json';
const IMPORT_RE = /(?:^|\n)\s*(?:import\s[^'"]*?|export\s[^'"]*?from\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const WRITE_MODULES_RE = /const WRITE_MODULES = \[([^\]]*)\]/;
const INVALID_UTF8 = Buffer.from([0x7b, 0xa0, 0x7d]);
const SHIPPED_PROFILE = JSON.parse(readFileSync(SHIPPED, 'utf8'));
const LINEAGE = SHIPPED_PROFILE.lineage;
const OTHER_LINEAGE = '2.0.0';
const TARGETS = [
  ['epic', 'author', ['subagent', 'solo']],
  ['epic', 'review', ['reviewed', 'solo']],
  ['task', 'author', ['delegated', 'subagent', 'solo']],
  ['task', 'execute', ['delegated', 'subagent', 'solo']],
];
const json = (value) => JSON.stringify(value, null, 2);
const record = (declined) => json({ schema: 1, declined });

// A profile file placed beside a throwaway project, read through deps.profilePath.
const readProfileAs = (spec, extraDeps = () => ({})) => {
  const { base } = makeProject({ files: { [`../${PROFILE_REL}`]: spec } });
  const deps = { profilePath: join(base, PROFILE_REL), ...extraDeps(base) };
  return need('readShippedProfile')(deps);
};
const readRecordAs = (spec, extraDeps = () => ({})) => {
  const { root } = makeProject({ files: { [RECORD_REL]: spec } });
  return need('readDeclines')(root, extraDeps(root));
};
const mutate = (change) => {
  const profile = structuredClone(SHIPPED_PROFILE);
  change(profile);
  return json(profile);
};

describe('spec:tier-offer/S12 the read-only profile and decline reader', () => {
  it('freezes the target table in activity, slot and candidate order', () => {
    const targets = need('TIER_TARGETS');
    assert.ok(Object.isFrozen(targets));
    assert.deepEqual(targets.map(({ activity, slot, candidates }) => [activity, slot, [...candidates]]), TARGETS);
    for (const target of targets) {
      assert.ok(Object.isFrozen(target));
      assert.ok(Object.isFrozen(target.candidates));
      assert.deepEqual(Object.keys(target).sort(), ['activity', 'candidates', 'slot']);
    }
  });

  it('names only registry slots and candidates their slot type admits', () => {
    for (const { activity, slot, candidates } of need('TIER_TARGETS')) {
      const type = ACTIVITIES[activity]?.slots[slot];
      assert.ok(type, `${activity}.${slot} is a registry slot`);
      for (const candidate of candidates) assert.ok(SLOT_RECIPES[type].includes(candidate), `${activity}.${slot} ${candidate}`);
      assert.equal(candidates.at(-1), 'solo', `${activity}.${slot} ends at the floor`);
    }
  });

  it('answers the shipped profile beside the running kit', () => {
    assert.deepEqual(need('readShippedProfile')(), { profile: SHIPPED_PROFILE });
  });

  it('answers a well-formed profile read through deps', () => {
    assert.deepEqual(readProfileAs(json(SHIPPED_PROFILE)), { profile: SHIPPED_PROFILE });
  });

  for (const [name, spec, extraDeps] of [
    ['absent', undefined],
    ['a symlink', { kind: 'symlink', text: json(SHIPPED_PROFILE) }],
    ['a directory', { kind: 'directory' }],
    ['not UTF-8', INVALID_UTF8],
    ['refused at open', json(SHIPPED_PROFILE), (base) => failAt(base, 'open', PROFILE_REL)],
  ]) {
    it(`refuses a profile that is ${name} as profile-unreadable`, () => {
      assert.deepEqual(readProfileAs(spec, extraDeps), { refusal: 'profile-unreadable' });
    });
  }

  for (const [name, bytes] of [
    ['not JSON', '{ "schema": 1,'],
    ['a JSON array', '[]'],
    ['carrying an extra key', mutate((profile) => { profile.extra = true; })],
    ['missing its items', mutate((profile) => { delete profile.items; })],
    ['at schema 2', mutate((profile) => { profile.schema = 2; })],
    ['with a numeric lineage', mutate((profile) => { profile.lineage = 4; })],
    ['with a numeric name', mutate((profile) => { profile.name = 1; })],
    ['with items as an object', mutate((profile) => { profile.items = {}; })],
    ['with an item carrying an extra key', mutate((profile) => { profile.items[0].extra = 'x'; })],
    ['with an item missing has', mutate((profile) => { delete profile.items[0].has; })],
    ['with an empty item id', mutate((profile) => { profile.items[0].id = ''; })],
  ]) {
    it(`refuses a profile ${name} as profile-malformed`, () => {
      assert.deepEqual(readProfileAs(bytes), { refusal: 'profile-malformed' });
    });
  }

  it('answers absent when no record exists', () => {
    assert.deepEqual(readRecordAs(undefined), { absent: true });
  });

  for (const [name, declined] of [
    ['an empty map', {}],
    ['a current decline', { 'epic-store-seeded': LINEAGE }],
    ['an older decline and an id the profile does not carry', { 'epic-task-slots': OTHER_LINEAGE, 'not-a-profile-id': LINEAGE }],
  ]) {
    it(`answers the map of a record holding ${name}`, () => {
      assert.deepEqual(readRecordAs(record(declined)), { declined });
    });
  }

  for (const [name, spec, refusal, extraDeps] of [
    ['a symlink', { kind: 'symlink', text: record({}) }, 'declines-symlink'],
    ['a directory', { kind: 'directory' }, 'declines-unreadable'],
    ['not UTF-8', INVALID_UTF8, 'declines-unreadable'],
    ['refused at open', record({}), 'declines-unreadable', (root) => failAt(root, 'open', RECORD_REL)],
    ['not JSON', '{"schema":1,', 'declines-malformed'],
    ['a JSON array', '[]', 'declines-malformed'],
    ['carrying an extra key', json({ schema: 1, declined: {}, note: 'x' }), 'declines-malformed'],
    ['missing its map', json({ schema: 1 }), 'declines-malformed'],
    ['at schema 2', json({ schema: 2, declined: {} }), 'declines-malformed'],
    ['with the map as an array', json({ schema: 1, declined: [] }), 'declines-malformed'],
    ['with a null map', json({ schema: 1, declined: null }), 'declines-malformed'],
    ['with a numeric lineage', record({ 'epic-task-slots': 4 }), 'declines-malformed'],
    ['with an empty id', record({ '': LINEAGE }), 'declines-malformed'],
  ]) {
    it(`refuses a record that is ${name} as ${refusal}`, () => {
      assert.deepEqual(readRecordAs(spec, extraDeps), { refusal });
    });
  }

  for (const [name, declined, id, expected] of [
    ['a decline at the shipped lineage', { 'epic-task-slots': LINEAGE }, 'epic-task-slots', true],
    ['a decline at another lineage', { 'epic-task-slots': OTHER_LINEAGE }, 'epic-task-slots', false],
    ['an id the record does not hold', { 'epic-task-slots': LINEAGE }, 'epic-store-seeded', false],
    ['an inherited name', {}, 'toString', false],
    ['an absent record', undefined, 'epic-task-slots', false],
  ]) {
    it(`judges ${name} as ${expected ? 'current' : 'not current'}`, () => {
      assert.equal(need('isDeclineCurrent')(declined, id, LINEAGE), expected);
    });
  }

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
    const names = [...seen].map((file) => file.slice(HERE.length + 1));
    assert.ok(names.includes('fs-read-nofollow.mjs'), names.join(', '));
    assert.deepEqual(names.filter((name) => writers.includes(name)), []);
  });

  it('is library-only: a direct run points at the upgrade command and exits 2', () => {
    assert.equal(LIBRARY_ONLY_MODULES['reference-profile.mjs'], '/agent-workflow-kit upgrade');
    const run = spawnSync(process.execPath, [MODULE], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr.trim(), libraryOnlyLine('reference-profile.mjs'));
  });
});

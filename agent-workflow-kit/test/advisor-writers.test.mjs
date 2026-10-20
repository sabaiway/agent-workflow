import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lanes from '../tools/write-lanes.mjs';
import { kindOf } from '../tools/commands.mjs';

const need = (mod, name) => {
  if (!(name in mod)) {
    throw new Error(`${name} is absent`);
  }
  return mod[name];
};

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const facts = {
  toolsDir: join(KIT, 'tools'),
  root: '/project',
  env: {},
  home: '/home/example',
  platform: 'linux',
  tuple: 'apt-get:x',
};
const readTable = () => readFileSync(join(KIT, 'references', 'advisor-writers.md'), 'utf8');

const readRows = (text) => {
  const lines = text.split('\n');
  const separator = lines.indexOf('| --- | --- | --- |');
  assert.notEqual(separator, -1, 'table separator is absent');
  return lines.slice(separator + 1).filter((line) => line.startsWith('| ')).map((line) => {
    const [variant, lane, writer] = line.split('|').map((cell) => cell.trim()).slice(1, -1);
    return { variant, lane, writer };
  });
};

const tableMismatches = (rows, variantLanes) => {
  const expected = Object.keys(variantLanes);
  const variants = rows.map(({ variant }) => variant);
  const actual = new Set(variants);
  const missing = expected.filter((variant) => !actual.has(variant));
  const extra = [...actual].filter((variant) => !Object.hasOwn(variantLanes, variant));
  const duplicated = [...actual].filter((variant) => variants.filter((value) => value === variant).length > 1);
  return [
    ...missing.map((variant) => `missing variant: ${variant}`),
    ...extra.map((variant) => `extra variant: ${variant}`),
    ...duplicated.map((variant) => `duplicated variant: ${variant}`),
    ...(rows.length === expected.length ? [] : [`row count: ${rows.length}, expected: ${expected.length}`]),
  ];
};

describe('spec:init-project/S56 the completeness table by proof', () => {
  it('detects missing, extra and duplicated fixture rows and accepts exactly one row per key', () => {
    const header = readTable().split('\n').find((line) => line === '| variant | lane | writer |');
    assert.ok(header, 'table header is absent');
    const variantLanes = need(lanes, 'VARIANT_LANES');
    const keys = Object.keys(variantLanes);
    const rows = keys.map((variant) => `| ${variant} | ${variantLanes[variant]} | fixture.mjs |`);
    const render = (entries) => [header, '| --- | --- | --- |', ...entries].join('\n');
    const check = (entries) => tableMismatches(readRows(render(entries)), variantLanes);
    assert.ok(check(rows.slice(1)).includes(`missing variant: ${keys[0]}`), 'missing row must be reported');
    const extra = '__fixture_extra__';
    assert.equal(Object.hasOwn(variantLanes, extra), false, 'extra fixture variant must be unregistered');
    assert.ok(check([...rows, `| ${extra} | chat | fixture.mjs |`]).includes(`extra variant: ${extra}`));
    assert.ok(check([...rows, rows[0]]).includes(`duplicated variant: ${keys[0]}`));
    assert.deepEqual(check(rows), []);
  });

  it('has exactly one row per VARIANT_LANES key, forty-six in total', () => {
    const rows = readRows(readTable());
    const variantLanes = need(lanes, 'VARIANT_LANES');
    assert.deepEqual(tableMismatches(rows, variantLanes), []);
    assert.equal(Object.keys(variantLanes).length, 46);
  });

  it('gives every row the lane returned by laneOf', () => {
    const rows = readRows(readTable());
    const laneOf = need(lanes, 'laneOf');
    for (const row of rows) {
      assert.equal(row.lane, laneOf(row.variant), row.variant);
    }
  });

  it('names the consoleArgv apply file for every harness row', () => {
    const rows = readRows(readTable());
    const consoleArgv = need(lanes, 'consoleArgv');
    for (const row of rows.filter(({ lane }) => lane === 'harness')) {
      assert.equal(row.writer, basename(consoleArgv(row.variant, facts).apply[1]), row.variant);
    }
  });

  it('marks every user row as user step with an apply opening your own step', () => {
    const rows = readRows(readTable());
    const applySlot = need(lanes, 'applySlot');
    for (const row of rows.filter(({ lane }) => lane === 'user')) {
      assert.equal(row.writer, 'user step', row.variant);
      assert.ok(applySlot(row.variant, facts).apply.startsWith('your own step'), row.variant);
    }
  });

  it('names only existing tool files or documented writer modes in chat rows', () => {
    const rows = readRows(readTable());
    for (const row of rows.filter(({ lane }) => lane === 'chat')) {
      for (const name of row.writer.split(', ')) {
        const toolExists = existsSync(join(KIT, 'tools', name));
        const modeExists = kindOf(name) === 'writer' && existsSync(join(KIT, 'references', 'modes', `${name}.md`));
        assert.ok(toolExists || modeExists, `${row.variant}: unknown writer ${name}`);
      }
    }
  });

  it('counts nine user, sixteen chat and twenty-one harness rows', () => {
    const rows = readRows(readTable());
    assert.equal(rows.filter(({ lane }) => lane === 'user').length, 9, 'user row count');
    assert.equal(rows.filter(({ lane }) => lane === 'chat').length, 16, 'chat row count');
    assert.equal(rows.filter(({ lane }) => lane === 'harness').length, 21, 'harness row count');
  });
});

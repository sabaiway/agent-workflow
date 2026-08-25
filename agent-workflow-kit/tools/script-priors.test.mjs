// script-priors.test.mjs — the append-only catalog of shipped enforcement-script bodies, verified
// EXHAUSTIVELY against the fixture bytes: every catalog digest is the sha256 of its fixture and every
// fixture on disk has a catalog row, so neither side can drift behind the other. Then the three
// classification arms over real bytes (the bundle, every fixture, one flipped byte).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { SCRIPT_PRIORS, PRIOR_FILES, classifyDeployedScript, digestOf } = await import('./script-priors.mjs').catch(() => ({}));

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(KIT_ROOT, 'test', 'fixtures', 'script-priors');
const BUNDLE = join(KIT_ROOT, 'references', 'scripts');
// The append-only pin, INDEPENDENT of the module: every row the catalog has ever carried, as a
// literal, held as an immutable PREFIX of SCRIPT_PRIORS. A count alone would let a row and its
// fixture be replaced together — the digests would still agree — and a shipped body would silently
// become "custom" on every deployment that carries it. A release that changes ANY PRIOR_FILES member
// appends the outgoing body's row HERE too; a row is never edited or removed.
const FROZEN_PRIORS = [
  ['check-docs-size.mjs', '4.0.0', '4.3.0', '84fb3673b034d4b2ba5bedf4a3e47899f98da3971c17902d1f2a548d07dc53bf'],
  ['check-docs-size.mjs', '4.4.0', '4.5.0', '7a5cd7f98571c3248d0378623172e9c60073b8d8761bce7a95c263f99bfb3a42'],
  ['check-docs-size.mjs', '4.5.1', '4.5.4', 'fef3555b14a5ade46071bac18bd6dfc87daec39dd63ce1f7965864c3e51558d9'],
  ['check-docs-size.test.mjs', '4.0.0', '4.5.4', '88fbb3d7f097d74771b7c5d9ad99fcd58b274ae33f391e1ff01f4b138b9236cd'],
  ['spec-schema.mjs', '4.6.0', '4.6.1', 'f8ee23d81e90fd4225ca4ece288cba41982c4430290bc6d033f5ca18d2d283f4'],
  ['spec-schema.test.mjs', '4.6.0', '4.6.1', 'a12d6d3f5d32c6dabdee7e15af7d2ab15a0ced37515d1844fe0951f60cddbc99'],
  ['spec-schema.mjs', '4.7.0', '4.7.0', '40b5b038d5ec5ed53c327c6d269d22fe5fa2bed99ae711fbf84306ad047be452'],
  ['spec-schema.test.mjs', '4.7.0', '4.7.0', 'fde896419924223e54cfcabfdb1ef5807df5386fac700ed7c1463b6e7f81501b'],
];
const CATALOG_ROWS = FROZEN_PRIORS.length;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixturePath = (row) => join(FIXTURES, row.firstShipped, `${row.file}.txt`);
const bundleBytes = (file) => readFileSync(join(BUNDLE, file));

describe('SCRIPT_PRIORS — the catalog and its fixtures agree both ways', () => {
  it('carries the frozen row count, frozen rows, and a 64-hex digest per row', () => {
    assert.ok(Object.isFrozen(SCRIPT_PRIORS));
    assert.equal(SCRIPT_PRIORS.length, CATALOG_ROWS);
    for (const row of SCRIPT_PRIORS) {
      assert.ok(Object.isFrozen(row), row.file);
      assert.deepEqual(Object.keys(row).sort(), ['digest', 'file', 'firstShipped', 'lastShipped']);
      assert.match(row.digest, /^[0-9a-f]{64}$/, `${row.file} ${row.firstShipped}`);
      assert.ok(PRIOR_FILES.includes(row.file), `${row.file} is a refreshable script`);
    }
  });

  it('the frozen rows are an immutable PREFIX of the catalog — a row is only ever appended', () => {
    assert.ok(SCRIPT_PRIORS.length >= FROZEN_PRIORS.length, 'a shipped row was dropped');
    FROZEN_PRIORS.forEach(([file, firstShipped, lastShipped, digest], i) => {
      assert.deepEqual({ ...SCRIPT_PRIORS[i] }, { file, firstShipped, lastShipped, digest }, `row ${i} (${firstShipped}/${file}) was edited or moved`);
    });
  });

  it('every catalog digest is the sha256 of its fixture body', () => {
    for (const row of SCRIPT_PRIORS) {
      assert.equal(sha256(readFileSync(fixturePath(row))), row.digest, `${row.firstShipped}/${row.file}.txt`);
    }
  });

  it('every fixture on disk has exactly one catalog row', () => {
    const onDisk = [];
    for (const version of readdirSync(FIXTURES)) {
      for (const name of readdirSync(join(FIXTURES, version))) onDisk.push(`${version}/${name}`);
    }
    const catalogued = SCRIPT_PRIORS.map((row) => `${row.firstShipped}/${row.file}.txt`);
    assert.deepEqual(onDisk.sort(), catalogued.sort());
    assert.equal(new Set(catalogued).size, catalogued.length, 'no row is listed twice');
  });

  it('no prior digest is the bundled body — the outgoing body is appended only once it has changed', () => {
    for (const file of PRIOR_FILES) {
      const current = sha256(bundleBytes(file));
      for (const row of SCRIPT_PRIORS.filter((r) => r.file === file)) {
        assert.notEqual(row.digest, current, `${row.firstShipped}/${file} is the current bundle`);
      }
    }
  });
});

describe('classifyDeployedScript — current | prior | custom over real bytes', () => {
  it('the bundled pair classifies current', () => {
    for (const file of PRIOR_FILES) {
      assert.equal(classifyDeployedScript(bundleBytes(file), file, bundleBytes(file)), 'current', file);
    }
  });

  it('every fixture body classifies prior', () => {
    for (const row of SCRIPT_PRIORS) {
      assert.equal(classifyDeployedScript(readFileSync(fixturePath(row)), row.file, bundleBytes(row.file)), 'prior', fixturePath(row));
    }
  });

  it('one flipped byte in a prior body classifies custom, and so does a file the catalog never lists', () => {
    const row = SCRIPT_PRIORS[0];
    const flipped = Buffer.from(readFileSync(fixturePath(row)));
    flipped[0] = flipped[0] ^ 0x01;
    assert.equal(classifyDeployedScript(flipped, row.file, bundleBytes(row.file)), 'custom');
    assert.equal(classifyDeployedScript(Buffer.from('// mine\n'), 'spec-schema.mjs', bundleBytes('spec-schema.mjs')), 'custom');
    assert.equal(classifyDeployedScript(bundleBytes('spec-schema.mjs'), 'spec-schema.mjs', bundleBytes('spec-schema.mjs')), 'current');
  });

  it('digestOf is the sha256 hex of the bytes', () => {
    assert.equal(digestOf(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

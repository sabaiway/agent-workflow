import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LINEAGE_HEAD,
  parseSemver,
  compareSemver,
  decideTakeover,
  selectMigrations,
  writeStampAtomic,
  applyTakeover,
  readStamp,
} from './stamp-takeover.mjs';

describe('LINEAGE_HEAD', () => {
  it('is the shared deployment-lineage head (not this package version)', () => {
    assert.equal(LINEAGE_HEAD, '2.0.0');
  });
});

describe('parseSemver / compareSemver', () => {
  it('parses plain and v-prefixed semver, rejects junk', () => {
    assert.deepEqual(parseSemver('1.3.0'), [1, 3, 0]);
    assert.deepEqual(parseSemver(' v2.0.1 '), [2, 0, 1]);
    assert.equal(parseSemver('1.3'), null);
    assert.equal(parseSemver('next'), null);
    assert.equal(parseSemver(null), null);
  });
  it('orders versions and returns null on unparseable input', () => {
    assert.equal(compareSemver('1.2.0', '1.3.0'), -1);
    assert.equal(compareSemver('1.3.0', '1.3.0'), 0);
    assert.equal(compareSemver('1.4.0', '1.3.0'), 1);
    assert.equal(compareSemver('x', '1.0.0'), null);
  });
});

describe('decideTakeover — §1.5 state table (pure, per row)', () => {
  it('only .workflow-version=V → copy V verbatim → .memory-version; migrate from V', () => {
    const d = decideTakeover({ memoryVersion: null, workflowVersion: '1.2.0' });
    assert.equal(d.status, 'ok');
    assert.equal(d.writeMemoryVersion, '1.2.0'); // exact stamp value asserted
    assert.equal(d.migrateFrom, '1.2.0');
  });

  it('both stamps → no takeover write; migrate from .memory-version', () => {
    const d = decideTakeover({ memoryVersion: '1.3.0', workflowVersion: '1.1.0' });
    assert.equal(d.status, 'ok');
    assert.equal(d.writeMemoryVersion, null);
    assert.equal(d.migrateFrom, '1.3.0');
  });

  it('only .memory-version → migrate from it, no write', () => {
    const d = decideTakeover({ memoryVersion: '1.1.0', workflowVersion: null });
    assert.equal(d.status, 'ok');
    assert.equal(d.writeMemoryVersion, null);
    assert.equal(d.migrateFrom, '1.1.0');
  });

  it('no stamp → conservative re-bootstrap', () => {
    const d = decideTakeover({ memoryVersion: null, workflowVersion: null });
    assert.equal(d.status, 'rebootstrap');
    assert.equal(d.writeMemoryVersion, null);
    assert.equal(d.migrateFrom, null);
  });

  it('unparseable .memory-version → STOP', () => {
    const d = decideTakeover({ memoryVersion: 'garbage', workflowVersion: '1.2.0' });
    assert.equal(d.status, 'stop');
    assert.equal(d.writeMemoryVersion, null);
  });

  it('PRESENT but empty/whitespace stamp → STOP (not absent → rebootstrap)', () => {
    assert.equal(decideTakeover({ memoryVersion: null, workflowVersion: '' }).status, 'stop');
    assert.equal(decideTakeover({ memoryVersion: '   ', workflowVersion: null }).status, 'stop');
  });

  it('unparseable .workflow-version → STOP', () => {
    const d = decideTakeover({ memoryVersion: null, workflowVersion: 'not-a-version' });
    assert.equal(d.status, 'stop');
  });

  it('future .memory-version (> head) → STOP', () => {
    const d = decideTakeover({ memoryVersion: '2.1.0', workflowVersion: null });
    assert.equal(d.status, 'stop');
    assert.match(d.note, /newer than the lineage head/);
  });

  it('future .workflow-version (> head) → STOP', () => {
    const d = decideTakeover({ memoryVersion: null, workflowVersion: '9.9.9' });
    assert.equal(d.status, 'stop');
  });

  it('workflow exactly at head → takeover writes the head', () => {
    const d = decideTakeover({ memoryVersion: null, workflowVersion: '2.0.0' });
    assert.equal(d.status, 'ok');
    assert.equal(d.writeMemoryVersion, '2.0.0');
  });
});

describe('selectMigrations', () => {
  const available = ['1.1.0', '1.2.0', '1.3.0'];
  it('selects strictly-newer migrations up to the head, ascending', () => {
    assert.deepEqual(selectMigrations('1.0.0', available), ['1.1.0', '1.2.0', '1.3.0']);
    assert.deepEqual(selectMigrations('1.2.0', available), ['1.3.0']);
    assert.deepEqual(selectMigrations('1.3.0', available), []);
  });
  it('null migrateFrom selects all ≤ head; excludes future migrations', () => {
    assert.deepEqual(selectMigrations(null, [...available, '2.1.0']), ['1.1.0', '1.2.0', '1.3.0']);
  });
});

describe('applyTakeover — atomic, idempotent, integration (temp fs)', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stamp-takeover-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('legacy-only: writes .memory-version verbatim and preserves .workflow-version', async () => {
    await writeFile(join(dir, '.workflow-version'), '1.2.0\n', 'utf8');
    const d = await applyTakeover(dir);
    assert.equal(d.writeMemoryVersion, '1.2.0');
    assert.equal(await readStamp(join(dir, '.memory-version')), '1.2.0');
    assert.equal(await readStamp(join(dir, '.workflow-version')), '1.2.0'); // never deleted
    // single trailing newline, no leftover temp files
    assert.equal(await readFile(join(dir, '.memory-version'), 'utf8'), '1.2.0\n');
    assert.equal((await readdir(dir)).filter((f) => f.includes('.tmp-')).length, 0);
  });

  it('is idempotent — a second run does not rewrite the stamp', async () => {
    await writeFile(join(dir, '.workflow-version'), '1.2.0\n', 'utf8');
    await applyTakeover(dir);
    const second = await applyTakeover(dir);
    assert.equal(second.writeMemoryVersion, null); // memory now present → no write
    assert.equal(second.migrateFrom, '1.2.0');
    assert.equal(await readStamp(join(dir, '.memory-version')), '1.2.0');
  });

  it('both stamps present: leaves .memory-version untouched', async () => {
    await writeFile(join(dir, '.memory-version'), '1.3.0\n', 'utf8');
    await writeFile(join(dir, '.workflow-version'), '1.1.0\n', 'utf8');
    const d = await applyTakeover(dir);
    assert.equal(d.writeMemoryVersion, null);
    assert.equal(await readStamp(join(dir, '.memory-version')), '1.3.0');
  });

  it('STOP state performs no write (future stamp leaves prior state intact)', async () => {
    await writeFile(join(dir, '.workflow-version'), '5.0.0\n', 'utf8');
    const d = await applyTakeover(dir);
    assert.equal(d.status, 'stop');
    assert.equal(existsSync(join(dir, '.memory-version')), false); // nothing written
  });

  it('writeStampAtomic overwrites cleanly with a single trailing newline', async () => {
    const target = join(dir, '.memory-version');
    await writeStampAtomic(target, '1.1.0');
    await writeStampAtomic(target, '1.3.0');
    assert.equal(await readFile(target, 'utf8'), '1.3.0\n');
    assert.equal((await readdir(dir)).filter((f) => f.includes('.tmp-')).length, 0);
  });
});

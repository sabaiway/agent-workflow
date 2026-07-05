import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAutonomy, AUTONOMY_WRITE_STOP } from './autonomy-write.mjs';
import { serializeAutonomy } from './autonomy-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTONOMY_REL = join('docs', 'ai', 'autonomy.json');
const CFG = { _README: 'note', redlines: { commit: 'ask' }, 'plan-execution': { autonomy: 'sandbox' } };

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'autonomy-write-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const dstOf = () => join(cwd, AUTONOMY_REL);
const tmpsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

describe('autonomy-write — deployment gate', () => {
  it('no docs/ai → STOP loud (pointing at init/bootstrap), writes nothing', () => {
    assert.throws(
      () => writeAutonomy(cwd, CFG),
      (e) => e.code === AUTONOMY_WRITE_STOP && /no agent-workflow deployment/.test(e.message) && /init\/bootstrap/.test(e.message),
    );
  });
});

describe('autonomy-write — atomic write (exclusive-create tmp + rename)', () => {
  beforeEach(() => mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true }));

  it('writes the canonical serialization and returns the rel path; leaves no tmp', () => {
    const r = writeAutonomy(cwd, CFG);
    assert.equal(r.writtenPath, AUTONOMY_REL);
    assert.equal(readFileSync(dstOf(), 'utf8'), serializeAutonomy(CFG));
    assert.deepEqual(tmpsIn(join(cwd, 'docs', 'ai')), [], 'no leftover tmp file');
  });

  it('overwrites an existing regular file atomically', () => {
    writeFileSync(dstOf(), '{ "_README": "old" }\n');
    writeAutonomy(cwd, CFG);
    assert.equal(readFileSync(dstOf(), 'utf8'), serializeAutonomy(CFG));
    assert.deepEqual(tmpsIn(join(cwd, 'docs', 'ai')), []);
  });

  it('opens the tmp exclusive-create (wx) — a colliding tmp surfaces, not silently overwritten', () => {
    const tmp = `${dstOf()}.fixed.tmp`;
    writeFileSync(tmp, 'pre-existing');
    assert.throws(() => writeAutonomy(cwd, CFG, { rand: () => 'fixed' }), (e) => e.code === 'EEXIST');
    assert.equal(readFileSync(tmp, 'utf8'), 'pre-existing', 'the colliding tmp was not clobbered');
  });
});

describe('autonomy-write — symlink + TOCTOU hardening', () => {
  beforeEach(() => mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true }));

  it('refuses a SYMLINKED leaf (autonomy.json is a symlink) — STOP, link untouched', () => {
    const realTarget = join(cwd, 'secret.json');
    writeFileSync(realTarget, 'SECRET');
    symlinkSync(realTarget, dstOf());
    assert.throws(() => writeAutonomy(cwd, CFG), (e) => e.code === AUTONOMY_WRITE_STOP && /symlink/.test(e.message));
    assert.equal(readFileSync(realTarget, 'utf8'), 'SECRET', 'the link target is untouched');
  });

  it('refuses a symlinked docs/ai PARENT (not just the leaf)', () => {
    rmSync(join(cwd, 'docs', 'ai'), { recursive: true, force: true });
    const realDir = join(cwd, 'elsewhere');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(cwd, 'docs', 'ai'));
    assert.throws(() => writeAutonomy(cwd, CFG), /symlink/);
    assert.deepEqual(readdirSync(realDir), [], 'nothing was written through the symlinked parent');
  });

  it('re-checks the leaf immediately before rename (TOCTOU) — a leaf that becomes a symlink after the pre-check is refused; tmp cleaned', () => {
    const racedTarget = join(cwd, 'raced.json');
    writeFileSync(racedTarget, 'RACED');
    let renamed = false;
    const deps = {
      rand: () => 'race',
      writeFile: (p, body, opts) => {
        writeFileSync(p, body, opts);
        symlinkSync(racedTarget, dstOf());
      },
      rename: () => { renamed = true; },
    };
    assert.throws(() => writeAutonomy(cwd, CFG, deps), /symlink/);
    assert.equal(renamed, false, 'rename must NOT run once the leaf raced to a symlink');
    assert.equal(readFileSync(racedTarget, 'utf8'), 'RACED', 'the raced link target is untouched');
    assert.deepEqual(tmpsIn(join(cwd, 'docs', 'ai')), [], 'the tmp is cleaned up on the aborted rename');
  });
});

// Structural read-only invariant: the read/schema core must NEVER reach the fs-writer. Enforced by
// MODULE STRUCTURE (autonomy-config.mjs does not import autonomy-write.mjs), so it cannot be defeated
// at runtime — only by an edit this guard catches.
describe('import-split guard — the read core never imports the writer', () => {
  it('autonomy-config.mjs source contains no import of autonomy-write', () => {
    const src = readFileSync(join(HERE, 'autonomy-config.mjs'), 'utf8');
    const importsWriter = /from\s+['"][^'"]*autonomy-write/.test(src) || /import\(\s*['"][^'"]*autonomy-write/.test(src);
    assert.ok(!importsWriter, 'autonomy-config.mjs must not import the fs-writer (read-only invariant)');
  });
});

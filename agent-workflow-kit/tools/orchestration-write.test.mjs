import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeConfig, ORCH_WRITE_STOP } from './orchestration-write.mjs';
import { serializeConfig } from './orchestration-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_REL = join('docs', 'ai', 'orchestration.json');
const CFG = { _README: 'note', 'plan-authoring': { review: 'council' } };

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'orch-write-'));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const dstOf = () => join(cwd, CONFIG_REL);
const tmpsIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

describe('orchestration-write — deployment gate', () => {
  it('no docs/ai → STOP loud (pointing at init/bootstrap), writes nothing', () => {
    assert.throws(
      () => writeConfig(cwd, CFG),
      (e) => e.code === ORCH_WRITE_STOP && /no agent-workflow deployment/.test(e.message) && /init\/bootstrap/.test(e.message),
    );
  });
});

describe('orchestration-write — atomic write (exclusive-create tmp + rename)', () => {
  beforeEach(() => mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true }));

  it('writes the canonical serialization and returns the rel path; leaves no tmp', () => {
    const r = writeConfig(cwd, CFG);
    assert.equal(r.writtenPath, CONFIG_REL);
    assert.equal(readFileSync(dstOf(), 'utf8'), serializeConfig(CFG));
    assert.deepEqual(tmpsIn(join(cwd, 'docs', 'ai')), [], 'no leftover tmp file');
  });

  it('overwrites an existing regular file atomically', () => {
    writeFileSync(dstOf(), '{ "_README": "old" }\n');
    writeConfig(cwd, CFG);
    assert.equal(readFileSync(dstOf(), 'utf8'), serializeConfig(CFG));
    assert.deepEqual(tmpsIn(join(cwd, 'docs', 'ai')), []);
  });

  it('opens the tmp exclusive-create (wx) — a colliding tmp surfaces, not silently overwritten', () => {
    // Force a fixed tmp name AND pre-create it: wx must reject (EEXIST), never clobber it.
    const tmp = `${dstOf()}.fixed.tmp`;
    writeFileSync(tmp, 'pre-existing');
    assert.throws(() => writeConfig(cwd, CFG, { rand: () => 'fixed' }), (e) => e.code === 'EEXIST');
    assert.equal(readFileSync(tmp, 'utf8'), 'pre-existing', 'the colliding tmp was not clobbered');
  });
});

describe('orchestration-write — symlink + TOCTOU hardening', () => {
  beforeEach(() => mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true }));

  it('refuses a SYMLINKED leaf (orchestration.json is a symlink) — STOP, link untouched', () => {
    const realTarget = join(cwd, 'secret.json');
    writeFileSync(realTarget, 'SECRET');
    symlinkSync(realTarget, dstOf());
    assert.throws(() => writeConfig(cwd, CFG), (e) => e.code === ORCH_WRITE_STOP && /symlink/.test(e.message));
    assert.equal(readFileSync(realTarget, 'utf8'), 'SECRET', 'the link target is untouched');
  });

  it('refuses a symlinked docs/ai PARENT (not just the leaf)', () => {
    // Replace docs/ai with a symlink to a real sibling dir → the parent-chain guard must refuse.
    rmSync(join(cwd, 'docs', 'ai'), { recursive: true, force: true });
    const realDir = join(cwd, 'elsewhere');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(cwd, 'docs', 'ai'));
    assert.throws(() => writeConfig(cwd, CFG), /symlink/);
    assert.deepEqual(readdirSync(realDir), [], 'nothing was written through the symlinked parent');
  });

  it('re-checks the leaf immediately before rename (TOCTOU) — a leaf that becomes a symlink after the pre-check is refused; tmp cleaned', () => {
    // Inject writeFile to perform the real tmp write AND race a symlink into place at the dst, so the
    // pre-rename re-check (real lstat) sees a symlink that was absent during the pre-checks.
    const racedTarget = join(cwd, 'raced.json');
    writeFileSync(racedTarget, 'RACED');
    let renamed = false;
    const deps = {
      rand: () => 'race',
      writeFile: (p, body, opts) => {
        writeFileSync(p, body, opts); // real tmp write (exclusive-create honored by real fs)
        symlinkSync(racedTarget, dstOf()); // the race: dst becomes a symlink AFTER the pre-checks
      },
      rename: () => { renamed = true; },
    };
    assert.throws(() => writeConfig(cwd, CFG, deps), /symlink/);
    assert.equal(renamed, false, 'rename must NOT run once the leaf raced to a symlink');
    assert.equal(readFileSync(racedTarget, 'utf8'), 'RACED', 'the raced link target is untouched');
    assert.deepEqual(tmpsIn(join(cwd, 'docs', 'ai')), [], 'the tmp is cleaned up on the aborted rename');
  });
});

// Structural read-only invariant: the read-only procedures advisor must NEVER reach the fs-writer. This
// is enforced by MODULE STRUCTURE (procedures.mjs does not import orchestration-write.mjs), so it cannot
// be defeated at runtime — only by an edit this guard catches.
describe('import-split guard — procedures.mjs never imports the writer', () => {
  it('procedures.mjs source contains no import of orchestration-write', () => {
    const src = readFileSync(join(HERE, 'procedures.mjs'), 'utf8');
    // Match an actual import (static `from '…orchestration-write…'` or dynamic `import('…')`) — NOT a
    // mere mention in a comment (procedures.mjs documents that it deliberately never imports the writer).
    const importsWriter = /from\s+['"][^'"]*orchestration-write/.test(src) || /import\(\s*['"][^'"]*orchestration-write/.test(src);
    assert.ok(!importsWriter, 'procedures.mjs must not import the fs-writer (read-only invariant)');
  });
});

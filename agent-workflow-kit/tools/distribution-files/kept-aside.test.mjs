// kept-aside.test.mjs — keepAside as its contract states it: each copy written create-only at
// .agent-workflow/kept-aside/<first 16 hex>/<rel> from the entry's bytes and proven by sha256, the
// ignore file proven before the first copy, and every refusal (node kind, other bytes, a thrown
// write) leaving each copy and each link target exactly as it was. Real temp projects.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { KIT_OWN_PATHS } from '../known-footprint.mjs';

const { KEPT_ASIDE_DIR, keepAside } = await import('./kept-aside.mjs').catch(() => ({}));

const DIGEST = 'ab'.repeat(32);
const IGNORE = '.agent-workflow/.gitignore';
const COPY_A = '.agent-workflow/kept-aside/abababababababab/scripts/a.mjs';
const COPY_B = '.agent-workflow/kept-aside/abababababababab/scripts/b.mjs';
const CHANNEL = 'a script or suite of your own under its own name in scripts/, or a config the script reads';
const BODY_A = '// my a\n';
const BODY_B = '// my b\n';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const entry = (rel, text, sha256 = sha(text)) => ({ rel, sha256, bytes: Buffer.from(text), channel: CHANNEL });
// Handed out of rel order: `kept` comes back in rel order.
const ENTRIES = [entry('scripts/b.mjs', BODY_B), entry('scripts/a.mjs', BODY_A)];
const KEPT = [{ rel: 'scripts/a.mjs', path: COPY_A, created: true }, { rel: 'scripts/b.mjs', path: COPY_B, created: true }];
const PROVEN = KEPT.map((copy) => ({ ...copy, created: false }));

const kindLine = (path, kind) => `${path}: exists but is ${kind} — nothing was kept aside or replaced; resolve it by hand, then re-run`;
const otherBytesLine = (path) => `${path}: a copy with other bytes is there — it is the user's to move or delete before the yes is asked again; nothing was replaced`;
const IGNORE_LINE = `${IGNORE}: holds other bytes — it must hold exactly "*" and a line feed, so git sees no kept-aside copy; nothing was kept aside or replaced`;

const withDirs = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-aside-'));
  const other = mkdtempSync(join(tmpdir(), 'kept-aside-target-'));
  try {
    return fn(dir, other);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
};
const put = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const bytesAt = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel)) : null);
const snapshot = (dir) => {
  const out = new Map();
  const walk = (current) => {
    for (const node of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, node.name);
      const rel = relative(dir, full);
      if (node.isDirectory()) {
        out.set(rel, '<dir>');
        walk(full);
      } else out.set(rel, node.isFile() ? readFileSync(full) : '<link>');
    }
  };
  walk(dir);
  return out;
};
const run = (dir, entries = ENTRIES, deps = {}) => keepAside({ cwd: dir, digest: DIGEST, entries, deps });
const recording = () => {
  const seen = [];
  const renamed = [];
  const deps = {
    link: (from, to) => { seen.push(to); return linkSync(from, to); },
    rename: (from, to) => { renamed.push(to); throw new Error('a create-only write never renames'); },
  };
  return { seen, renamed, deps };
};
const assertFailed = (result, cause, lines) => {
  assert.equal(result.failed, true);
  assert.equal(result.cause, cause);
  assert.deepEqual(result.lines, lines);
};

describe('spec:distribution-files/S3 keepAside writes proven create-only copies behind the ignore file and never overwrites or removes one', () => {
  for (const [label, setup, published] of [
    ['with .agent-workflow absent', () => {}, [IGNORE, COPY_A, COPY_B]],
    ['with .agent-workflow present without the ignore file', (dir) => mkdirSync(join(dir, '.agent-workflow')), [IGNORE, COPY_A, COPY_B]],
    ['with an ignore file holding exactly a star and a line feed', (dir) => put(dir, IGNORE, '*\n'), [COPY_A, COPY_B]],
  ]) {
    it(`${label}: the ignore file stands before the first copy, and each copy holds its entry's bytes`, () => withDirs((dir) => {
      setup(dir);
      put(dir, 'scripts/a.mjs', '// the source moved on\n');
      const { seen, renamed, deps } = recording();
      assert.deepEqual(run(dir, ENTRIES, deps), { failed: false, kept: KEPT });
      assert.deepEqual(seen.map((to) => relative(dir, to)), published, 'create-only publications, the ignore file first');
      assert.deepEqual(renamed, []);
      assert.deepEqual(bytesAt(dir, IGNORE), Buffer.from('*\n'));
      assert.deepEqual(bytesAt(dir, COPY_A), Buffer.from(BODY_A), 'the copy comes from the entry, never the source');
      assert.deepEqual(bytesAt(dir, COPY_B), Buffer.from(BODY_B));
    }));
  }

  for (const [label, body] of [['an empty ignore file', ''], ['an ignore file holding !kept-aside/', '!kept-aside/\n']]) {
    it(`${label} is write-refused with nothing copied and the file unchanged`, () => withDirs((dir) => {
      put(dir, IGNORE, body);
      const before = snapshot(dir);
      assertFailed(run(dir), 'write-refused', [IGNORE_LINE]);
      assert.deepEqual(snapshot(dir), before);
    }));
  }

  for (const [label, setup, line] of [
    ['a directory at the ignore file', (dir) => mkdirSync(join(dir, IGNORE), { recursive: true }), kindLine(IGNORE, 'a directory')],
    ['a symlink at .agent-workflow', (dir, other) => symlinkSync(other, join(dir, '.agent-workflow')), kindLine('.agent-workflow', 'a symlink')],
    ['a regular file at .agent-workflow', (dir) => writeFileSync(join(dir, '.agent-workflow'), 'x\n'), kindLine('.agent-workflow', 'a regular file')],
    ['a symlink at a later segment', (dir, other) => {
      mkdirSync(join(dir, '.agent-workflow'));
      symlinkSync(other, join(dir, '.agent-workflow', 'kept-aside'));
    }, kindLine('.agent-workflow/kept-aside', 'a symlink')],
    ['a directory at a copy path', (dir) => mkdirSync(join(dir, COPY_B), { recursive: true }), kindLine(COPY_B, 'a directory')],
  ]) {
    it(`${label} is wrong-node-kind with nothing created and the link target unchanged`, () => withDirs((dir, other) => {
      setup(dir, other);
      const before = snapshot(dir);
      assertFailed(run(dir), 'wrong-node-kind', [line]);
      assert.deepEqual(snapshot(dir), before, 'no ignore file, no copy');
      assert.deepEqual(readdirSync(other), []);
    }));
  }

  it('present copies with equal bytes are the proof: nothing written and the tree byte-identical', () => withDirs((dir) => {
    put(dir, IGNORE, '*\n');
    put(dir, COPY_A, BODY_A);
    put(dir, COPY_B, BODY_B);
    const before = snapshot(dir);
    assert.deepEqual(run(dir), { failed: false, kept: PROVEN });
    assert.deepEqual(snapshot(dir), before);
  }));

  it("a present copy with other bytes is race-unresolved and the user's; the copy written before it stays and is named", () => withDirs((dir) => {
    put(dir, COPY_B, '// theirs\n');
    assertFailed(run(dir), 'race-unresolved', [otherBytesLine(COPY_B), `the edits already kept aside stay where they are: ${COPY_A}`]);
    assert.deepEqual(bytesAt(dir, COPY_B), Buffer.from('// theirs\n'));
    assert.deepEqual(bytesAt(dir, COPY_A), Buffer.from(BODY_A));
  }));

  it('a read-back that is not the bound sha256 is race-unresolved, and the written copy is left in place', () => withDirs((dir) => {
    assertFailed(run(dir, [entry('scripts/a.mjs', BODY_A, sha('// other\n'))]), 'race-unresolved', [otherBytesLine(COPY_A)]);
    assert.deepEqual(bytesAt(dir, COPY_A), Buffer.from(BODY_A));
  }));

  it('an absent entry gets no copy, and an all-absent set creates nothing at all', () => withDirs((dir) => {
    const absent = { rel: 'scripts/c.mjs', absent: true };
    assert.deepEqual(run(dir, [absent]), { failed: false, kept: [] });
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(run(dir, [absent, entry('scripts/a.mjs', BODY_A)]), { failed: false, kept: [KEPT[0]] });
    assert.equal(existsSync(join(dir, '.agent-workflow/kept-aside/abababababababab/scripts/c.mjs')), false);
  }));

  it('a refused write is write-refused naming the path it was writing', () => withDirs((dir) => {
    const link = () => { throw Object.assign(new Error('EACCES: permission denied, link'), { code: 'EACCES' }); };
    const result = run(dir, ENTRIES, { link });
    assert.equal(result.failed, true);
    assert.equal(result.cause, 'write-refused');
    assert.ok(result.lines[0].startsWith(`${IGNORE}: EACCES`), result.lines[0]);
    assert.ok(result.lines[0].endsWith('— nothing was replaced'), result.lines[0]);
    assert.equal(existsSync(join(dir, COPY_A)), false);
  }));

  it('a re-run over copies a previous run proved changes no byte', () => withDirs((dir) => {
    assert.deepEqual(run(dir), { failed: false, kept: KEPT });
    const before = snapshot(dir);
    assert.deepEqual(run(dir), { failed: false, kept: PROVEN });
    assert.deepEqual(snapshot(dir), before);
  }));

  it('KIT_OWN_PATHS carries no path under the reserved folder', () => {
    assert.equal(KEPT_ASIDE_DIR, '.agent-workflow/kept-aside');
    assert.deepEqual(KIT_OWN_PATHS.filter((path) => /^\/?\.agent-workflow(\/|$)/.test(path)), []);
  });
});

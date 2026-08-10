import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, renameSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  enumerateReturnedObjects, computeReturnedDiff, assembleIntegrationBundle, parseNumstatMarkers,
  PRE_IMAGE_ID_PREFIX, NEW_IMAGE_ID_PREFIX,
} from './exec-producer.mjs';
import { computeNumerator, parseIntegrationBundle, expectedBundleLength } from './dispatch-record.mjs';
import { computeFingerprintPayload } from './core-evidence.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-exec-producer-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

let seq = 0;
const makeRepo = (seed = {}) => {
  const root = join(TMP, `repo-${seq += 1}`);
  mkdirSync(root, { recursive: true });
  sh(['init', '-q', '-b', 'main'], root);
  sh(['config', 'user.email', 'coder-tools@proton.me'], root);
  sh(['config', 'user.name', 'coder-tool'], root);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  for (const [rel, content] of Object.entries(seed)) writeFileSync(join(root, rel), content);
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
};

const entriesOf = (root, io) => {
  const enumerated = enumerateReturnedObjects(root, io);
  assert.equal(enumerated.ok, true, enumerated.reason);
  return enumerated.entries;
};
const refusalOf = (root, io) => {
  const enumerated = enumerateReturnedObjects(root, io);
  assert.equal(enumerated.ok, false, 'expected a refusal');
  return enumerated.reason;
};
const byPath = (entries, path) => entries.find((e) => e.path === path);

describe('exec-producer — per-kind enumeration', () => {
  it('a created file counts its post-image and takes the new: identity domain', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'created.txt'), 'hello\n');
    const entry = byPath(entriesOf(root), 'created.txt');
    assert.deepEqual(entry, { kind: 'new', path: 'created.txt', objectId: `${NEW_IMAGE_ID_PREFIX}created.txt`, postImageBytes: 6 });
  });

  it('a modified file counts its PRE-image and takes the pre: identity domain', () => {
    const root = makeRepo({ 'target.txt': 'aaaa\n' });
    writeFileSync(join(root, 'target.txt'), 'a\n');
    const entry = byPath(entriesOf(root), 'target.txt');
    assert.deepEqual(entry, { kind: 'modified', path: 'target.txt', objectId: `${PRE_IMAGE_ID_PREFIX}target.txt`, preImageBytes: 5 });
  });

  it('a deleted file counts its pre-image from the object database, off disk', () => {
    const root = makeRepo({ 'gone.txt': 'seven!\n' });
    unlinkSync(join(root, 'gone.txt'));
    const entry = byPath(entriesOf(root), 'gone.txt');
    assert.deepEqual(entry, { kind: 'deleted', path: 'gone.txt', objectId: `${PRE_IMAGE_ID_PREFIX}gone.txt`, preImageBytes: 7 });
  });
});

describe('exec-producer — the domain is HEAD → index → worktree, never HEAD → worktree', () => {
  it('a staged change reverted in the worktree is still a touched object', () => {
    const root = makeRepo({ 'target.txt': 'original\n' });
    writeFileSync(join(root, 'target.txt'), 'staged edit\n');
    sh(['add', 'target.txt'], root);
    writeFileSync(join(root, 'target.txt'), 'original\n');
    const entry = byPath(entriesOf(root), 'target.txt');
    assert.ok(entry, 'a staged-then-reverted object must not vanish from the numerator while its bytes stay in the denominator');
    assert.equal(entry.kind, 'modified');
    assert.equal(entry.objectId, `${PRE_IMAGE_ID_PREFIX}target.txt`);
    assert.equal(entry.preImageBytes, 9);
  });

  it('a staged add followed by an unstaged delete counts its INDEX image once (the transient rule)', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'transient.txt'), 'transient\n');
    sh(['add', 'transient.txt'], root);
    unlinkSync(join(root, 'transient.txt'));
    const entries = entriesOf(root);
    const entry = byPath(entries, 'transient.txt');
    assert.ok(entry, 'an object the delegate created and removed still consumed authoring bytes');
    assert.deepEqual(entry, { kind: 'new', path: 'transient.txt', objectId: `${NEW_IMAGE_ID_PREFIX}transient.txt`, postImageBytes: 10 });
    assert.equal(entries.filter((e) => e.path === 'transient.txt').length, 1);
  });

  it('an object touched in BOTH layers is ONE entry counting the HEAD pre-image', () => {
    const root = makeRepo({ 'target.txt': 'head image\n' });
    writeFileSync(join(root, 'target.txt'), 'index image\n');
    sh(['add', 'target.txt'], root);
    writeFileSync(join(root, 'target.txt'), 'worktree image\n');
    const entries = entriesOf(root).filter((e) => e.path === 'target.txt');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].preImageBytes, 11, 'the pre-image is the HEAD blob, never the index blob');
  });
});

// The rename MATCHER was subtracted after four review rounds of silent-error edges. These tests keep
// their names — each is a declared red-proof, and a declaration is one-way — but they now pin the
// BOUNDARY that replaced it: git's own rename detection is consumed where git offers it, and nothing
// else is ever paired on a resemblance.
describe('exec-producer — renames are git\'s answer or they are two objects', () => {
  it('a filesystem rename is a deletion plus a creation — the stated over-count limit', () => {
    const root = makeRepo({ 'old.txt': 'content here\n' });
    renameSync(join(root, 'old.txt'), join(root, 'new.txt'));
    const entries = entriesOf(root);
    assert.equal(entries.filter((e) => e.kind === 'renamed').length, 0, 'nothing pairs a deletion with a creation on content resemblance');
    assert.deepEqual(byPath(entries, 'old.txt'), {
      kind: 'deleted', path: 'old.txt', objectId: `${PRE_IMAGE_ID_PREFIX}old.txt`, preImageBytes: 13,
    });
    assert.deepEqual(byPath(entries, 'new.txt'), {
      kind: 'new', path: 'new.txt', objectId: `${NEW_IMAGE_ID_PREFIX}new.txt`, postImageBytes: 13,
    });
    const numerator = computeNumerator(entries);
    assert.equal(numerator.ok, true, numerator.reason);
    assert.equal(numerator.numeratorBytes, 13 + 13, 'the limit OVER-counts — the metric reads optimistic, never pessimistic');
  });

  it('a staged rename is one renamed entry identified by the name it had', () => {
    const root = makeRepo({ 'old.txt': 'content here\n' });
    sh(['mv', 'old.txt', 'new.txt'], root);
    const renamed = entriesOf(root).filter((e) => e.kind === 'renamed');
    assert.equal(renamed.length, 1, "git's OWN -M detection within a layer is still consumed");
    assert.equal(renamed[0].objectId, `${PRE_IMAGE_ID_PREFIX}old.txt`);
    assert.equal(renamed[0].path, 'new.txt');
  });

  it('a staged rename A→B followed by a filesystem rename B→C is the staged rename plus a creation', () => {
    const root = makeRepo({ 'a.txt': 'chained content\n' });
    sh(['mv', 'a.txt', 'b.txt'], root);
    renameSync(join(root, 'b.txt'), join(root, 'c.txt'));
    const entries = entriesOf(root);
    // git sees the staged A→B; the worktree half (B gone, C untracked) is two independent facts.
    assert.equal(byPath(entries, 'c.txt').objectId, `${NEW_IMAGE_ID_PREFIX}c.txt`);
    const fromA = entries.filter((e) => e.objectId === `${PRE_IMAGE_ID_PREFIX}a.txt`);
    assert.equal(fromA.length, 1, 'the tracked object is still ONE entry');
    assert.equal(fromA[0].kind, 'deleted', 'its worktree image is gone, and nothing reconstructs where it went');
  });

  it('ambiguous identical rename candidates are simply counted, never resolved', () => {
    const root = makeRepo({ 'src.txt': 'identical\n' });
    renameSync(join(root, 'src.txt'), join(root, 'one.txt'));
    writeFileSync(join(root, 'two.txt'), 'identical\n');
    const entries = entriesOf(root);
    // The old matcher REFUSED the whole enumeration here, because identical content made the identity
    // undecidable. With no identity claimed there is nothing to decide and nothing to refuse.
    assert.equal(byPath(entries, 'src.txt').kind, 'deleted');
    assert.equal(byPath(entries, 'one.txt').kind, 'new');
    assert.equal(byPath(entries, 'two.txt').kind, 'new');
    assert.equal(computeNumerator(entries).ok, true, 'an ordinary refactor is never refused for resembling itself');
  });

  it('a rename followed by content edits is counted as a deletion plus a creation (the stated limit)', () => {
    const root = makeRepo({ 'old.txt': 'original content\n' });
    renameSync(join(root, 'old.txt'), join(root, 'new.txt'));
    writeFileSync(join(root, 'new.txt'), 'original content, edited\n');
    const entries = entriesOf(root);
    assert.equal(entries.filter((e) => e.kind === 'renamed').length, 0);
    assert.equal(byPath(entries, 'old.txt').kind, 'deleted');
    assert.equal(byPath(entries, 'new.txt').kind, 'new');
  });

  it('a STAGED rename a→b beside a re-created a counts TWO objects and refuses nothing', () => {
    const root = makeRepo({ 'a.txt': 'original content\n' });
    sh(['mv', 'a.txt', 'b.txt'], root);
    writeFileSync(join(root, 'a.txt'), 'fresh\n');
    const entries = entriesOf(root);
    assert.equal(byPath(entries, 'b.txt').objectId, `${PRE_IMAGE_ID_PREFIX}a.txt`);
    assert.equal(byPath(entries, 'a.txt').objectId, `${NEW_IMAGE_ID_PREFIX}a.txt`);
    const numerator = computeNumerator(entries);
    assert.equal(numerator.ok, true, numerator.reason);
    assert.equal(numerator.numeratorBytes, 17 + 6);
  });

  // The production form of the case above — a delegate cannot `git mv`, so it arrives as a MODIFIED
  // source path beside an untracked destination, which is byte-identical to copy-then-edit. The
  // limit is pinned rather than papered over, error direction included.
  // The emission is 2O whatever the re-created file weighs, while the recognised reading is O+F —
  // so the sign of the error CROSSES at F = O. Both sides are pinned, because a limit stated with
  // one direction it does not always have is worse than a limit stated as indeterminate.
  it('a FILESYSTEM rename a→b beside a re-created SMALLER a over-counts (F < O)', () => {
    const root = makeRepo({ 'a.txt': 'original content\n' }); // O = 17
    renameSync(join(root, 'a.txt'), join(root, 'b.txt'));
    writeFileSync(join(root, 'a.txt'), 'fresh\n'); // F = 6
    const entries = entriesOf(root);
    assert.equal(byPath(entries, 'a.txt').kind, 'modified', 'git reports a modified a.txt plus an untracked b.txt — indistinguishable from copy-then-edit');
    assert.equal(byPath(entries, 'a.txt').objectId, `${PRE_IMAGE_ID_PREFIX}a.txt`);
    assert.equal(byPath(entries, 'b.txt').kind, 'new');
    assert.equal(byPath(entries, 'b.txt').objectId, `${NEW_IMAGE_ID_PREFIX}b.txt`);
    const numerator = computeNumerator(entries);
    assert.equal(numerator.ok, true, numerator.reason);
    assert.equal(numerator.numeratorBytes, 17 + 17);
    assert.ok(17 + 17 > 17 + 6, 'with F < O the emitted 2O sits ABOVE the recognised O+F — over-counted');
  });

  it('a FILESYSTEM rename a→b beside a re-created LARGER a UNDER-counts (F > O)', () => {
    const root = makeRepo({ 'a.txt': 'original content\n' }); // O = 17
    renameSync(join(root, 'a.txt'), join(root, 'b.txt'));
    writeFileSync(join(root, 'a.txt'), 'a much longer replacement body for the same path\n');
    const F = statSync(join(root, 'a.txt')).size; // read, not assumed — the fixture must really be F > O
    assert.ok(F > 17, 'this fixture only pins what it claims while the re-created file is LARGER');
    const entries = entriesOf(root);
    const numerator = computeNumerator(entries);
    assert.equal(numerator.ok, true, numerator.reason);
    assert.equal(numerator.numeratorBytes, 17 + 17, 'the emission is 2O — it never sees the re-created file at all, because the modified entry counts its PRE-image');
    assert.ok(numerator.numeratorBytes < 17 + F, 'with F > O the emitted 2O sits BELOW the recognised O+F — the metric reads PESSIMISTIC here, and the header must not claim otherwise');
  });
});

describe('exec-producer — what the subtracted matcher no longer has to get right', () => {
  it('a symlink is never hashed THROUGH: it cannot impersonate a deleted regular file', () => {
    const root = makeRepo({ 'payload.txt': 'carried bytes\n', 'gone.txt': 'carried bytes\n' });
    unlinkSync(join(root, 'gone.txt'));
    symlinkSync('payload.txt', join(root, 'pointer'));
    const entries = entriesOf(root);
    // Nothing hashes an untracked path at all now, so the whole class is closed by construction —
    // including the untracked symlink to a FIFO, which `git ls-files --others` lists and which
    // `git hash-object` opens and BLOCKS on forever inside a spawnSync no timer can interrupt.
    assert.equal(byPath(entries, 'gone.txt').kind, 'deleted');
    assert.equal(byPath(entries, 'pointer').kind, 'symlink');
    assert.equal(byPath(entries, 'pointer').objectId, `${NEW_IMAGE_ID_PREFIX}pointer`);
    assert.equal(entries.filter((e) => e.kind === 'renamed').length, 0);
  });

  it('a symlink candidate never makes a REGULAR rename ambiguous — there are no candidates', () => {
    const root = makeRepo({ 'moved.txt': 'unique bytes\n', 'target.txt': 'unique bytes\n' });
    renameSync(join(root, 'moved.txt'), join(root, 'landed.txt'));
    symlinkSync('target.txt', join(root, 'decoy'));
    const entries = entriesOf(root);
    assert.equal(entries.filter((e) => e.kind === 'renamed').length, 0);
    assert.equal(byPath(entries, 'moved.txt').kind, 'deleted');
    assert.equal(byPath(entries, 'landed.txt').kind, 'new');
    assert.equal(byPath(entries, 'decoy').kind, 'symlink');
  });

  it('a moved symlink is NOT matched on the LINK TEXT — link identity is never reconstructed', () => {
    const root = makeRepo();
    symlinkSync('base.txt', join(root, 'old-link'));
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'link'], root);
    renameSync(join(root, 'old-link'), join(root, 'new-link'));
    const entries = entriesOf(root);
    // TYPE still beats STATUS for the size rule: both halves are `symlink` and size-only. What is
    // gone is the claim that they are one object.
    assert.equal(byPath(entries, 'old-link').kind, 'symlink');
    assert.equal(byPath(entries, 'old-link').objectId, `${PRE_IMAGE_ID_PREFIX}old-link`);
    assert.equal(byPath(entries, 'new-link').kind, 'symlink');
    assert.equal(byPath(entries, 'new-link').objectId, `${NEW_IMAGE_ID_PREFIX}new-link`);
  });

  it('two eligible SYMLINK candidates are two created objects, never AMBIGUOUS', () => {
    const root = makeRepo();
    symlinkSync('base.txt', join(root, 'old-link'));
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'link'], root);
    unlinkSync(join(root, 'old-link'));
    symlinkSync('base.txt', join(root, 'one-link'));
    symlinkSync('base.txt', join(root, 'two-link'));
    const entries = entriesOf(root);
    assert.equal(byPath(entries, 'one-link').objectId, `${NEW_IMAGE_ID_PREFIX}one-link`);
    assert.equal(byPath(entries, 'two-link').objectId, `${NEW_IMAGE_ID_PREFIX}two-link`);
    assert.equal(computeNumerator(entries).ok, true, 'identical link targets no longer refuse anything');
  });
});

describe('exec-producer — the source image is the LAST layer that held it', () => {
  it('a staged add moved in the filesystem counts its INDEX image and the creation separately', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'added.txt'), 'fresh bytes\n');
    sh(['add', 'added.txt'], root);
    renameSync(join(root, 'added.txt'), join(root, 'moved.txt'));
    const entries = entriesOf(root);
    // The tracked object is transient (index image, gone from the worktree); the destination is its
    // own creation. Two objects, each one git can prove.
    assert.deepEqual(byPath(entries, 'added.txt'), {
      kind: 'new', path: 'added.txt', objectId: `${NEW_IMAGE_ID_PREFIX}added.txt`, postImageBytes: 12,
    });
    assert.deepEqual(byPath(entries, 'moved.txt'), {
      kind: 'new', path: 'moved.txt', objectId: `${NEW_IMAGE_ID_PREFIX}moved.txt`, postImageBytes: 12,
    });
  });

  it('a staged delete whose bytes reappear untracked elsewhere is a deletion plus a creation', () => {
    const root = makeRepo({ 'tracked.txt': 'moved away\n' });
    sh(['rm', '-q', '--cached', 'tracked.txt'], root);
    renameSync(join(root, 'tracked.txt'), join(root, 'elsewhere.txt'));
    const entries = entriesOf(root);
    assert.equal(entries.filter((e) => e.kind === 'renamed').length, 0);
    assert.deepEqual(byPath(entries, 'tracked.txt'), {
      kind: 'deleted', path: 'tracked.txt', objectId: `${PRE_IMAGE_ID_PREFIX}tracked.txt`, preImageBytes: 11,
    });
    assert.deepEqual(byPath(entries, 'elsewhere.txt'), {
      kind: 'new', path: 'elsewhere.txt', objectId: `${NEW_IMAGE_ID_PREFIX}elsewhere.txt`, postImageBytes: 11,
    });
  });

  it('a transient object with no candidate stays transient — the INDEX image is counted once', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'transient.txt'), 'transient\n');
    sh(['add', 'transient.txt'], root);
    unlinkSync(join(root, 'transient.txt'));
    const entry = byPath(entriesOf(root), 'transient.txt');
    assert.deepEqual(entry, { kind: 'new', path: 'transient.txt', objectId: `${NEW_IMAGE_ID_PREFIX}transient.txt`, postImageBytes: 10 });
  });
});

describe('exec-producer — object ids are read at full width', () => {
  it('nothing is matched in a SHA-256 repository either, and both objects still size correctly', () => {
    const root = join(TMP, `sha256-${seq += 1}`);
    mkdirSync(root, { recursive: true });
    const init = spawnSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', '.'], { cwd: root, encoding: 'utf8' });
    if (init.status !== 0) return; // this git was built without SHA-256 — the arm is unreachable here
    sh(['config', 'user.email', 'coder-tools@proton.me'], root);
    sh(['config', 'user.name', 'coder-tool'], root);
    writeFileSync(join(root, 'old.txt'), 'content here\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'init'], root);
    renameSync(join(root, 'old.txt'), join(root, 'new.txt'));
    const entries = entriesOf(root);
    // `--no-abbrev` is what makes this work: the pre-image SIZE is read with `cat-file -s <oid>`, and
    // the raw format would otherwise hand it a 40-hex truncation of a 64-hex name.
    assert.deepEqual(byPath(entries, 'old.txt'), {
      kind: 'deleted', path: 'old.txt', objectId: `${PRE_IMAGE_ID_PREFIX}old.txt`, preImageBytes: 13,
    });
    assert.equal(byPath(entries, 'new.txt').postImageBytes, 13);
  });
});

describe('exec-producer — paths are BYTES', () => {
  // \xfe and \xff are both invalid UTF-8 and both decode to U+FFFD, so these two DISTINCT paths
  // arrive as one string — and therefore as one objectId — unless the reader works on bytes.
  const BAD_A = Buffer.from([0x78, 0xfe, 0x2e, 0x74, 0x78, 0x74]); // x\xfe.txt
  const BAD_B = Buffer.from([0x78, 0xff, 0x2e, 0x74, 0x78, 0x74]); // x\xff.txt
  // A name whose bytes are not valid UTF-8 cannot be composed with path.join — it only exists as a
  // Buffer, which is exactly why a reader that decodes before it compares loses it.
  const rawPath = (root, nameBytes) => Buffer.concat([Buffer.from(`${root}/`, 'utf8'), nameBytes]);

  it('an untracked path that does not survive a byte round-trip REFUSES the enumeration', () => {
    const root = makeRepo();
    writeFileSync(rawPath(root, BAD_A), 'alpha\n');
    writeFileSync(rawPath(root, BAD_B), 'beta\n');
    const reason = refusalOf(root);
    assert.match(reason, /not valid UTF-8/);
    assert.match(reason, /untracked section/);
  });

  it('a TRACKED path that does not survive a byte round-trip REFUSES the enumeration', () => {
    const root = makeRepo();
    writeFileSync(rawPath(root, BAD_A), 'alpha\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'odd bytes'], root);
    writeFileSync(rawPath(root, BAD_A), 'edited\n');
    const reason = refusalOf(root);
    assert.match(reason, /not valid UTF-8/);
    assert.match(reason, /change set/);
  });

  // git does not emit either shape on demand, so the reader's fail-closed arms are pinned directly.
  it('a numstat record short of its two separators REFUSES rather than being skipped', () => {
    const result = parseNumstatMarkers(Buffer.from('-\tonly-one-tab\0', 'utf8'), 'the staged binary markers');
    assert.equal(result.ok, false);
    assert.match(result.reason, /fewer than the two separators/);
    assert.match(result.reason, /staged binary markers/);
  });

  it('a numstat RENAME record missing its path segments REFUSES rather than being skipped', () => {
    // The empty path field promises two NUL-terminated names; only one follows.
    const result = parseNumstatMarkers(Buffer.from('-\t-\t\0from.bin\0', 'utf8'), 'the unstaged binary markers');
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing the path segments/);
  });

  it('a well-formed numstat rename record names BOTH sides as binary', () => {
    const result = parseNumstatMarkers(Buffer.from('-\t-\t\0from.bin\0to.bin\0', 'utf8'), 'the staged binary markers');
    assert.equal(result.ok, true);
    assert.deepEqual([...result.names].sort(), ['from.bin', 'to.bin']);
  });

  it('a binary path carrying a literal TAB keeps its binary marker', () => {
    const root = makeRepo();
    const tabbed = 'has\ttab.bin';
    writeFileSync(join(root, tabbed), Buffer.from([0, 1, 2, 3, 0]));
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'tabbed'], root);
    writeFileSync(join(root, tabbed), Buffer.from([0, 9]));
    const entry = byPath(entriesOf(root), tabbed);
    assert.equal(entry.kind, 'binary', 'numstat prints added TAB deleted TAB path — splitting on every tab drops a tab-bearing name and loses the marker');
    assert.equal(entry.sizeBytes, 5, 'a modified binary contributes its PRE-image size, not a post-image byte count');
  });
});

describe('exec-producer — attributes cannot mis-key what is never keyed', () => {
  const withAttributes = (attributes) => {
    const root = makeRepo();
    writeFileSync(join(root, '.gitattributes'), attributes);
    writeFileSync(join(root, 'src.txt'), 'one\r\ntwo\r\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'attrs'], root);
    return root;
  };

  it('no rename is found by the source-attribute pass — that pass went with the matcher', () => {
    const root = withAttributes('*.txt text\n*.bin -text\n');
    renameSync(join(root, 'src.txt'), join(root, 'dest.bin'));
    const entries = entriesOf(root);
    assert.equal(entries.filter((e) => e.kind === 'renamed').length, 0);
    assert.equal(byPath(entries, 'src.txt').kind, 'deleted');
    assert.equal(byPath(entries, 'dest.bin').kind, 'new');
  });

  it('no candidate contests a path the first pass already took — there are no passes', () => {
    const root = withAttributes('*.txt text\n*.bin -text\n');
    // The shape that used to be undecidable: `raw.bin` stores the CRLF bytes verbatim, `src.txt`
    // stores the same content LF-normalised, and one untracked `dest.bin` resembles BOTH depending on
    // whose attributes you ask. Three objects, three facts, nothing to arbitrate.
    writeFileSync(join(root, 'raw.bin'), 'one\r\ntwo\r\n');
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'raw'], root);
    unlinkSync(join(root, 'raw.bin'));
    renameSync(join(root, 'src.txt'), join(root, 'dest.bin'));
    const entries = entriesOf(root);
    assert.equal(byPath(entries, 'raw.bin').kind, 'deleted');
    assert.equal(byPath(entries, 'src.txt').kind, 'deleted');
    assert.equal(byPath(entries, 'dest.bin').kind, 'new');
    assert.equal(computeNumerator(entries).ok, true);
  });

  it('an undecodable path outranks a findable rename — fail closed, never partial', () => {
    const root = withAttributes('*.txt text\n*.bin -text\n');
    renameSync(join(root, 'src.txt'), join(root, 'dest.bin'));
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`, 'utf8'), Buffer.from([0x79, 0xff, 0x2e, 0x62, 0x69, 0x6e])]), 'zz\n');
    const reason = refusalOf(root);
    assert.match(reason, /not valid UTF-8/, 'a tree the reader cannot name is refused whole — never enumerated up to the bad path');
  });
});

describe('exec-producer — both entry points answer, never throw', () => {
  it('computeReturnedDiff inherits the enumeration REFUSAL, not just the shared preconditions', () => {
    const root = makeRepo();
    writeFileSync(Buffer.concat([Buffer.from(`${root}/`, 'utf8'), Buffer.from([0x78, 0xff, 0x2e, 0x74, 0x78, 0x74])]), 'alpha\n');
    assert.equal(enumerateReturnedObjects(root).ok, false);
    const diff = computeReturnedDiff(root);
    assert.equal(diff.ok, false, 'one entry point may not answer for a tree the other rejects');
    assert.match(diff.reason, /not valid UTF-8/);
  });

  it('a THROWING lstat mirrors the payload only for ENOENT — the path is non-regular at zero bytes', () => {
    const root = makeRepo();
    const entries = entriesOf(root, {
      untracked: () => ['vanished.txt'],
      lstat: () => { const err = new Error('gone'); err.code = 'ENOENT'; throw err; },
    });
    assert.deepEqual(byPath(entries, 'vanished.txt'), {
      kind: 'non-regular', path: 'vanished.txt', objectId: `${NEW_IMAGE_ID_PREFIX}vanished.txt`, sizeBytes: 0,
    }, 'a path that vanished between ls-files and the stat is genuinely absent, exactly as the payload records it');
  });

  it('an UNREADABLE path refuses the whole enumeration — a failed probe is not an absent one', () => {
    const root = makeRepo();
    const reason = refusalOf(root, {
      untracked: () => ['locked.txt'],
      lstat: () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; },
    });
    assert.match(reason, /locked\.txt/);
    assert.match(reason, /EACCES/);
    assert.match(reason, /FAILED probe/);
  });

  it('a TRACKED object whose worktree image is unreadable names the probe, not the size', () => {
    // The size lookup fails first and would otherwise answer "cannot establish the size", losing the
    // path and the errno — the probe failure has to outrank it whichever loop hit it.
    const root = makeRepo();
    symlinkSync('base.txt', join(root, 'link'));
    sh(['add', 'link'], root);
    unlinkSync(join(root, 'link'));
    symlinkSync('other.txt', join(root, 'link'));
    const reason = refusalOf(root, {
      lstat: (p) => {
        if (!String(p).endsWith('link')) return undefined;
        const err = new Error('denied');
        err.code = 'EACCES';
        throw err;
      },
    });
    assert.match(reason, /EACCES/);
    assert.match(reason, /FAILED probe/);
    assert.doesNotMatch(reason, /cannot establish the size/);
  });

  it('computeReturnedDiff REFUSES by name when the canonical payload cannot be read', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root reads through mode 000
    const root = makeRepo();
    writeFileSync(join(root, 'unreadable.txt'), 'secret\n');
    chmodSync(join(root, 'unreadable.txt'), 0o000);
    const result = computeReturnedDiff(root);
    chmodSync(join(root, 'unreadable.txt'), 0o600);
    assert.equal(result.ok, false, 'the payload builder reads untracked file bytes unguarded — the refusal contract must hold anyway');
    assert.match(result.reason, /canonical payload/);
  });

});

describe('exec-producer — the status × type precedence matrix', () => {
  it('a symlink contributes size only in its created, deleted and modified variants', () => {
    const created = makeRepo();
    symlinkSync('base.txt', join(created, 'link'));
    const c = byPath(entriesOf(created), 'link');
    assert.equal(c.kind, 'symlink');
    assert.equal(c.objectId, `${NEW_IMAGE_ID_PREFIX}link`);
    assert.equal(Object.hasOwn(c, 'sizeBytes'), true);

    const seeded = makeRepo();
    symlinkSync('base.txt', join(seeded, 'link'));
    sh(['add', '-A'], seeded);
    sh(['commit', '-q', '-m', 'link'], seeded);
    unlinkSync(join(seeded, 'link'));
    const d = byPath(entriesOf(seeded), 'link');
    assert.equal(d.kind, 'symlink');
    assert.equal(d.objectId, `${PRE_IMAGE_ID_PREFIX}link`);

    symlinkSync('other.txt', join(seeded, 'link'));
    const m = byPath(entriesOf(seeded), 'link');
    assert.equal(m.kind, 'symlink');
    assert.equal(m.objectId, `${PRE_IMAGE_ID_PREFIX}link`);
  });

  it('a binary file contributes size only in its created, deleted and modified variants', () => {
    const created = makeRepo();
    writeFileSync(join(created, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
    const c = byPath(entriesOf(created), 'blob.bin');
    assert.equal(c.kind, 'binary');
    assert.equal(c.sizeBytes, 5);
    assert.equal(c.objectId, `${NEW_IMAGE_ID_PREFIX}blob.bin`);

    const seeded = makeRepo();
    writeFileSync(join(seeded, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
    sh(['add', '-A'], seeded);
    sh(['commit', '-q', '-m', 'bin'], seeded);
    writeFileSync(join(seeded, 'blob.bin'), Buffer.from([0, 9]));
    const m = byPath(entriesOf(seeded), 'blob.bin');
    assert.equal(m.kind, 'binary');
    assert.equal(m.objectId, `${PRE_IMAGE_ID_PREFIX}blob.bin`);
    assert.equal(m.sizeBytes, 5, 'a modified binary contributes its PRE-image size');

    unlinkSync(join(seeded, 'blob.bin'));
    const d = byPath(entriesOf(seeded), 'blob.bin');
    assert.equal(d.kind, 'binary');
    assert.equal(d.sizeBytes, 5);
  });

  it('a submodule contributes ZERO bytes in its created, deleted and modified variants', () => {
    const inner = makeRepo();
    const root = makeRepo();
    const add = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], { cwd: root, encoding: 'utf8' });
    assert.equal(add.status, 0, `submodule add failed: ${add.stderr}`);
    const created = byPath(entriesOf(root), 'sub');
    assert.equal(created.kind, 'submodule');
    assert.equal(created.sizeBytes, 0);
    assert.equal(created.objectId, `${NEW_IMAGE_ID_PREFIX}sub`);

    sh(['commit', '-q', '-m', 'sub'], root);
    writeFileSync(join(inner, 'more.txt'), 'more\n');
    sh(['add', '-A'], inner);
    sh(['commit', '-q', '-m', 'more'], inner);
    sh(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--remote', '--merge', 'sub'], root);
    const modified = byPath(entriesOf(root), 'sub');
    assert.equal(modified.kind, 'submodule');
    assert.equal(modified.sizeBytes, 0);
    assert.equal(modified.objectId, `${PRE_IMAGE_ID_PREFIX}sub`);

    sh(['rm', '-q', '--cached', 'sub'], root);
    const deleted = byPath(entriesOf(root), 'sub');
    assert.equal(deleted.kind, 'submodule');
    assert.equal(deleted.sizeBytes, 0);
    assert.equal(deleted.objectId, `${PRE_IMAGE_ID_PREFIX}sub`);
  });

  it('a TYPE CHANGE into a gitlink still counts the image it replaced', () => {
    // The emitted kind stays `submodule` (TYPE beats STATUS, D6) — but the counted image is the HEAD
    // blob of the regular file, and paying it the submodule's deliberate zero would drop the object's
    // bytes out of the numerator entirely.
    const inner = makeRepo();
    const root = makeRepo({ 'sub': 'was a regular file\n' });
    sh(['rm', '-q', '--cached', 'sub'], root); // the INDEX entry must go too, or submodule add refuses
    unlinkSync(join(root, 'sub'));
    const add = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], { cwd: root, encoding: 'utf8' });
    assert.equal(add.status, 0, `submodule add failed: ${add.stderr}`);
    const entry = byPath(entriesOf(root), 'sub');
    assert.equal(entry.kind, 'submodule');
    assert.equal(entry.objectId, `${PRE_IMAGE_ID_PREFIX}sub`);
    assert.equal(entry.sizeBytes, 19, 'the pre-image was a 19-byte regular file, not a gitlink — zero belongs only to a counted image that IS one');
  });

  it('a symlink replaced by a gitlink counts the link text it replaced', () => {
    const inner = makeRepo();
    const root = makeRepo();
    symlinkSync('base.txt', join(root, 'sub'));
    sh(['add', '-A'], root);
    sh(['commit', '-q', '-m', 'link'], root);
    sh(['rm', '-q', '--cached', 'sub'], root);
    unlinkSync(join(root, 'sub'));
    const add = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], { cwd: root, encoding: 'utf8' });
    assert.equal(add.status, 0, `submodule add failed: ${add.stderr}`);
    const entry = byPath(entriesOf(root), 'sub');
    assert.equal(entry.kind, 'submodule');
    assert.equal(entry.sizeBytes, 8, 'the counted image is the symlink blob — the link text "base.txt"');
  });

  it('a gitlink replaced by a regular file keeps the deliberate ZERO — the counted image IS the gitlink', () => {
    const inner = makeRepo();
    const root = makeRepo();
    const add = spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'], { cwd: root, encoding: 'utf8' });
    assert.equal(add.status, 0, `submodule add failed: ${add.stderr}`);
    sh(['commit', '-q', '-m', 'sub'], root);
    sh(['rm', '-q', '--cached', 'sub'], root);
    rmSync(join(root, 'sub'), { recursive: true, force: true });
    writeFileSync(join(root, 'sub'), 'now an ordinary file\n');
    const entry = byPath(entriesOf(root), 'sub');
    assert.equal(entry.kind, 'submodule');
    assert.equal(entry.sizeBytes, 0, 'the pre-image was a gitlink, and a gitlink move costs this repository no bytes');
  });

  it('an unstatable untracked path is non-regular at zero bytes (the reachable arm, injected)', () => {
    const root = makeRepo();
    const entries = entriesOf(root, {
      untracked: () => ['vanished.txt'],
      lstat: () => null,
    });
    const entry = byPath(entries, 'vanished.txt');
    assert.deepEqual(entry, { kind: 'non-regular', path: 'vanished.txt', objectId: `${NEW_IMAGE_ID_PREFIX}vanished.txt`, sizeBytes: 0 });
  });

  it('a never-committable class is excluded ENTIRELY — no component, no marker', () => {
    const root = makeRepo();
    const fifoStat = {
      isCharacterDevice: () => false, isBlockDevice: () => false, isFIFO: () => true, isSocket: () => false,
      isSymbolicLink: () => false, isFile: () => false, size: 0,
    };
    const entries = entriesOf(root, { untracked: () => ['pipe'], lstat: () => fifoStat });
    assert.equal(byPath(entries, 'pipe'), undefined);
  });
});

describe('exec-producer — no silent zero', () => {
  it('an unknown CREATED size REFUSES by name instead of counting zero', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'fresh.txt'), 'fresh\n');
    sh(['add', 'fresh.txt'], root);
    writeFileSync(join(root, 'fresh.txt'), 'fresh, edited\n');
    const reason = refusalOf(root, { lstat: (p) => (String(p).endsWith('fresh.txt') ? null : undefined) });
    assert.match(reason, /fresh\.txt/);
    assert.match(reason, /cannot establish the size/);
  });

  it('an unknown SPECIAL-TYPE size REFUSES by name — only submodule keeps its deliberate zero', () => {
    const root = makeRepo();
    symlinkSync('base.txt', join(root, 'link'));
    sh(['add', 'link'], root);
    unlinkSync(join(root, 'link'));
    symlinkSync('other.txt', join(root, 'link'));
    const reason = refusalOf(root, { lstat: (p) => (String(p).endsWith('link') ? null : undefined) });
    assert.match(reason, /link/);
    assert.match(reason, /cannot establish the size of the symlink/);
  });
});

describe('exec-producer — the domain is the fingerprint domain', () => {
  it('an untracked-not-ignored file is enumerated, and an ignored one is not', () => {
    const root = makeRepo({ '.gitignore': 'ignored.txt\n' });
    writeFileSync(join(root, 'untracked.txt'), 'abc\n');
    writeFileSync(join(root, 'ignored.txt'), 'nope\n');
    const entries = entriesOf(root);
    assert.equal(byPath(entries, 'untracked.txt').postImageBytes, 4);
    assert.equal(byPath(entries, 'ignored.txt'), undefined);
  });

  it('the diff bytes ARE the canonical fingerprint payload', () => {
    const root = makeRepo({ 'target.txt': 'aaaa\n' });
    writeFileSync(join(root, 'target.txt'), 'b\n');
    writeFileSync(join(root, 'extra.txt'), 'new\n');
    const diff = computeReturnedDiff(root);
    assert.equal(diff.ok, true);
    assert.ok(diff.diff.equals(computeFingerprintPayload(root)));
  });

  it('NO component carries a ranges key, and none is enumerated or gate-output', () => {
    const root = makeRepo({ 'target.txt': 'aaaa\n' });
    writeFileSync(join(root, 'target.txt'), 'b\n');
    writeFileSync(join(root, 'created.txt'), 'x\n');
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1]));
    symlinkSync('base.txt', join(root, 'link'));
    for (const entry of entriesOf(root)) {
      assert.equal(Object.hasOwn(entry, 'ranges'), false, `${entry.path} must not carry ranges`);
      assert.notEqual(entry.kind, 'enumerated');
      assert.notEqual(entry.kind, 'gate-output');
    }
  });

  it('the produced entries feed computeNumerator without refusal and their sum IS the numerator', () => {
    const root = makeRepo({ 'target.txt': 'aaaa\n', 'gone.txt': 'seven!\n' });
    writeFileSync(join(root, 'target.txt'), 'b\n');
    unlinkSync(join(root, 'gone.txt'));
    writeFileSync(join(root, 'created.txt'), 'hello\n');
    const entries = entriesOf(root);
    const numerator = computeNumerator(entries);
    assert.equal(numerator.ok, true, numerator.reason);
    assert.equal(numerator.numeratorBytes, numerator.components.reduce((sum, c) => sum + c.bytes, 0));
    assert.equal(numerator.numeratorBytes, 5 + 7 + 6);
  });
});

describe('exec-producer — the integration bundle', () => {
  it('round-trips through parseIntegrationBundle to the same two parts', () => {
    const diff = Buffer.from('diff bytes\n');
    const report = Buffer.from('report bytes\n');
    const assembled = assembleIntegrationBundle(diff, report);
    const parsed = parseIntegrationBundle(assembled.bundle);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.diff.equals(diff));
    assert.ok(parsed.report.equals(report));
    assert.equal(assembled.bundleLength, expectedBundleLength(diff.length, report.length));
    assert.equal(assembled.bundleDigest, createHash('sha256').update(assembled.bundle).digest('hex'));
  });
});

describe('exec-producer — fail closed', () => {
  it('refuses outside a git work tree', () => {
    const dir = join(TMP, `bare-${seq += 1}`);
    mkdirSync(dir, { recursive: true });
    assert.match(enumerateReturnedObjects(dir).reason, /not inside a git work tree/);
    assert.match(computeReturnedDiff(dir).reason, /not inside a git work tree/);
  });

  it('BOTH entry points refuse on an unborn branch — no pre-image to attribute bytes against', () => {
    const root = join(TMP, `unborn-${seq += 1}`);
    mkdirSync(root, { recursive: true });
    sh(['init', '-q', '-b', 'main'], root);
    writeFileSync(join(root, 'a.txt'), 'x\n');
    assert.match(enumerateReturnedObjects(root).reason, /unborn/);
    assert.match(computeReturnedDiff(root).reason, /unborn/);
  });
});

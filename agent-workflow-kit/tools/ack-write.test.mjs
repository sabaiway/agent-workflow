// ack-write.test.mjs — the consent-gated ack-store writer (AD-055 Part I). Pins the family writer
// discipline: preview-then-mutate, deployment-gated (refuses absent docs/ai), create-if-absent,
// merge-preserve every existing key, symlink / non-regular refusal, malformed-JSON fail-closed,
// atomic write, and the exact `{"sandboxLaneAck": <fp>}` merge.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, applyCommand, planAckWrite } from './ack-write.mjs';

const FP = 'abcdef0123456789'; // a valid recipeFingerprint shape (16 lowercase hex)

const makeDeployed = () => {
  const root = mkdtempSync(join(tmpdir(), 'ack-write-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  return root;
};
const acksPath = (root) => join(root, 'docs', 'ai', 'acks.json');
const capture = () => {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { log: push, errlog: push, out: () => lines.join('\n') };
};

describe('ack-write — the consent-gated ack store writer', () => {
  it('the DEFAULT is a preview — it writes nothing and prints the exact --apply command', () => {
    const root = makeDeployed();
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root], cap);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 0, cap.out());
    assert.match(cap.out(), /DRY RUN/);
    assert.ok(cap.out().includes(applyCommand(root, FP)), 'the preview prints the exact --apply command verbatim');
    // Independent of applyCommand() (which the code ALSO calls to print) — pin the literal shape so a
    // regression INSIDE applyCommand (dropped ` --apply`, wrong flag, non-absolute path) is caught:
    // the preview must emit an absolute-path node command carrying --fingerprint <FP> and ENDING in --apply.
    const toApply = cap.out().split('\n').find((l) => l.includes('to apply:'));
    assert.ok(toApply, 'the preview prints a "to apply:" line');
    assert.match(toApply, /node \/.*\/ack-write\.mjs --fingerprint abcdef0123456789 --cwd \/.* --apply$/, 'the to-apply command is the absolute-path --apply form (literal pin, decoupled from applyCommand)');
  });

  it('a dry-run never creates the store file', () => {
    const root = makeDeployed();
    main(['--fingerprint', FP, '--cwd', root], capture());
    const created = existsSync(acksPath(root));
    rmSync(root, { recursive: true, force: true });
    assert.equal(created, false);
  });

  it('--apply creates docs/ai/acks.json with EXACTLY {"sandboxLaneAck": fp}', () => {
    const root = makeDeployed();
    const code = main(['--fingerprint', FP, '--cwd', root, '--apply'], capture());
    const parsed = JSON.parse(readFileSync(acksPath(root), 'utf8'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 0);
    assert.deepEqual(parsed, { sandboxLaneAck: FP });
  });

  it('--apply MERGE-PRESERVES every existing key (a _README + a future sibling ack)', () => {
    const root = makeDeployed();
    writeFileSync(acksPath(root), JSON.stringify({ _README: 'hi', otherAck: 'x', sandboxLaneAck: 'stale00000000000' }));
    main(['--fingerprint', FP, '--cwd', root, '--apply'], capture());
    const parsed = JSON.parse(readFileSync(acksPath(root), 'utf8'));
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(parsed, { _README: 'hi', otherAck: 'x', sandboxLaneAck: FP });
  });

  it('REFUSES an absent docs/ai deployment with a named recovery pointer (exit 1, nothing created)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack-write-nodep-'));
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root, '--apply'], cap);
    const madeDocs = existsSync(join(root, 'docs'));
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.match(cap.out(), /docs\/ai is absent/);
    assert.match(cap.out(), /init|bootstrap/);
    assert.equal(madeDocs, false, 'nothing is created in a non-deployment');
  });

  it('even a DRY RUN refuses an absent deployment (never previews a write it cannot do)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack-write-nodep2-'));
    const code = main(['--fingerprint', FP, '--cwd', root], capture());
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
  });

  it('refuses a SYMLINKED acks.json target — the link target stays untouched', () => {
    const root = makeDeployed();
    writeFileSync(join(root, 'elsewhere.json'), '{}');
    symlinkSync(join(root, 'elsewhere.json'), acksPath(root));
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root, '--apply'], cap);
    const target = readFileSync(join(root, 'elsewhere.json'), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.match(cap.out(), /symlink/);
    assert.equal(target, '{}', 'the link target is never written through');
  });

  it('refuses a NON-REGULAR acks.json target (a directory at the path)', () => {
    const root = makeDeployed();
    mkdirSync(acksPath(root));
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root, '--apply'], cap);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.match(cap.out(), /not a regular file/);
  });

  it('fail-closed on a MALFORMED existing acks.json — never overwrites an unparseable store', () => {
    const root = makeDeployed();
    writeFileSync(acksPath(root), '{ not json');
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root, '--apply'], cap);
    const onDisk = readFileSync(acksPath(root), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.match(cap.out(), /not valid JSON/);
    assert.equal(onDisk, '{ not json', 'the malformed store is left byte-untouched');
  });

  it('fail-closed on a non-object root (a JSON array)', () => {
    const root = makeDeployed();
    writeFileSync(acksPath(root), '[]');
    const code = main(['--fingerprint', FP, '--cwd', root, '--apply'], capture());
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
  });

  it('rejects a non-fingerprint value as a usage error (exit 2) — nothing written', () => {
    const root = makeDeployed();
    const bads = ['not-hex-value16!', 'ABCDEF0123456789', 'abcdef012345678', 'abcdef01234567890', ''];
    const codes = bads.map((bad) => main(['--fingerprint', bad, '--cwd', root, '--apply'], capture()));
    const created = existsSync(acksPath(root));
    rmSync(root, { recursive: true, force: true });
    for (let i = 0; i < bads.length; i += 1) assert.equal(codes[i], 2, `${JSON.stringify(bads[i])} is a usage error`);
    assert.equal(created, false);
  });

  it('leaves NO temp file behind after a successful apply, and re-apply is byte-stable (atomic + idempotent)', () => {
    const root = makeDeployed();
    main(['--fingerprint', FP, '--cwd', root, '--apply'], capture());
    const first = readFileSync(acksPath(root), 'utf8');
    const leftovers = readdirSync(join(root, 'docs', 'ai')).filter((f) => f.includes('.tmp'));
    main(['--fingerprint', FP, '--cwd', root, '--apply'], capture());
    const second = readFileSync(acksPath(root), 'utf8');
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(leftovers, [], 'no *.tmp left behind');
    assert.equal(second, first, 're-apply is idempotent');
  });

  it('a preview when the fingerprint is ALREADY recorded reports nothing-to-do', () => {
    const root = makeDeployed();
    writeFileSync(acksPath(root), JSON.stringify({ sandboxLaneAck: FP }));
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root], cap);
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 0);
    assert.match(cap.out(), /already records/);
  });

  it('rejects a NON-STRING fingerprint (a coercible single-element array / number) — the guard is type-safe', () => {
    // RegExp.test() coerces, so ['abcdef0123456789'] or a number would otherwise pass and be
    // written as a non-string ack the reader ignores. The typeof guard rejects them before any write.
    const root = makeDeployed();
    const bads = [123, ['abcdef0123456789'], null, undefined, { toString: () => 'abcdef0123456789' }];
    for (const bad of bads) {
      assert.throws(() => planAckWrite({ cwd: root, fingerprint: bad }), /16-char lowercase hex/, `${JSON.stringify(bad)} is rejected`);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('--dry-run and --apply together is a usage error (exit 2)', () => {
    const root = makeDeployed();
    const code = main(['--fingerprint', FP, '--cwd', root, '--dry-run', '--apply'], capture());
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 2);
  });

  it('--help prints usage and exits 0', () => {
    const cap = capture();
    const code = main(['--help'], cap);
    assert.equal(code, 0);
    assert.match(cap.out(), /usage: ack-write/);
  });

  it('an unknown argument is a usage error (exit 2)', () => {
    const cap = capture();
    const code = main(['--bogus'], cap);
    assert.equal(code, 2);
    assert.match(cap.out(), /unknown argument/);
  });

  it('a TOCTOU vanish (lstat saw a regular file, the read then ENOENTs) treats the store as absent', () => {
    // The file exists so preflight's lstat sees a regular file; the injected read then ENOENTs — the
    // reader treats it as absent {} and the preview proceeds (defensive TOCTOU branch).
    const root = makeDeployed();
    writeFileSync(acksPath(root), '{}');
    const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root], { ...cap, readFile: () => enoent() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 0, cap.out());
    assert.match(cap.out(), /DRY RUN/);
  });

  it('a non-ENOENT read error on an existing acks.json is a fail-closed STOP (exit 1)', () => {
    const root = makeDeployed();
    writeFileSync(acksPath(root), '{}');
    const eacces = () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; };
    const cap = capture();
    const code = main(['--fingerprint', FP, '--cwd', root], { ...cap, readFile: () => eacces() });
    rmSync(root, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.match(cap.out(), /cannot read.*refusing to overwrite/);
  });
});

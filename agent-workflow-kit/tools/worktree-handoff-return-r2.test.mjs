// worktree-handoff-return-r2.test.mjs — the round-1 council folds (delegation Plan 3, Phase 3):
// the pre-answer re-attestation on BOTH lanes, the attested-tree numerator (blob bytes from the
// recorded tree, never disk), the one-byte-source delivery parse, the strict raw-diff grammar with
// its fail-closed cat-file protocol, and control-byte/non-UTF-8 path rendering. Its OWN suite: the
// round-0 acceptance suite's bytes are frozen under standing red-proofs and never move (D13).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeProvisionRecordSection } from './worktrees-record.mjs';
import { readFileBytesNoFollow } from './fs-read-nofollow.mjs';
import { main as dispatchMain } from './dispatch.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-handoff-return-r2-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Built programmatically so the SOURCE file carries no raw control byte and no escape ambiguity:
// the name holds a real U+0001; the expected rendering is backslash-u0001 (displayValue's form).
const CTL_NAME = ['weird', String.fromCharCode(1), 'name.txt'].join('');
const CTL_ESCAPED = ['weird', String.fromCharCode(92), 'u0001name.txt'].join('');

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const rung = () => import('./worktree-handoff-return.mjs');
const realGit = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const makeFixture = (name, slug) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'base.txt'), 'base content\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'base'], main);
  const wt = join(TMP, `${name}--${slug}`);
  sh(['worktree', 'add', '-q', wt, '-b', `aw/${slug}`], main);
  mkdirSync(join(wt, 'docs/plans'), { recursive: true });
  return { main, wt, slug, head: sh(['rev-parse', 'HEAD'], main).trim() };
};

const writeHandoff = (f, { prepared = null, preparedHead = null } = {}) => {
  const record = composeProvisionRecordSection({
    slug: f.slug, branch: `aw/${f.slug}`, includes: [], nodeModules: 'skipped', vscode: 'skipped', prepared, preparedHead,
  });
  const text = `# Handoff — ${f.slug}\n\nuser notes\n\n${record}`;
  writeFileSync(join(f.wt, 'docs/plans', `handoff-${f.slug}.md`), text);
  return text;
};

const registerWave = (main) => {
  const r = dispatchMain(['register', '--wave', 'w1', '--step-classes', 'worktree-stream',
    '--pairing-key', 'stepClass', '--min-per-class', '99', '--mean-l-threshold', '1',
    '--first-pass-num', '0', '--first-pass-den', '1', '--cwd', main]);
  assert.equal(r.code, 0, r.stderr);
};

const storeText = (main) => {
  const p = join(main, '.git', 'agent-workflow-delegation.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

const runRung = async (f, over = {}) => {
  const { handoffReturn } = await rung();
  return handoffReturn({ cwd: f.main, slug: f.slug, waveId: 'w1', planId: 'delegation-3', phase: 3, env: process.env, ...over });
};

const stageAndTree = (f, path, body) => {
  writeFileSync(join(f.main, path), body);
  sh(['add', '--', path], f.main);
  return sh(['write-tree'], f.main).trim();
};

// A git seam whose EXACTLY-matched probe answers a FIXED sequence, everything else passing through
// (a bare verb match would also hijack the rev-parse git-dir probes).
const sequencedGit = (probe, answers) => {
  let calls = 0;
  return (args, cwd) => {
    if (probe.length === args.length && probe.every((v, i) => v === args[i])) {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return { status: 0, stdout: `${answer}\n`, stderr: '' };
    }
    return realGit(args, cwd);
  };
};

describe('handoff-return — the round-1 folds', () => {
  it('the pre-answer re-attestation refuses a moved tree and a moved HEAD separately, and appends nothing', async () => {
    const f = makeFixture('r2-reattest', 'c1');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main);
    const treeDrift = await runRung(f, { deps: { git: sequencedGit(['write-tree'], [tree, 'f'.repeat(40)]) } });
    assert.equal(treeDrift.code, 1);
    assert.match(treeDrift.stderr, /write-tree moved while the return was being computed/);
    const headDrift = await runRung(f, { deps: { git: sequencedGit(['rev-parse', 'HEAD'], [f.head, 'e'.repeat(40)]) } });
    assert.equal(headDrift.code, 1);
    assert.match(headDrift.stderr, /HEAD moved while the return was being computed/);
    assert.equal(storeText(f.main).trim().split('\n').length, 1, 'only the registration is in the store');
  });

  it('the NOT RECORDED lane carries the same final re-attestation', async () => {
    const f = makeFixture('r2-notrec-reattest', 'c2');
    sh(['rm', '-q', '--', 'base.txt'], f.main);
    const tree = sh(['write-tree'], f.main).trim();
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const r = await runRung(f, { deps: { git: sequencedGit(['write-tree'], [tree, 'f'.repeat(40)]) } });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /write-tree moved while the return was being computed/);
    assert.equal(r.stdout.includes('observation:'), false, 'no observation line rides a stale proof');
  });

  it('the numerator is the attested tree blob bytes under canonical-path identity: an unstaged edit moves nothing and two equal-content files count twice', async () => {
    const f = makeFixture('r2-blob-bytes', 'c3');
    const body = 'staged bytes measured from the tree\n';
    stageAndTree(f, 'one.txt', body);
    const tree = stageAndTree(f, 'two.txt', body);
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main);
    appendFileSync(join(f.main, 'one.txt'), 'unstaged tail that must not be counted\n');
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    const obs = JSON.parse(storeText(f.main).trim().split('\n').at(-1));
    assert.equal(obs.metric.numeratorBytes, 2 * Buffer.byteLength(body), 'two equal blobs count twice, disk bytes never enter');
    assert.deepEqual(JSON.parse(obs.scope).sort(), ['one.txt', 'two.txt']);
    assert.deepEqual(obs.metric.components.map((c) => c.objectId).sort(), ['one.txt', 'two.txt'], 'the component identity is the canonical path, never the blob OID');
  });

  it('the cat-file protocol is validated fail-closed: a missing object, a non-blob object, a non-numeric size and an unsafe size each refuse by name', async () => {
    const cases = [
      { name: 'missing', git: (args, cwd) => (args[0] === 'cat-file' ? { status: 128, stdout: '', stderr: 'fatal: not a valid object name' } : realGit(args, cwd)), want: /not a valid object|cat-file/ },
      { name: 'non-blob', git: (args, cwd) => (args[0] === 'cat-file' && args[1] === '-t' ? { status: 0, stdout: 'tree\n', stderr: '' } : realGit(args, cwd)), want: /is a tree, not a blob/ },
      { name: 'non-numeric', git: (args, cwd) => (args[0] === 'cat-file' && args[1] === '-s' ? { status: 0, stdout: 'abc\n', stderr: '' } : realGit(args, cwd)), want: /not a byte count/ },
      { name: 'unsafe', git: (args, cwd) => (args[0] === 'cat-file' && args[1] === '-s' ? { status: 0, stdout: '9007199254740993\n', stderr: '' } : realGit(args, cwd)), want: /not a byte count/ },
    ];
    for (const c of cases) {
      const f = makeFixture(`r2-catfile-${c.name}`, `d-${c.name}`);
      const tree = stageAndTree(f, 'feature.txt', 'x\n');
      writeHandoff(f, { prepared: tree, preparedHead: f.head });
      registerWave(f.main);
      const r = await runRung(f, { deps: { git: c.git } });
      assert.equal(r.code, 1, `${c.name}: ${r.stdout}`);
      assert.match(r.stderr, c.want, `${c.name}: ${r.stderr}`);
      assert.equal(storeText(f.main).trim().split('\n').length, 1, `${c.name}: nothing was appended`);
    }
    const g = makeFixture('r2-difftree-fail', 'd-buf');
    const tree = stageAndTree(g, 'feature.txt', 'x\n');
    writeHandoff(g, { prepared: tree, preparedHead: g.head });
    const bad = await runRung(g, { deps: { gitBuf: () => ({ status: 128, stdout: Buffer.alloc(0), stderr: 'diff-tree exploded' }) } });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /cannot enumerate the prepared change set/);
  });

  it('the raw diff-tree grammar is strict: malformed colon metadata and a missing path token refuse instead of a partial numerator', async () => {
    const mod = await rung();
    const NUL = String.fromCharCode(0);
    assert.throws(() => mod.parsePreparedChangeSet(`:100644 100644 aaaa M${NUL}x${NUL}`), /cannot parse the prepared change set/);
    assert.throws(() => mod.parsePreparedChangeSet(`:100644 100644 aaaa bbbb M${NUL}`), /missing path token/);
    assert.throws(() => mod.parsePreparedChangeSet(`:100644 100644 aaaa bbbb R100${NUL}old${NUL}`), /missing path token/);
    assert.throws(() => mod.parsePreparedChangeSet(Buffer.from([0x3a, 0xff, 0x00])), /cannot parse the prepared change set/);
    const ok = mod.parsePreparedChangeSet(`:100644 100755 cccc dddd M${NUL}x${NUL}`);
    assert.equal(ok.length, 1);
  });

  it('a path whose name is not valid UTF-8 is its own out-of-domain form, rendered as hex', async () => {
    const f = makeFixture('r2-non-utf8', 'c4');
    const rawName = Buffer.concat([Buffer.from(join(f.main, 'bad-'), 'utf8'), Buffer.from([0xff, 0xfe])]);
    writeFileSync(rawName, 'bytes\n');
    sh(['add', '-A'], f.main);
    const tree = sh(['write-tree'], f.main).trim();
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /observation: NOT RECORDED — a path whose name is not valid UTF-8 at <non-UTF-8 path 0x[0-9a-f]+> is outside the observation domain/);
  });

  it('a control-byte path renders escaped on the NOT RECORDED and the RECORDED lanes alike', async () => {
    const f = makeFixture('r2-ctl-byte', 'c5');
    symlinkSync('base.txt', join(f.main, CTL_NAME));
    sh(['add', '-A'], f.main);
    const treeOut = sh(['write-tree'], f.main).trim();
    writeHandoff(f, { prepared: treeOut, preparedHead: f.head });
    const out = await runRung(f);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.includes(CTL_NAME), false, 'no raw control byte reaches the terminal on the NOT RECORDED lane');
    assert.ok(out.stdout.includes(`a symlink at ${CTL_ESCAPED}`), out.stdout);
    const g = makeFixture('r2-ctl-byte-rec', 'c6');
    const tree = stageAndTree(g, CTL_NAME, 'x\n');
    writeHandoff(g, { prepared: tree, preparedHead: g.head });
    registerWave(g.main);
    const rec = await runRung(g);
    assert.equal(rec.code, 0, rec.stderr);
    assert.match(rec.stdout, /observation: RECORDED/);
    assert.equal(rec.stdout.includes(CTL_NAME), false, 'no raw control byte reaches the terminal on the RECORDED lane');
    assert.ok(rec.stdout.includes(CTL_ESCAPED), rec.stdout);
  });

  it('the prepared pair is read from the delivered bytes: a record swapped between the identity read and the delivery read refuses', async () => {
    const f = makeFixture('r2-swap', 'c7');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    const genuine = writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const swapped = genuine.replace(`- slug: ${f.slug}`, '- slug: someone-else');
    const r = await runRung(f, { deps: { readBytes: () => ({ outcome: 'ok', bytes: Buffer.from(swapped, 'utf8') }) } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /delivered bytes disagree with the proven identity/);
    assert.equal(storeText(f.main), '', 'nothing was appended');
  });

  it('an invalid-UTF-8 handoff at the delivery read refuses by the reader s own name', async () => {
    const f = makeFixture('r2-invalid-utf8', 'c8');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const invalid = join(TMP, 'invalid-delivery.bin');
    writeFileSync(invalid, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const r = await runRung(f, { deps: { readBytes: () => readFileBytesNoFollow(invalid) } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid UTF-8/);
  });
});

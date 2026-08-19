// worktree-handoff-return.test.mjs — the handoff-return rung's acceptance (delegation Plan 3,
// Phase 3): deliver the satellite's user-owned return byte verbatim, prove the prepared pair
// against MAIN, and record the observation only when the prepared change set lies wholly inside
// the observation domain. Its OWN suite (D13/D6): no recorded baseline grows.
//
// Real git: the rung attests a live index and HEAD, and the locator walks a live worktree
// registry — a faked registry would prove the leaves twice and the rung never.
// The rung module is imported DYNAMICALLY inside each test so the suite loads and FAILS pre-fix.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeProvisionRecordSection } from './worktrees-record.mjs';
import { main as dispatchMain } from './dispatch.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-handoff-return-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const rung = () => import('./worktree-handoff-return.mjs');

// The delivery fixture: user content on BOTH sides of the record, a CRLF line, a line that
// IMITATES the section heading, and non-ASCII symbols — one plain line would not prove
// byte-verbatim delivery (D15).
const userBefore = (slug) => [
  `# Handoff — ${slug}`,
  '',
  'finding one, CRLF-terminated for the byte-verbatim proof\r',
  '## Provision record imitation line — not the real section heading',
  'non-ASCII symbols survive delivery: § → •',
  '',
].join('\n');
const USER_AFTER = ['## Session notes', 'after-record user content stays user-owned →', ''].join('\n');

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

const writeHandoff = (f, { prepared = null, preparedHead = null, before = userBefore(f.slug), afterText = USER_AFTER } = {}) => {
  const record = composeProvisionRecordSection({
    slug: f.slug, branch: `aw/${f.slug}`, includes: [], nodeModules: 'skipped', vscode: 'skipped', prepared, preparedHead,
  });
  const text = before + record + afterText;
  writeFileSync(join(f.wt, 'docs/plans', `handoff-${f.slug}.md`), text);
  return text;
};

const registerWave = (main, wave) => {
  const r = dispatchMain(['register', '--wave', wave, '--step-classes', 'worktree-stream',
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

// stage → write-tree: the recorded prepared pair a fixture hands the rung.
const stageAndTree = (f, path, body) => {
  writeFileSync(join(f.main, path), body);
  sh(['add', '--', path], f.main);
  return sh(['write-tree'], f.main).trim();
};

describe('handoff-return — delivery, proof, and the observation domain', () => {
  it('delivery prints every user-owned fragment byte verbatim with boundaries and byte lengths and names the MAIN-owned destinations', async () => {
    const f = makeFixture('hr-delivery', 'a1');
    const tree = stageAndTree(f, 'feature.txt', 'delivered feature bytes\n');
    const before = userBefore(f.slug);
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main, 'w1');
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(before), 'the BEFORE fragment must arrive byte verbatim, CRLF and imitation line included');
    assert.ok(r.stdout.includes(USER_AFTER), 'the AFTER fragment must arrive byte verbatim');
    assert.ok(r.stdout.includes(`before "## Provision record" — ${Buffer.byteLength(before)} bytes`), r.stdout);
    assert.ok(r.stdout.includes(`after the "## Provision record" section — ${Buffer.byteLength(USER_AFTER)} bytes`), r.stdout);
    assert.ok(r.stdout.includes('docs/plans/queue.md'), 'the findings destination is named');
    assert.ok(r.stdout.includes('docs/ai'), 'the records destination is named');
  });

  it('a handoff with no prepared-tree refuses by name and appends nothing', async () => {
    const f = makeFixture('hr-no-tree', 'a2');
    writeHandoff(f, { prepared: null, preparedHead: null });
    const r = await runRung(f);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no prepared-tree/);
    assert.match(r.stderr, /land --prepare/);
    assert.equal(storeText(f.main), '', 'nothing was appended');
  });

  it('a record with no prepared-head refuses by name and points at land --prepare', async () => {
    const f = makeFixture('hr-no-head', 'a3');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: null });
    const r = await runRung(f);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no prepared-head/);
    assert.match(r.stderr, /land --prepare/);
    assert.equal(storeText(f.main), '', 'nothing was appended');
  });

  it('a staged write-tree unequal to prepared-tree refuses naming both OIDs', async () => {
    const f = makeFixture('hr-tree-moved', 'a4');
    const recorded = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: recorded, preparedHead: f.head });
    const current = stageAndTree(f, 'later.txt', 'staged after the prepare\n');
    const r = await runRung(f);
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(recorded), 'the recorded OID is named');
    assert.ok(r.stderr.includes(current), 'the current staged OID is named');
    assert.equal(storeText(f.main), '', 'nothing was appended');
  });

  it('a moved HEAD refuses even when the staged write-tree still matches and appends nothing', async () => {
    const f = makeFixture('hr-head-moved', 'a5');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    sh(['commit', '-q', '-m', 'landed'], f.main);
    const liveHead = sh(['rev-parse', 'HEAD'], f.main).trim();
    assert.equal(sh(['write-tree'], f.main).trim(), tree, 'the post-commit clean index reproduces the committed tree');
    const r = await runRung(f);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /HEAD/);
    assert.ok(r.stderr.includes(f.head) && r.stderr.includes(liveHead), 'both HEAD OIDs are named');
    assert.equal(storeText(f.main), '', 'nothing was appended');
  });

  it('a run from inside a satellite refuses because the git dir is not the git common dir', async () => {
    const f = makeFixture('hr-satellite', 'a6');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const r = await runRung(f, { cwd: f.wt });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the git dir is not the git common dir/);
    assert.equal(storeText(f.main), '', 'nothing was appended');
  });

  it('an add-only change set records the observation with class worktree-stream provenance self-reported denominator the handoff byte count and scope the prepared change set', async () => {
    const f = makeFixture('hr-recorded', 'a7');
    const body = 'measured post-image bytes of the prepared change set\n';
    const tree = stageAndTree(f, 'feature.txt', body);
    const text = writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main, 'w1');
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /observation: RECORDED/);
    const records = storeText(f.main).trim().split('\n').map((l) => JSON.parse(l));
    const obs = records.at(-1);
    assert.equal(obs.kind, 'observation');
    assert.equal(obs.stepClass, 'worktree-stream');
    assert.equal(obs.metric.provenance, 'self-reported');
    assert.equal(obs.metric.denominatorBytes, Buffer.byteLength(text));
    assert.equal(obs.metric.numeratorBytes, Buffer.byteLength(body));
    assert.equal(obs.scope, JSON.stringify(['feature.txt']));
    assert.equal(obs.planId, 'delegation-3');
    assert.equal(obs.phase, 3);
  });

  it('each out-of-domain form yields observation NOT RECORDED naming the form and the path with delivery and proof still printed and exit 0', async () => {
    const forms = [
      { name: 'del', form: 'a deletion', path: 'base.txt', setup: (m) => sh(['rm', '-q', '--', 'base.txt'], m) },
      { name: 'ren', form: "a rename's absent old side", path: 'base.txt', setup: (m) => sh(['mv', 'base.txt', 'renamed.txt'], m) },
      {
        name: 'sym', form: 'a symlink', path: 'link',
        setup: (m) => { symlinkSync('base.txt', join(m, 'link')); sh(['add', '--', 'link'], m); },
      },
      {
        name: 'sub', form: 'a submodule', path: 'sub',
        setup: (m, head) => sh(['update-index', '--add', '--cacheinfo', `160000,${head},sub`], m),
      },
      {
        name: 'mode', form: 'a mode-only change', path: 'base.txt',
        setup: (m) => { chmodSync(join(m, 'base.txt'), 0o755); sh(['add', '--', 'base.txt'], m); },
      },
    ];
    for (const c of forms) {
      const f = makeFixture(`hr-out-${c.name}`, `b-${c.name}`);
      c.setup(f.main, f.head);
      const tree = sh(['write-tree'], f.main).trim();
      writeHandoff(f, { prepared: tree, preparedHead: f.head });
      const r = await runRung(f);
      assert.equal(r.code, 0, `${c.name}: ${r.stderr}`);
      assert.ok(r.stdout.includes(`observation: NOT RECORDED — ${c.form} at ${c.path} is outside the observation domain`), `${c.name}: ${r.stdout}`);
      assert.ok(r.stdout.includes('proof —'), `${c.name}: the proof still prints`);
      assert.ok(r.stdout.includes('before "## Provision record"'), `${c.name}: the delivery still prints`);
      assert.equal(storeText(f.main), '', `${c.name}: nothing was appended`);
    }
  });

  it('a regular binary file is inside the domain and records normally', async () => {
    const f = makeFixture('hr-binary', 'a8');
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x0a, 0x00, 0x80]);
    writeFileSync(join(f.main, 'blob.bin'), bytes);
    sh(['add', '--', 'blob.bin'], f.main);
    const tree = sh(['write-tree'], f.main).trim();
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main, 'w1');
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /observation: RECORDED/);
    const obs = JSON.parse(storeText(f.main).trim().split('\n').at(-1));
    assert.equal(obs.metric.numeratorBytes, bytes.length, 'binary bytes are read like any other');
  });

  it('a store STOP travels verbatim', async () => {
    const f = makeFixture('hr-store-stop', 'a9');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const r = await runRung(f, { waveId: 'w-unregistered' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /UNREGISTERED wave "w-unregistered"/);
    assert.ok(r.stdout.includes('proof —'), 'delivery and proof already ran when the store refused');
  });

  it('the printed proof carries the handoff digest over the exact raw bytes and both OIDs', async () => {
    const f = makeFixture('hr-proof', 'b1');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    const text = writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main, 'w1');
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    const digest = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    assert.ok(r.stdout.includes(`sha256 ${digest} over ${Buffer.byteLength(text)} bytes`), r.stdout);
    assert.ok(r.stdout.includes(tree) && r.stdout.includes(f.head), 'both OIDs ride the printed proof');
  });

  it('the printed next-step order is AFTER_FOLD_ORDER verbatim', async () => {
    const f = makeFixture('hr-order', 'b2');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    registerWave(f.main, 'w1');
    const mod = await rung();
    const r = await runRung(f);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(mod.AFTER_FOLD_ORDER.length > 40, 'the order sentence is substantive');
    assert.ok(r.stdout.includes(`next: ${mod.AFTER_FOLD_ORDER}`), r.stdout);
  });

  it('the leaf seams answer every arm: the read-outcome mapper, the raw-diff parser, and the classifier catch-all', async () => {
    const mod = await rung();
    const b = Buffer.from('x');
    assert.deepEqual(mod.leafReadOutcome({ outcome: 'ok', bytes: b }), { bytes: b });
    assert.deepEqual(mod.leafReadOutcome({ outcome: 'absent' }), { absent: true });
    assert.deepEqual(mod.leafReadOutcome({ outcome: 'foreign', className: 'FIFO' }), { unsafe: true });
    assert.deepEqual(mod.leafReadOutcome({ outcome: 'error', code: 'EIO' }), { error: 'EIO' });
    const parsed = mod.parsePreparedChangeSet(':100644 100755 aaaa bbbb T\0x\0:100644 100644 cccc dddd R100\0old\0new\0');
    assert.equal(parsed.length, 2);
    assert.deepEqual([parsed[1].oldPath, parsed[1].path], ['old', 'new']);
    assert.throws(() => mod.parsePreparedChangeSet(':100644 100755 aaaa bbbb T\0x\0garbage'), /cannot parse the prepared change set/, 'a stray token where a meta belongs is never skipped — a partial numerator must be inexpressible');
    const t = mod.classifyPreparedEntry(parsed[0]);
    assert.equal(t.inside, false);
    assert.match(t.form, /unrepresentable form/);
  });

  it('an unreadable handoff or a failing git probe refuses by name instead of guessing', async () => {
    const f = makeFixture('hr-seams', 'b3');
    const tree = stageAndTree(f, 'feature.txt', 'x\n');
    writeHandoff(f, { prepared: tree, preparedHead: f.head });
    const { handoffReturn } = await rung();
    const unreadable = await runRung(f, { deps: { readBytes: () => ({ outcome: 'error', code: 'EIO' }) } });
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.stderr, /EIO/);
    const badGit = await runRung(f, {
      deps: { git: (args, cwd) => (args[0] === 'write-tree' ? { status: 128, stdout: '', stderr: 'boom' } : spawnSync('git', args, { cwd, encoding: 'utf8' })) },
    });
    assert.equal(badGit.code, 1);
    assert.match(badGit.stderr, /boom|write-tree/);
    const noRepo = handoffReturn({ cwd: TMP, slug: 'b3', waveId: 'w1', planId: 'p', phase: 1, env: process.env });
    assert.equal(noRepo.code, 1);
    assert.match(noRepo.stderr, /work tree/);
  });
});

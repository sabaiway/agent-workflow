import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  main, runCli, DISPATCH_CONTRACT,
  REGISTER_FLAG_FIELDS, REGISTER_DERIVED_FIELDS, OBSERVE_FLAG_FIELDS, OBSERVE_DERIVED_FIELDS,
  wavesInStore, selectWave, aggregateDelegationWave, renderAggregate,
} from './dispatch.mjs';
// The NAMESPACE form beside the named imports above: a missing export then surfaces as a failing
// assertion inside the test that needs it, never as a link-time error that reddens the whole file —
// the red-first discipline needs every proof to fail for its OWN reason.
import * as engine from './dispatch.mjs';
import {
  DELEGATION_SCHEMA_VERSION, DELEGATION_KEY_SETS, RETURN_OUTCOMES, SESSION_ID_NULLABLE_OUTCOMES,
  canonicalDelegationDigest, contractDigest, expectedBundleLength,
} from './dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from './dispatch-store.mjs';
import { computeTreeFingerprint, computeWorkingState, isTreeClean } from './core-evidence.mjs';
import { enumerateReturnedObjects } from './exec-producer.mjs';
import {
  EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename,
} from './exec-receipt.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-dispatch-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const MODULE_PATH = fileURLToPath(new URL('./dispatch.mjs', import.meta.url));

let seq = 0;
const plainDir = () => {
  const dir = join(TMP, `plain-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  return { cwd: dir, store: join(dir, DELEGATION_STORE_BASENAME), env: { AW_DELEGATION_STORE: join(dir, DELEGATION_STORE_BASENAME) } };
};

// One workspace per test: a real git work tree (an observation's scope is repo-relative, so the
// engine resolves the top-level) holding the scope objects, plus a store on the
// AW_DELEGATION_STORE seam so no test depends on the repo it runs in.
const workspace = () => {
  const ws = plainDir();
  const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: ws.cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git init failed: ${r.stderr}`);
  return ws;
};

let ticks = 0;
const clock = () => new Date(Date.UTC(2026, 7, 9, 12, 0, ticks += 1)).toISOString();
const run = (argv, ws) => main(argv, { cwd: ws.cwd, env: ws.env, now: clock });

const writeScope = (ws, name, bytes) => {
  writeFileSync(join(ws.cwd, name), 'x'.repeat(bytes));
  return name;
};

// `--scope` is repeatable — one path per occurrence, never a split list.
const scopeFlags = (...paths) => paths.flatMap((p) => ['--scope', p]);

// ── contract-header fixtures ──────────────────────────────────────────────────────────────────────

const CONTRACT = {
  schema: DELEGATION_SCHEMA_VERSION,
  nonce: 'p3-a1',
  stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'add the aggregate verb',
  inputs: 'the plan section + dispatch-store.mjs',
  acceptance: 'the named tests are green',
  returnShape: 'a unified diff plus a report',
  producerContract: 'the wrapper mints the return record',
  deadlineS: 900,
  retry: { cap: 2, index: 0 },
};

const dispatchFile = (ws, name, contract, extra = '') => {
  const body = `# a sub-task\n\n\`\`\`aw-dispatch-contract\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n${extra}`;
  writeFileSync(join(ws.cwd, name), body);
  return name;
};

// ── ledger fixtures (written as raw JSONL where a test needs a shape the append preflight refuses) ──

const D = (pair) => pair.repeat(32);
const TS = (n) => new Date(Date.UTC(2026, 7, 9, 10, 0, n)).toISOString();

const registration = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'pre-registration', waveId: 'wave-a',
  stepClasses: ['code'], pairingKey: 'stepClass', minPerClass: 3, meanLThreshold: 2,
  firstPassNum: 2, firstPassDen: 3, timestamp: TS(0), ...over,
});

const dispatchRecord = (nonce, over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'dispatch', waveId: 'wave-a', nonce, stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' }, backend: 'codex',
  contractDigest: D('c1'), preTreeDigest: D('a1'), baselineClean: true, deadlineS: 900,
  retryOf: null, retryIndex: 0, retryCap: 2, rationale: 'a bounded sub-task', timestamp: TS(1),
  ...over,
});

const DIFF = 100;
const REPORT = 50;
const BUNDLE = expectedBundleLength(DIFF, REPORT);
const EMPTY_BUNDLE = expectedBundleLength(0, 0);

const returnRecord = (nonce, over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'return', role: 'execute', backend: 'codex', nonce,
  contractDigest: D('c1'), preTreeDigest: D('a1'), postTreeDigest: D('b2'), diffDigest: D('d3'),
  diffLength: DIFF, reportDigest: D('e4'), reportLength: REPORT, bundleDigest: D('f5'),
  bundleLength: BUNDLE,
  metric: {
    numeratorBytes: 2 * BUNDLE, denominatorBytes: BUNDLE,
    components: [{ kind: 'modified', path: 'src/a.mjs', objectId: 'oid-a', bytes: 2 * BUNDLE }],
    provenance: 'wrapper-git', eligible: true, ineligibleReason: null,
  },
  outcome: 'success', exitStatus: 0, sessionId: 'sess-1', wrapperVersion: '3.4.1',
  posture: { model: 'gpt-5', effort: 'high', tier: 'priority' }, timestamp: TS(2), ...over,
});

// A transport failure carries no diff and no report; its metric is ineligible by its own numbers.
const failureReturn = (nonce, over = {}) => returnRecord(nonce, {
  outcome: 'transport-failure', exitStatus: 1, sessionId: null,
  diffLength: 0, reportLength: 0, bundleLength: EMPTY_BUNDLE,
  metric: {
    numeratorBytes: 0, denominatorBytes: EMPTY_BUNDLE, components: [],
    provenance: 'wrapper-git', eligible: false, ineligibleReason: 'no-op-diff',
  },
  ...over,
});

const foldRecord = (ret, over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'fold', nonce: ret.nonce,
  returnDigest: canonicalDelegationDigest(ret), treeDigestAtFold: ret.postTreeDigest,
  verdict: 'folded as returned', timestamp: TS(3), ...over,
});

const degradeRecord = (nonce, over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'degrade', waveId: 'wave-a', nonce, stepClass: 'code',
  rationale: 'the backend never answered; closed with a recorded degrade', timestamp: TS(4), ...over,
});

const observationRecord = (over = {}) => ({
  schema: DELEGATION_SCHEMA_VERSION, kind: 'observation', waveId: 'wave-a', stepClass: 'code',
  scope: 'tools/dispatch.mjs',
  metric: {
    numeratorBytes: 400, denominatorBytes: 400,
    components: [{ kind: 'new', path: 'tools/dispatch.mjs', objectId: 'oid-d', bytes: 400 }],
    provenance: 'solo-construction', eligible: true, ineligibleReason: null,
  },
  planId: 'delegation-1-contract-ledger-baseline', phase: 3, timestamp: TS(5), ...over,
});

// A folded thread: dispatch → return → fold. `overReturn` shapes the return's metric/outcome.
const foldedThread = (nonce, overReturn = {}, overDispatch = {}) => {
  const ret = returnRecord(nonce, overReturn);
  return [dispatchRecord(nonce, overDispatch), ret, foldRecord(ret)];
};

const writeStore = (ws, records) => {
  writeFileSync(ws.store, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return ws;
};

// ── (1) check — the D8 contract header, FORM only ─────────────────────────────────────────────────

describe('check: a valid dispatch file exits 0; each D8 violation exits nonzero naming the field', () => {
  it('a well-formed header exits 0 and echoes the identity it read', () => {
    const ws = workspace();
    const r = run(['check', dispatchFile(ws, 'task.md', CONTRACT)], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /FORM OK/);
    assert.match(r.stdout, /nonce "p3-a1"/);
    assert.match(r.stdout, /step class "code"/);
    assert.match(r.stdout, /retry 0\/2/);
    assert.ok(r.stdout.includes(DISPATCH_CONTRACT), 'the form-only limit rides the success line');
  });

  it('a semantically absurd but well-formed header still passes — the check is FORM-only by name', () => {
    const ws = workspace();
    const absurd = { ...CONTRACT, scope: 'do everything', acceptance: 'it is good', inputs: '-' };
    const r = run(['check', dispatchFile(ws, 'absurd.md', absurd)], ws);
    assert.equal(r.code, 0, r.stderr);
  });

  for (const [field, contract] of [
    ['nonce', { ...CONTRACT, nonce: 'not a safe nonce!' }],
    ['stepClass', { ...CONTRACT, stepClass: 'freestyle' }],
    ['deadlineS', { ...CONTRACT, deadlineS: 0 }],
    ['retry', { ...CONTRACT, retry: { cap: 1, index: 2 } }],
    ['vehicle', { ...CONTRACT, vehicle: { requested: 'codex-exec' } }],
    ['schema', { ...CONTRACT, schema: 2 }],
  ]) {
    it(`a bad ${field} exits 1 naming the field`, () => {
      const ws = workspace();
      const r = run(['check', dispatchFile(ws, 'bad.md', contract)], ws);
      assert.equal(r.code, 1);
      assert.match(r.stdout, new RegExp(`FORM VIOLATION[\\s\\S]*${field}`));
    });
  }

  it('a missing field is named', () => {
    const ws = workspace();
    const { acceptance, ...withoutAcceptance } = CONTRACT;
    const r = run(['check', dispatchFile(ws, 'missing.md', withoutAcceptance)], ws);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /missing field "acceptance"/);
  });

  it('an absent block, a duplicated block, and a non-JSON body each refuse by name', () => {
    const ws = workspace();
    writeFileSync(join(ws.cwd, 'none.md'), '# no contract here\n');
    assert.match(run(['check', 'none.md'], ws).stdout, /no top-level ```aw-dispatch-contract block/);

    const twice = dispatchFile(ws, 'twice.md', CONTRACT, `\n\`\`\`aw-dispatch-contract\n${JSON.stringify(CONTRACT)}\n\`\`\`\n`);
    assert.match(run(['check', twice], ws).stdout, /2 ```aw-dispatch-contract blocks/);

    writeFileSync(join(ws.cwd, 'junk.md'), '```aw-dispatch-contract\nnot json\n```\n');
    assert.match(run(['check', 'junk.md'], ws).stdout, /not valid JSON/);
  });

  it('an unreadable dispatch file refuses (exit 1) and a missing/extra operand is usage (exit 2)', () => {
    const ws = workspace();
    const absent = run(['check', 'nowhere.md'], ws);
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /cannot read nowhere\.md/);
    assert.equal(run(['check'], ws).code, 2);
    assert.equal(run(['check', 'a.md', 'b.md'], ws).code, 2);
  });

  it('an ABSOLUTE dispatch path is read as given', () => {
    const ws = workspace();
    const rel = dispatchFile(ws, 'abs.md', CONTRACT);
    assert.equal(run(['check', join(ws.cwd, rel)], ws).code, 0);
  });
});

// ── (2) register / observe — the flag surface mirrors the D3 key sets ──────────────────────────────

describe('register/observe flags mirror the D3 key sets (the CLI tests pin the exact surface)', () => {
  const topLevel = (fields) => [...new Set(Object.values(fields).map((f) => f.split('.')[0]))];

  it('the register flag surface plus its derived fields IS the pre-registration key set', () => {
    assert.deepEqual(
      [...topLevel(REGISTER_FLAG_FIELDS), ...REGISTER_DERIVED_FIELDS].sort(),
      [...DELEGATION_KEY_SETS['pre-registration']].sort(),
    );
    assert.deepEqual(Object.keys(REGISTER_FLAG_FIELDS), [
      '--wave', '--step-classes', '--pairing-key', '--min-per-class', '--mean-l-threshold',
      '--first-pass-num', '--first-pass-den',
    ]);
  });

  it('the observe flag surface plus its derived fields IS the observation key set (the metric flags land under metric)', () => {
    assert.deepEqual(
      [...topLevel(OBSERVE_FLAG_FIELDS), ...OBSERVE_DERIVED_FIELDS].sort(),
      [...DELEGATION_KEY_SETS.observation].sort(),
    );
    assert.deepEqual(Object.keys(OBSERVE_FLAG_FIELDS), [
      '--wave', '--step-class', '--scope', '--plan', '--phase', '--provenance', '--denominator-bytes',
    ]);
  });

  const WAVE_FLAGS = ['--wave', 'wave-a', '--step-classes', 'code', '--pairing-key', 'stepClass'];
  const registerArgv = (min, mean) => ['register', ...WAVE_FLAGS, '--min-per-class', min,
    '--mean-l-threshold', mean, '--first-pass-num', '2', '--first-pass-den', '3'];
  const REGISTER = registerArgv('3', '2');

  it('register appends ONE pre-registration record and a second one refuses (immutable per wave)', () => {
    const ws = workspace();
    const first = run(REGISTER, ws);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /wave "wave-a" registered/);
    assert.match(first.stdout, /minimum 3 per class/);
    const store = readDelegationStore(ws.store);
    assert.equal(store.malformed, 0);
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0].kind, 'pre-registration');
    assert.deepEqual(store.records[0].stepClasses, ['code']);

    const second = run(REGISTER, ws);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already registered/);
  });

  it('register takes a comma-separated class list', () => {
    const ws = workspace();
    const r = run(['register', '--wave', 'w2', '--step-classes', 'code,extraction', '--pairing-key', 'stepClass',
      '--min-per-class', '1', '--mean-l-threshold', '1.5', '--first-pass-num', '1', '--first-pass-den', '2'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readDelegationStore(ws.store).records[0].stepClasses, ['code', 'extraction']);
  });

  it('a missing, unknown, duplicated or unparseable flag is USAGE (exit 2), never a record', () => {
    const ws = workspace();
    assert.match(run(['register', '--wave', 'wave-a'], ws).stderr, /--step-classes is required/);
    assert.match(run([...REGISTER, '--frobnicate', 'x'], ws).stderr, /unknown argument: --frobnicate/);
    assert.match(run([...REGISTER, '--wave', 'wave-b'], ws).stderr, /--wave was given twice/);
    assert.match(run(['register', '--wave', 'wave-a', '--pairing-key'], ws).stderr, /--pairing-key needs a value/);
    assert.match(run(registerArgv('three', '2'), ws).stderr, /--min-per-class must be a non-negative decimal integer/);
    assert.match(run(registerArgv('12345678901234567890', '2'), ws).stderr, /--min-per-class leaves the safe-integer range/);
    assert.match(run(registerArgv('3', 'lots'), ws).stderr, /--mean-l-threshold must be a finite number/);
    assert.equal(readDelegationStore(ws.store).records.length, 0);
  });

  it('a record the vocabulary refuses is a REFUSAL (exit 1), not a usage error', () => {
    const ws = workspace();
    const r = run(['register', '--wave', 'wave-a', '--step-classes', 'code', '--pairing-key', 'stepClass',
      '--min-per-class', '3', '--mean-l-threshold', '2', '--first-pass-num', '4', '--first-pass-den', '3'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /firstPassNum 4 must not exceed firstPassDen 3/);
  });

  const observeArgv = (over = []) => ['observe', '--wave', 'wave-a', '--step-class', 'code',
    '--plan', 'delegation-1-contract-ledger-baseline', '--phase', '3', ...over];

  it('a solo-construction observation measures its scope and records L = 1 by construction', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'a.mjs', 300);
    writeScope(ws, 'b.mjs', 700);
    const r = run(observeArgv(['--provenance', 'solo-construction', ...scopeFlags('a.mjs', 'b.mjs')]), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /L = 1\.000 \(1000 B \/ 1000 B\)/);
    assert.match(r.stdout, /2 object\(s\)/);
    const record = readDelegationStore(ws.store).records[1];
    assert.equal(record.kind, 'observation');
    assert.equal(record.scope, '["a.mjs","b.mjs"]');
    assert.equal(record.metric.numeratorBytes, 1000);
    assert.equal(record.metric.denominatorBytes, 1000);
    assert.equal(record.metric.provenance, 'solo-construction');
    assert.deepEqual(record.metric.components.map((c) => c.kind), ['new', 'new']);
    assert.equal(record.phase, 3);
  });

  it('one object listed twice is counted ONCE (the vocabulary dedups on object identity)', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'a.mjs', 300);
    const r = run(observeArgv(['--provenance', 'solo-construction', ...scopeFlags('a.mjs', 'a.mjs')]), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readDelegationStore(ws.store).records[1].metric.numeratorBytes, 300);
    // The echo counts DISTINCT objects, so it agrees with the
    // numerator it summarises instead of reporting the scope entries.
    assert.match(r.stdout, /· 1 object\(s\)/);
  });

  // Help is argv[0] ONLY, because two scanners once looked at the
  // same vector, so a flag VALUE could be read as a control argument — a scope path named `--help`
  // printed help and wrote nothing, and the `--cwd` search stole whichever token followed it.
  it('a flag VALUE is never read as a control argument', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, '--help', 40);
    writeScope(ws, '--cwd', 60);
    const r = run(observeArgv(['--provenance', 'solo-construction', ...scopeFlags('--help', '--cwd')]), ws);
    assert.equal(r.code, 0, r.stderr);
    const record = readDelegationStore(ws.store).records[1];
    assert.equal(record.scope, '["--help","--cwd"]');
    assert.equal(record.metric.numeratorBytes, 100);

    const wave = run(['aggregate', '--wave', '--help'], ws);
    assert.equal(wave.code, 1, 'a wave id that looks like a help request is a wave id');
    assert.match(wave.stderr, /names the wave "--help"/);

    assert.match(main(['--help'], {}).stdout, /^dispatch — the delegation engine/);
    assert.equal(run(['check', '--help'], ws).code, 1, 'past the verb, --help is an operand — the file by that name is read');
  });

  // The "L = 1 by construction" promise has exactly ONE exception, and
  // it is recorded rather than smoothed over — 0/0 is undefined before it is one.
  it('a solo scope measuring zero bytes has no ratio and is recorded INELIGIBLE by name', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'empty.mjs', 0);
    const r = run(observeArgv(['--provenance', 'solo-construction', ...scopeFlags('empty.mjs')]), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /INELIGIBLE \(zero-denominator\)/);
    const metric = readDelegationStore(ws.store).records[1].metric;
    assert.equal(metric.eligible, false);
    assert.equal(metric.ineligibleReason, 'zero-denominator');
  });

  // The identity is the canonical path ALONE. It was once the
  // content hash, so two distinct files with equal bytes deduped into one object and the numerator
  // was under-reported. A content id would also let a file read twice between measurements look
  // like two objects instead of refusing as the producer contradiction it is.
  it('two files with identical bytes are two objects — the solo identity is the canonical path', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'twin-a.mjs', 250);
    writeScope(ws, 'twin-b.mjs', 250);
    const r = run(observeArgv(['--provenance', 'solo-construction', ...scopeFlags('twin-a.mjs', 'twin-b.mjs')]), ws);
    assert.equal(r.code, 0, r.stderr);
    const metric = readDelegationStore(ws.store).records[1].metric;
    assert.equal(metric.numeratorBytes, 500, 'equal bytes at two paths are two objects');
    assert.deepEqual(metric.components.map((c) => c.objectId), ['twin-a.mjs', 'twin-b.mjs']);
  });

  // No separator is safe inside a POSIX path, so the
  // whitespace split could not express a path with a space and would silently measure the fragments
  // wherever they happened to exist. One path per --scope, recorded as a canonical JSON array.
  it('a scope path containing a space is expressible and is recorded as a canonical JSON array', () => {
    const ws = workspace();
    run(REGISTER, ws);
    mkdirSync(join(ws.cwd, 'docs'));
    writeScope(ws, 'docs/my file.md', 120);
    // The decoys are the FRAGMENTS a whitespace split would produce — both real regular files, so a
    // split would have measured 18 bytes of the wrong objects without a word.
    writeScope(ws, 'docs/my', 7);
    writeScope(ws, 'file.md', 11);
    const r = run(observeArgv(['--provenance', 'solo-construction', ...scopeFlags('docs/my file.md')]), ws);
    assert.equal(r.code, 0, r.stderr);
    const record = readDelegationStore(ws.store).records[1];
    assert.equal(record.scope, '["docs/my file.md"]');
    assert.equal(record.metric.numeratorBytes, 120);
  });

  // Both ends check the key: the schema types pairingKey as a free string so a
  // future key is expressible, but a wave registered under a key the aggregator never honours would
  // record a contract the computation does not follow. The read side is the load-bearing half — a
  // store can be hand-written — so it is checked independently of the flag.
  it('register and aggregate both refuse a pairing key the engine does not implement', () => {
    const ws = workspace();
    const registered = run(['register', ...WAVE_FLAGS.slice(0, 4), '--pairing-key', 'backend',
      '--min-per-class', '3', '--mean-l-threshold', '2', '--first-pass-num', '2', '--first-pass-den', '3'], ws);
    assert.equal(registered.code, 2);
    assert.match(registered.stderr, /--pairing-key must be one of stepClass/);
    assert.equal(readDelegationStore(ws.store).records.length, 0);

    const handWritten = writeStore(workspace(), [registration({ pairingKey: 'backend' })]);
    const aggregated = run(['aggregate'], handWritten);
    assert.equal(aggregated.code, 1);
    assert.match(aggregated.stderr, /registered under pairing key "backend", which this aggregator does not implement/);
  });

  it('a self-reported observation states its own denominator; solo-construction refuses the flag', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'a.mjs', 400);
    const self = run(observeArgv(['--provenance', 'self-reported', '--scope', 'a.mjs', '--denominator-bytes', '200']), ws);
    assert.equal(self.code, 0, self.stderr);
    assert.match(self.stdout, /L = 2\.000 \(400 B \/ 200 B\)/);

    const solo = run(observeArgv(['--provenance', 'solo-construction', '--scope', 'a.mjs', '--denominator-bytes', '200']), ws);
    assert.equal(solo.code, 2);
    assert.match(solo.stderr, /--denominator-bytes is refused for --provenance solo-construction/);

    const missing = run(observeArgv(['--provenance', 'self-reported', '--scope', 'a.mjs']), ws);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--denominator-bytes is required/);
  });

  it('a zero denominator is recorded INELIGIBLE by name, never as a silent zero', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'a.mjs', 400);
    const r = run(observeArgv(['--provenance', 'self-reported', '--scope', 'a.mjs', '--denominator-bytes', '0']), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /INELIGIBLE \(zero-denominator\)/);
    assert.equal(readDelegationStore(ws.store).records[1].metric.eligible, false);
  });

  it('observe refuses a provenance the ledger derives, and every scope path it cannot count honestly', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'a.mjs', 10);
    mkdirSync(join(ws.cwd, 'adir'));
    symlinkSync(join(ws.cwd, 'a.mjs'), join(ws.cwd, 'alink'));

    assert.match(run(observeArgv(['--provenance', 'wrapper-git', '--scope', 'a.mjs']), ws).stderr,
      /--provenance must be one of solo-construction \| self-reported/);
    assert.match(run(observeArgv(['--provenance', 'solo-construction', '--scope', 'gone.mjs']), ws).stderr,
      /scope path "gone\.mjs" does not exist/);
    assert.match(run(observeArgv(['--provenance', 'solo-construction', '--scope', 'adir']), ws).stderr,
      /scope path "adir" is a directory/);
    assert.match(run(observeArgv(['--provenance', 'solo-construction', '--scope', 'alink']), ws).stderr,
      /scope path "alink" is a symlink/);
    assert.match(run(observeArgv(['--provenance', 'solo-construction', '--scope', '../outside.mjs']), ws).stderr,
      /escapes the repo root/);
    assert.equal(readDelegationStore(ws.store).records.length, 1);
  });

  // A scope entry is repo-relative, so it is anchored at the git
  // top-level (not at whatever cwd the run happened to have) and its REAL path must stay inside the
  // repository — the lexical check alone rejects "../x" while accepting "link/x" through an
  // ancestor symlink that leaves the tree entirely.
  it('observe anchors its scope at the git top-level and refuses an escaping ancestor symlink', () => {
    const ws = workspace();
    run(REGISTER, ws);
    writeScope(ws, 'a.mjs', 500);
    mkdirSync(join(ws.cwd, 'sub'));
    const nested = main(observeArgv(['--provenance', 'solo-construction', '--scope', 'a.mjs']),
      { cwd: join(ws.cwd, 'sub'), env: ws.env, now: clock });
    assert.equal(nested.code, 0, nested.stderr);
    assert.equal(readDelegationStore(ws.store).records[1].metric.numeratorBytes, 500,
      'the recorded scope names the same object from any cwd');

    const outside = join(TMP, `outside-${seq += 1}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'x.mjs'), 'x'.repeat(9));
    symlinkSync(outside, join(ws.cwd, 'away'));
    const escaping = run(observeArgv(['--provenance', 'solo-construction', '--scope', 'away/x.mjs']), ws);
    assert.equal(escaping.code, 1);
    assert.match(escaping.stderr, /leaves the repository/);
    assert.equal(readDelegationStore(ws.store).records.length, 2, 'nothing was written for the escaping scope');
  });

  it('observe refuses outside a git work tree even when the store override names a store', () => {
    const plain = plainDir();
    writeFileSync(join(plain.cwd, 'a.mjs'), 'x'.repeat(10));
    const r = main(observeArgv(['--provenance', 'solo-construction', '--scope', 'a.mjs']),
      { cwd: plain.cwd, env: plain.env, now: clock });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not inside a git work tree/);
  });

  it('an observation naming an unregistered wave refuses at the store, and nothing is written', () => {
    const ws = workspace();
    writeScope(ws, 'a.mjs', 10);
    const r = run(observeArgv(['--provenance', 'solo-construction', '--scope', 'a.mjs']), ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /UNREGISTERED wave "wave-a"/);
  });
});

// ── (3) aggregate — the named refusals ────────────────────────────────────────────────────────────

describe('aggregate refuses by name: absent pre-registration; an OPEN thread in scope; multiple waves without --wave', () => {
  // These two are asserted on the PURE computation, not through the CLI: the append path refuses a
  // record naming an unregistered wave, so the CLI's read-side audit now stops such a ledger before
  // the computation ever sees it. The guards stay because the pure function is the exported API a
  // later plan computes with, and it must refuse an unregistered wave on its own authority.
  it('a wave with no pre-registration record is never aggregated', () => {
    const r = aggregateDelegationWave([dispatchRecord('n1'), failureReturn('n1')], 'wave-a');
    assert.equal(r.ok, false);
    assert.match(r.reason, /wave "wave-a" carries NO pre-registration record/);
  });

  it('a registration that does not PRECEDE its wave refuses', () => {
    const r = aggregateDelegationWave([dispatchRecord('n1'), failureReturn('n1'), registration()], 'wave-a');
    assert.equal(r.ok, false);
    assert.match(r.reason, /carries a dispatch record BEFORE its pre-registration/);
  });

  // The read-side audit: the aggregate re-establishes legality by the STORE's own authority before
  // counting anything. Two dispatch records sharing a nonce parse as valid records and would be
  // walked as two threads — inflating n, and with it the PILOT label the whole wave exists to earn.
  it('a ledger the append path would have refused stops the computation, naming the line', () => {
    const ws = writeStore(workspace(), [registration(), dispatchRecord('n1'), dispatchRecord('n1', { timestamp: TS(6) })]);
    const r = run(['aggregate'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /line 3 carries a record the append path would have REFUSED/);
    assert.match(r.stderr, /refusing a duplicate dispatch: nonce "n1" already carries a dispatch/,
      "the store's own message travels verbatim");
  });

  it('an OPEN thread in scope stops the computation', () => {
    const ws = writeStore(workspace(), [registration(), dispatchRecord('n1')]);
    const r = run(['aggregate'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /thread "n1" \(class code\) is OPEN/);
  });

  it('a success return that is neither folded nor degraded is still OPEN', () => {
    const ws = writeStore(workspace(), [registration(), dispatchRecord('n1'), returnRecord('n1')]);
    assert.match(run(['aggregate'], ws).stderr, /is OPEN/);
  });

  it('several waves without --wave is AMBIGUOUS; --wave selects one; an unknown --wave refuses', () => {
    const ws = writeStore(workspace(), [registration(), registration({ waveId: 'wave-b', timestamp: TS(6) })]);
    assert.match(run(['aggregate'], ws).stderr, /several waves are present \(wave-a, wave-b\)/);
    assert.equal(run(['aggregate', '--wave', 'wave-b'], ws).code, 0);
    assert.match(run(['aggregate', '--wave', 'wave-z'], ws).stderr, /no record in the delegation store names the wave "wave-z"/);
    assert.deepEqual(wavesInStore(readDelegationStore(ws.store).records), ['wave-a', 'wave-b']);
  });

  it('an empty store carries no wave', () => {
    const ws = writeStore(workspace(), []);
    assert.match(run(['aggregate'], ws).stderr, /carries no wave/);
    assert.deepEqual(selectWave([], undefined), { ok: false, reason: selectWave([], undefined).reason });
  });

  it('a malformed line, an unreadable store, and no git tree each fail CLOSED', () => {
    const ws = writeStore(workspace(), [registration()]);
    writeFileSync(ws.store, `${JSON.stringify(registration())}\n{ not json\n`);
    assert.match(run(['aggregate'], ws).stderr, /carries 1 malformed line\(s\)/);

    const dirStore = workspace();
    mkdirSync(dirStore.store);
    assert.match(run(['aggregate'], dirStore).stderr, /not a regular file/);

    const noGit = plainDir();
    assert.match(main(['aggregate'], { cwd: noGit.cwd, env: {} }).stderr, /not inside a git work tree/);
  });

  // A pre-dispatch degrade opens NO nonce
  // thread, so counting it would silently widen `n` from terminal threads to attempts, and printing
  // it uncounted would leave a recorded refusal free. The computation refuses instead.
  it('a wave-scoped pre-dispatch degrade refuses the whole computation by name', () => {
    const ws = writeStore(workspace(), [registration(), degradeRecord(null), ...foldedThread('n1')]);
    const r = run(['aggregate'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carries a PRE-DISPATCH degrade/);
    assert.match(r.stderr, /opens no nonce thread/);
  });
});

// ── (4) aggregate — the D7 inclusion table ────────────────────────────────────────────────────────

describe('aggregate derives delegated L from terminal threads per the D7 inclusion table (every row tested at n=2/3/4)', () => {
  const summaryOf = (records) => {
    const r = aggregateDelegationWave(records, 'wave-a');
    assert.ok(r.ok, r.reason);
    return { report: r.report, code: r.report.classes[0] };
  };

  it('n=2 is below the registered minimum: acceptance is NOT computed (insufficient)', () => {
    const { report, code } = summaryOf([registration(), ...foldedThread('n1'), ...foldedThread('n2')]);
    assert.equal(code.n, 2);
    assert.equal(code.computed, false);
    assert.equal(code.meanL, 2);
    assert.match(renderAggregate(report), /NOT COMPUTED — n = 2 is below the registered minimum 3 \(insufficient\)/);
  });

  it('n=3 at the minimum: COMPUTED and labeled PILOT, with the thresholds compared', () => {
    const { report, code } = summaryOf([registration(), ...foldedThread('n1'), ...foldedThread('n2'), ...foldedThread('n3')]);
    assert.equal(code.n, 3);
    assert.equal(code.computed, true);
    assert.equal(code.meanL, 2);
    const out = renderAggregate(report);
    assert.match(out, /COMPUTED — PILOT evidence \(n = 3\)/);
    assert.match(out, /mean L = 2\.000 \(threshold 2\) — MET/);
    assert.match(out, /byte-weighted L = 2\.000 \(SECONDARY\)/);
    assert.match(out, /first pass = 3\/3 = 1\.000 \(threshold 2\/3\) — MET/);
  });

  it('n=4 above the minimum stays COMPUTED + PILOT, and a below-threshold mean reads NOT MET', () => {
    const thin = { metric: { ...returnRecord('x').metric, numeratorBytes: BUNDLE, components: [{ kind: 'modified', path: 'src/a.mjs', objectId: 'oid-a', bytes: BUNDLE }] } };
    const { report, code } = summaryOf([
      registration(), ...foldedThread('n1', thin), ...foldedThread('n2', thin),
      ...foldedThread('n3', thin), ...foldedThread('n4', thin),
    ]);
    assert.equal(code.n, 4);
    assert.equal(code.computed, true);
    assert.equal(code.meanL, 1);
    const out = renderAggregate(report);
    assert.match(out, /COMPUTED — PILOT evidence \(n = 4\)/);
    assert.match(out, /mean L = 1\.000 \(threshold 2\) — NOT MET/);
  });

  it('a folded success whose metric is INELIGIBLE is excluded from the mean and from n, and still counts in the first-pass rate', () => {
    const zeroByte = {
      metric: {
        numeratorBytes: 0, denominatorBytes: BUNDLE, components: [],
        provenance: 'wrapper-git', eligible: false, ineligibleReason: 'zero-byte-proxy',
      },
    };
    const { report, code } = summaryOf([registration(), ...foldedThread('n1'), ...foldedThread('n2', zeroByte)]);
    assert.equal(code.n, 1);
    assert.equal(code.firstPassNum, 2);
    assert.equal(code.firstPassDen, 2);
    assert.match(renderAggregate(report), /n2 · retry 0 · folded success, EXCLUDED from the mean \(zero-byte-proxy\)/);
  });

  it('a folded success whose metric is SELF-REPORTED is excluded too — acceptance aggregates wrapper-git only', () => {
    const selfReported = { metric: { ...returnRecord('x').metric, provenance: 'self-reported' } };
    const { report, code } = summaryOf([registration(), ...foldedThread('n1', selfReported)]);
    assert.equal(code.n, 0);
    assert.equal(code.meanL, null);
    assert.equal(code.byteWeightedL, null);
    assert.match(renderAggregate(report), /EXCLUDED from the mean \(provenance self-reported\)/);
  });

  it('a failure-terminal thread and a degrade-closed thread are IN n at L = 0 and are not first passes', () => {
    const accepted = returnRecord('n3');
    const records = [
      registration(),
      dispatchRecord('n1'), failureReturn('n1'),
      dispatchRecord('n2', { timestamp: TS(7) }), degradeRecord('n2'),
      dispatchRecord('n3', { timestamp: TS(8) }), accepted, foldRecord(accepted),
    ];
    const { report, code } = summaryOf(records);
    assert.equal(code.n, 3);
    assert.equal(code.meanL, 2 / 3);
    assert.equal(code.firstPassNum, 1);
    assert.equal(code.firstPassDen, 3);
    const out = renderAggregate(report);
    assert.match(out, /n1 · retry 0 · failure-terminal \(transport-failure\) · L = 0\.000/);
    assert.match(out, /n2 · retry 0 · degrade-closed · L = 0\.000/);
    assert.match(out, /first pass = 1\/3 = 0\.333 \(threshold 2\/3\) — NOT MET/);
  });

  // D7 grants a metric contribution to a folded SUCCESS
  // only. A folded acceptance-failure is the orchestrator paying for the same work twice, so its
  // bytes are not leverage — it takes the failure row, and the bytes it did consume stay visible in
  // the byte-weighted secondary.
  it('a folded acceptance-failure is IN n at L = 0 and is never a first pass', () => {
    const acceptanceFailure = returnRecord('n1', { outcome: 'acceptance-failure', exitStatus: 1 });
    const { report, code } = summaryOf([registration(), dispatchRecord('n1'), acceptanceFailure, foldRecord(acceptanceFailure)]);
    assert.equal(code.n, 1);
    assert.equal(code.meanL, 0, 'a fold-fix is never leverage');
    assert.equal(code.firstPassNum, 0);
    assert.equal(code.firstPassDen, 1);
    assert.equal(code.threads[0].denominatorBytes, BUNDLE);
    assert.equal(code.byteWeightedL, 0);
    assert.match(renderAggregate(report), /n1 · retry 0 · folded acceptance-failure/);
  });

  it('a degrade closing a thread that DID return keeps the return\'s denominator in the byte-weighted secondary', () => {
    const acceptanceFailure = returnRecord('n1', { outcome: 'acceptance-failure', exitStatus: 1 });
    const { code } = summaryOf([registration(), dispatchRecord('n1'), acceptanceFailure, degradeRecord('n1')]);
    assert.equal(code.n, 1);
    assert.equal(code.threads[0].denominatorBytes, BUNDLE);
    assert.equal(code.byteWeightedL, 0);
  });

  it('a RETRY thread counts in n but never in the first-pass denominator (the rate is per chain)', () => {
    const origin = [dispatchRecord('n1'), failureReturn('n1')];
    const retry = foldedThread('n2', {}, { retryOf: 'n1', retryIndex: 1, timestamp: TS(9) });
    const { code } = summaryOf([registration(), ...origin, ...retry]);
    assert.equal(code.n, 2);
    assert.equal(code.firstPassDen, 1);
    assert.equal(code.firstPassNum, 0);
  });

  // The first-pass threshold once cross-multiplied in Number, so a
  // product past the safe range rounded and reported MET for a rate that is not met. The pair below
  // is exactly that boundary — 2 × 2^52 = 2^53 versus 3002399751580331 × 3 = 2^53 + 1, which Number
  // cannot represent and rounds DOWN to 2^53, making the comparison read equal.
  it('the first-pass threshold comparison is EXACT at the safe-integer boundary', () => {
    const wave = registration({ minPerClass: 1, firstPassNum: 3002399751580331, firstPassDen: 2 ** 52 });
    const failing = [dispatchRecord('n3', { timestamp: TS(7) }), failureReturn('n3')];
    const { report } = summaryOf([wave, ...foldedThread('n1'), ...foldedThread('n2', {}, { timestamp: TS(6) }), ...failing]);
    const out = renderAggregate(report);
    assert.match(out, /first pass = 2\/3 = 0\.667/);
    assert.match(out, /first pass = 2\/3 = 0\.667 \(threshold 3002399751580331\/4503599627370496\) — NOT MET/,
      'a rounded Number product reads MET here; the exact comparison does not');
  });

  it('a registered class with no thread at all reports insufficient with n = 0', () => {
    const { report, code } = summaryOf([registration({ stepClasses: ['code', 'extraction'] })]);
    assert.equal(code.n, 0);
    assert.equal(code.byteWeightedL, null);
    const out = renderAggregate(report);
    assert.match(out, /class "extraction" — 0 delegated thread\(s\)/);
    assert.match(out, /acceptance, class "extraction": NOT COMPUTED/);
  });
});

// ── (5) aggregate — observations are context, never the acceptance number ─────────────────────────

describe('aggregate excludes self-reported observations from acceptance and prints them as observational', () => {
  it('a self-reported observation prints EXCLUDED, a solo one prints as the baseline, and neither moves n', () => {
    const selfReported = observationRecord({
      timestamp: TS(6),
      metric: {
        numeratorBytes: 900, denominatorBytes: 300,
        components: [{ kind: 'enumerated', path: 'docs/plans/x.md', objectId: 'oid-x', bytes: 900 }],
        provenance: 'self-reported', eligible: true, ineligibleReason: null,
      },
    });
    const ws = writeStore(workspace(), [registration(), observationRecord(), selfReported, ...foldedThread('n1')]);
    const r = run(['aggregate'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /observations — recorded context, never part of the acceptance number/);
    assert.match(r.stdout, /solo-construction · class code · plan delegation-1-contract-ledger-baseline phase 3 · L = 1\.000 \(400 B \/ 400 B\) · baseline/);
    assert.match(r.stdout, /self-reported .* · observational only, EXCLUDED from acceptance/);
    assert.match(r.stdout, /class "code" — 1 delegated thread\(s\)/);
    assert.match(r.stdout, /NOT COMPUTED — n = 1 is below the registered minimum 3/);
  });

  it('an INELIGIBLE observation prints its named reason instead of a ratio', () => {
    const ineligible = observationRecord({
      metric: {
        numeratorBytes: 0, denominatorBytes: 0, components: [],
        provenance: 'solo-construction', eligible: false, ineligibleReason: 'zero-denominator',
      },
    });
    const ws = writeStore(workspace(), [registration(), ineligible]);
    assert.match(run(['aggregate'], ws).stdout, /L = n\/a — INELIGIBLE \(zero-denominator\)/);
  });

  it('a wave with no observation at all renders (none)', () => {
    const ws = writeStore(workspace(), [registration()]);
    const r = run(['aggregate'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /observations — recorded context[\s\S]*\(none\)/);
    assert.match(r.stdout, /registered .* — classes code · pairing key stepClass · minimum 3 per class · mean L >= 2 · first pass >= 2\/3/);
  });
});

// ── (6) the writer verbs: open · return · fold · degrade ──────────────────────────────────────────

// A real repository with ONE commit (the producer refuses an unborn branch — there is no pre-image
// to attribute delegated bytes against) and its ledger in the git dir, exactly where production puts
// it. That placement is load-bearing for these tests: the exec receipt and its report are minted
// BESIDE the ledger, so a store at the work-tree root would make every artifact an untracked file the
// producer then counts into the numerator it is supposed to be measuring.
const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const repo = () => {
  const cwd = join(TMP, `repo-${seq += 1}`);
  mkdirSync(cwd, { recursive: true });
  gitIn(cwd, 'init', '-q', '-b', 'main');
  gitIn(cwd, 'config', 'user.email', 'coder-tools@proton.me');
  gitIn(cwd, 'config', 'user.name', 'coder-tool');
  writeFileSync(join(cwd, 'base.txt'), 'base\n');
  gitIn(cwd, 'add', '-A');
  gitIn(cwd, 'commit', '-q', '-m', 'init');
  const dir = join(cwd, '.git');
  const store = join(dir, DELEGATION_STORE_BASENAME);
  return { cwd, dir, store, env: { AW_DELEGATION_STORE: store } };
};

// The contract file lives OUTSIDE the repository on purpose: written inside it, it would be an
// untracked path and every `open` would record a DIRTY baseline, so the eligible lane could never be
// exercised at all.
const externalContract = (contract) => {
  const path = join(TMP, `contract-${seq += 1}.md`);
  writeFileSync(path, `# a sub-task\n\n\`\`\`aw-dispatch-contract\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`);
  return path;
};

const REGISTER_WAVE = ['register', '--wave', 'wave-a', '--step-classes', 'code,extraction',
  '--pairing-key', 'stepClass', '--min-per-class', '1', '--mean-l-threshold', '1',
  '--first-pass-num', '0', '--first-pass-den', '1'];

const CAP_S = 600;
const GRACE_S = 15;

const openArgv = (contractPath, over = []) => ['open', '--contract', contractPath, '--wave', 'wave-a',
  '--backend', 'codex', '--rationale', 'a bounded sub-task', '--wrapper-cap-s', String(CAP_S),
  '--kill-grace-s', String(GRACE_S), ...over];

const recordsOf = (ws) => {
  const store = readDelegationStore(ws.store);
  assert.equal(store.malformed, 0, store.malformedReasons.join('; '));
  return store.records;
};
const lastRecord = (ws) => recordsOf(ws).at(-1);
const kindOf = (ws, kind) => recordsOf(ws).find((r) => r.kind === kind);

const plus = (instant, seconds) => new Date(Date.parse(instant) + seconds * 1000).toISOString();
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The wrapper's own artifacts, minted the way Phase 3's bash will: the report FIRST, the receipt
// LAST, both named from {backend, nonce} beside the ledger.
const REPORT_TEXT = 'the delegate wrote delegated.txt and says so here\n';

const mintArtifacts = (ws, { dispatch, contract, report = REPORT_TEXT, state = 'terminal', receipt = {}, backend = 'codex' }) => {
  const bytes = report === null ? null : Buffer.from(report, 'utf8');
  if (bytes !== null) writeFileSync(join(ws.dir, execReportBasename(backend, dispatch.nonce)), bytes);
  const terminal = state === 'terminal';
  const artifact = {
    schema: EXEC_RECEIPT_SCHEMA_VERSION,
    kind: EXEC_RECEIPT_KIND,
    state,
    backend,
    nonce: dispatch.nonce,
    owner: 'owner-token-1',
    contractDigest: contractDigest(contract),
    wrapperVersion: '3.4.1',
    posture: { model: 'gpt-5-codex', effort: 'high', tier: 'priority' },
    capS: CAP_S,
    killGraceS: GRACE_S,
    sessionId: terminal ? 'sess-1' : null,
    exitStatus: terminal ? 0 : null,
    outcome: terminal ? 'success' : null,
    reportDigest: terminal && bytes !== null ? digestOf(bytes) : null,
    reportLength: terminal && bytes !== null ? bytes.length : null,
    timestamp: plus(dispatch.timestamp, 60),
    ...receipt,
  };
  writeFileSync(join(ws.dir, execReceiptBasename(backend, dispatch.nonce)), JSON.stringify(artifact));
  return artifact;
};

// The whole lane up to the return: register → open → the delegate writes a file → the wrapper mints.
const DELEGATED_BYTES = 'the delegate\'s work\n';
const laneToReturn = (over = {}) => {
  const ws = repo();
  const contract = { ...CONTRACT, ...over.contract };
  assert.equal(run(REGISTER_WAVE, ws).code, 0);
  const path = externalContract(contract);
  const opened = run(openArgv(path, over.openFlags ?? []), ws);
  assert.equal(opened.code, 0, opened.stderr);
  const dispatch = kindOf(ws, 'dispatch');
  writeFileSync(join(ws.cwd, 'delegated.txt'), DELEGATED_BYTES);
  const artifact = mintArtifacts(ws, { dispatch, contract, ...over.artifacts });
  return { ws, contract, contractPath: path, dispatch, artifact };
};

describe('open mints the dispatch record from the contract header and enforces the D8 floor', () => {
  it('open copies every mint-time field from the header and refuses a hand-supplied disagreement', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    const path = externalContract(CONTRACT);
    const r = run(openArgv(path), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /thread "p3-a1" opened in wave "wave-a"/);
    assert.match(r.stdout, /baseline CLEAN/);
    const record = kindOf(ws, 'dispatch');
    assert.equal(record.nonce, CONTRACT.nonce);
    assert.equal(record.stepClass, CONTRACT.stepClass);
    assert.equal(record.deadlineS, CONTRACT.deadlineS);
    assert.equal(record.retryIndex, CONTRACT.retry.index);
    assert.equal(record.retryCap, CONTRACT.retry.cap);
    assert.deepEqual(record.vehicle, CONTRACT.vehicle);
    assert.equal(record.contractDigest, contractDigest(CONTRACT), 'contractDigest binds the copy');
    assert.equal(record.backend, 'codex');
    assert.equal(record.retryOf, null);
    assert.equal(record.baselineClean, true);

    // The ONE mint-time field a caller CAN contradict: retryOf rides a flag while retryIndex is
    // copied, so the two disagree in both directions and the record vocabulary names it.
    const stray = run(openArgv(externalContract({ ...CONTRACT, nonce: 'p3-a2' }), ['--retry-of', 'p3-a1']), ws);
    assert.equal(stray.code, 1);
    assert.match(stray.stderr, /retryIndex 0 is the FIRST attempt and carries retryOf null/);
    const orphan = run(openArgv(externalContract({ ...CONTRACT, nonce: 'p3-a3', retry: { cap: 2, index: 1 } })), ws);
    assert.equal(orphan.code, 1);
    assert.match(orphan.stderr, /retryIndex 1 requires retryOf/);
    assert.equal(recordsOf(ws).filter((r2) => r2.kind === 'dispatch').length, 1, 'neither disagreement was written');
  });

  it('open refuses a contract whose deadlineS is below the wrapper cap plus the kill grace, and accepts it exactly AT the floor', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    const below = run(openArgv(externalContract({ ...CONTRACT, deadlineS: CAP_S + GRACE_S - 1 })), ws);
    assert.equal(below.code, 1);
    assert.match(below.stderr, /deadlineS 614 is below the wrapper cap 600 plus the kill grace 15 \(615\)/);
    assert.match(below.stderr, /nothing was written/);
    assert.equal(recordsOf(ws).length, 1, 'only the registration is in the ledger');

    const atFloor = run(openArgv(externalContract({ ...CONTRACT, nonce: 'floor-1', deadlineS: CAP_S + GRACE_S })), ws);
    assert.equal(atFloor.code, 0, atFloor.stderr);
    assert.equal(kindOf(ws, 'dispatch').deadlineS, CAP_S + GRACE_S);
  });

  it('open refuses a wrapper cap below 1 and a non-integer floor operand as USAGE, never a record', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    const path = externalContract(CONTRACT);
    assert.match(run(['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
      '--rationale', 'x', '--wrapper-cap-s', '0', '--kill-grace-s', '15'], ws).stderr, /--wrapper-cap-s must be at least 1/);
    assert.match(run(['open', '--contract', path, '--wave', 'wave-a', '--backend', 'codex',
      '--rationale', 'x', '--wrapper-cap-s', 'ten', '--kill-grace-s', '15'], ws).stderr, /--wrapper-cap-s must be a non-negative decimal integer/);
    assert.match(run(openArgv(path, ['--frobnicate', 'x']), ws).stderr, /unknown argument: --frobnicate/);
    assert.equal(recordsOf(ws).length, 1);
  });

  it('open refuses an unreadable contract file and a FORM-violating header, naming the field', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    const missing = run(openArgv(join(TMP, 'nowhere.md')), ws);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /cannot read /);
    const bad = run(openArgv(externalContract({ ...CONTRACT, stepClass: 'freestyle' })), ws);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /FORM VIOLATION[\s\S]*stepClass/);
    assert.equal(recordsOf(ws).length, 1);
  });

  // The baseline is probed before the fingerprint precisely so this answer is a named refusal from
  // the verb rather than a STOP thrown by the tree-digest contract one module down.
  it('open outside a git work tree refuses by name, even with a store override naming a ledger', () => {
    const plain = plainDir();
    const r = main(openArgv(externalContract(CONTRACT)), { cwd: plain.cwd, env: plain.env, now: clock });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the baseline is undecidable/);
    assert.match(r.stderr, /nothing was written/);
  });

  it('open records baselineClean false on a dirty tree, and the resulting return may not claim eligible', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    writeFileSync(join(ws.cwd, 'stray.txt'), 'the orchestrator left this behind\n');
    const opened = run(openArgv(externalContract(CONTRACT)), ws);
    assert.equal(opened.code, 0, opened.stderr);
    assert.match(opened.stdout, /baseline DIRTY — the return will be metric-INELIGIBLE \(dirty-baseline\)/);
    const dispatch = kindOf(ws, 'dispatch');
    assert.equal(dispatch.baselineClean, false);

    writeFileSync(join(ws.cwd, 'delegated.txt'), DELEGATED_BYTES);
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    const returned = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(returned.code, 0, returned.stderr);
    assert.match(returned.stdout, /INELIGIBLE \(dirty-baseline\)/);
    const record = kindOf(ws, 'return');
    assert.equal(record.metric.eligible, false);
    assert.equal(record.metric.ineligibleReason, 'dirty-baseline');
    assert.ok(record.metric.numeratorBytes > 0, 'the bytes are still counted and recorded');
  });

  it('open surfaces the store\'s retry refusals verbatim — one case per rule', () => {
    const priorContract = { ...CONTRACT, nonce: 'origin-1' };
    const retryContract = { ...CONTRACT, nonce: 'retry-1', retry: { cap: 2, index: 1 } };
    // The origin thread is hand-written: reaching a CLOSED failure thread through the CLI would cost
    // a full dispatch cycle per rule, and every rule under test belongs to the store, not to that cycle.
    const closedOrigin = (over = {}) => [
      registration({ waveId: 'wave-a', stepClasses: ['code', 'extraction'], minPerClass: 1, meanLThreshold: 1, firstPassNum: 0, firstPassDen: 1 }),
      dispatchRecord('origin-1', { retryCap: 2, contractDigest: contractDigest(priorContract), ...over }),
      failureReturn('origin-1', { contractDigest: contractDigest(priorContract) }),
    ];
    const openRetry = (records, contract = retryContract, flags = []) => {
      const ws = writeStore(repo(), records);
      return run(openArgv(externalContract(contract), ['--retry-of', 'origin-1', ...flags]), ws);
    };

    const second = openRetry([...closedOrigin(), dispatchRecord('taken-1', { retryOf: 'origin-1', retryIndex: 1, timestamp: TS(6) })]);
    assert.match(second.stderr, /already has the retry successor "taken-1"/);

    const capped = openRetry(closedOrigin({ retryCap: 0 }));
    assert.match(capped.stderr, /exceeds the retryCap 0 recorded on the thread's ORIGIN dispatch/);

    const crossWave = writeStore(repo(), [
      ...closedOrigin(),
      registration({ waveId: 'wave-b', stepClasses: ['code'], minPerClass: 1, meanLThreshold: 1, firstPassNum: 0, firstPassDen: 1, timestamp: TS(7) }),
    ]);
    const wave = run(['open', '--contract', externalContract(retryContract), '--wave', 'wave-b',
      '--backend', 'codex', '--rationale', 'a retry', '--wrapper-cap-s', String(CAP_S),
      '--kill-grace-s', String(GRACE_S), '--retry-of', 'origin-1'], crossWave);
    assert.match(wave.stderr, /a retry stays in its origin's wave/);

    const crossClass = openRetry(closedOrigin(), { ...retryContract, stepClass: 'extraction' });
    assert.match(crossClass.stderr, /the pairing key is the step class/);

    // The rule under test compares the retry's contractDigest with its origin's. A header carries its
    // own nonce, so two real contracts never share a digest — the origin's recorded digest is set to
    // the retry's here so the STORE's rule is the thing being exercised, not the arithmetic that
    // makes it unreachable through this door today.
    const unchanged = writeStore(repo(), [
      registration({ waveId: 'wave-a', stepClasses: ['code', 'extraction'], minPerClass: 1, meanLThreshold: 1, firstPassNum: 0, firstPassDen: 1 }),
      dispatchRecord('origin-1', { retryCap: 2, contractDigest: contractDigest(retryContract) }),
      returnRecord('origin-1', { outcome: 'contract-refusal', exitStatus: 3, sessionId: null, contractDigest: contractDigest(retryContract) }),
    ]);
    const same = run(openArgv(externalContract(retryContract), ['--retry-of', 'origin-1']), unchanged);
    assert.match(same.stderr, /must carry a DIFFERENT contractDigest/);

    // The same retry against a clean origin LANDS — so every refusal above is the rule it names,
    // never the shape of the fixture they share.
    const ok = openRetry(closedOrigin());
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /thread "retry-1" opened in wave "wave-a"/);
  });
});

describe('return absorbs ONLY a terminal receipt bound to the dispatch it answers', () => {
  it('the happy lane: the return records the produced bytes, the framed bundle and an eligible metric', () => {
    const { ws, dispatch } = laneToReturn();
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /thread "p3-a1" answered — outcome success/);
    assert.match(r.stdout, /session sess-1/);
    const record = kindOf(ws, 'return');
    assert.equal(record.role, 'execute');
    assert.equal(record.backend, dispatch.backend);
    assert.equal(record.contractDigest, dispatch.contractDigest);
    assert.equal(record.preTreeDigest, dispatch.preTreeDigest);
    assert.equal(record.diffDigest, record.postTreeDigest, 'the payload IS the diff, so its digest IS the fingerprint');
    assert.equal(record.reportLength, REPORT_TEXT.length);
    assert.equal(record.reportDigest, digestOf(Buffer.from(REPORT_TEXT, 'utf8')));
    assert.equal(record.bundleLength, expectedBundleLength(record.diffLength, record.reportLength));
    assert.equal(record.metric.denominatorBytes, record.bundleLength);
    assert.equal(record.metric.provenance, 'wrapper-git');
    assert.equal(record.metric.eligible, true);
    assert.equal(record.wrapperVersion, '3.4.1');
    assert.deepEqual(record.posture, { model: 'gpt-5-codex', effort: 'high', tier: 'priority' });
    const delegated = record.metric.components.find((c) => c.path === 'delegated.txt');
    assert.deepEqual(delegated, { kind: 'new', path: 'delegated.txt', objectId: 'new:delegated.txt', bytes: DELEGATED_BYTES.length });
    assert.equal(record.metric.numeratorBytes, record.metric.components.reduce((s, c) => s + c.bytes, 0));
  });

  it('return refuses a RESERVED receipt as a SUPERVISION question, not a timeout', () => {
    const { ws } = laneToReturn({ artifacts: { state: 'reserved', report: null } });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /still RESERVED/);
    assert.match(r.stderr, /SUPERVISION question, not a timeout/);
    assert.match(r.stderr, /--no-receipt --exit-status <n> --outcome <o>/);
    assert.equal(kindOf(ws, 'return'), undefined, 'nothing was written');
  });

  it('return refuses a receipt whose {backend, nonce} body disagrees with the dispatch it was found under', () => {
    const { ws } = laneToReturn({ artifacts: { receipt: { nonce: 'someone-else' } } });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /names \{backend "codex", nonce "someone-else"\}/);
    assert.match(r.stderr, /not by the filename it was found under/);
  });

  it('return refuses a receipt whose independently computed contractDigest is not the dispatch\'s', () => {
    const { ws } = laneToReturn({ artifacts: { receipt: { contractDigest: contractDigest({ ...CONTRACT, scope: 'a different job entirely' }) } } });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /executed a DIFFERENT contract than the one this thread opened/);
  });

  it('return refuses a receipt whose capS plus killGraceS exceeds the dispatch\'s deadlineS', () => {
    const { ws } = laneToReturn({ artifacts: { receipt: { capS: CONTRACT.deadlineS, killGraceS: GRACE_S } } });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could outlive the deadline this thread was opened under/);
  });

  // The window is closed at BOTH ends. Only the upper bound existed at first, so a receipt minted
  // BEFORE the dispatch was absorbed as its answer — and artifact names are a function of
  // {backend, nonce} alone, so an older artifact for the same pair belongs to another thread.
  it('return refuses a receipt stamped BEFORE the dispatch was opened, and accepts both boundaries', () => {
    const early = laneToReturn({ artifacts: { receipt: { timestamp: TS(0) } } });
    const r = run(['return', '--nonce', CONTRACT.nonce], early.ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /BEFORE this dispatch was opened/);
    assert.match(r.stderr, /cannot answer a dispatch that did not exist yet/);
    assert.equal(kindOf(early.ws, 'return'), undefined);

    const atOpen = laneToReturn();
    const opened = kindOf(atOpen.ws, 'dispatch').timestamp;
    mintArtifacts(atOpen.ws, { dispatch: kindOf(atOpen.ws, 'dispatch'), contract: CONTRACT, receipt: { timestamp: opened } });
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], atOpen.ws).code, 0, 'the lower boundary is INCLUSIVE');

    const atDeadline = laneToReturn();
    const d = kindOf(atDeadline.ws, 'dispatch');
    mintArtifacts(atDeadline.ws, { dispatch: d, contract: CONTRACT, receipt: { timestamp: plus(d.timestamp, d.deadlineS) } });
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], atDeadline.ws).code, 0, 'the upper boundary is INCLUSIVE');
  });

  it('return refuses a receipt stamped past the dispatch\'s ABSOLUTE deadline', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    writeFileSync(join(ws.cwd, 'delegated.txt'), DELEGATED_BYTES);
    mintArtifacts(ws, { dispatch, contract: CONTRACT, receipt: { timestamp: plus(dispatch.timestamp, CONTRACT.deadlineS + 1) } });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /a LATE return/);
    assert.match(r.stderr, /measured from the dispatch record, not from whenever the wrapper happened to start/);
  });

  it('return refuses a report whose digest or length contradicts the receipt, and a missing one by name', () => {
    const drifted = laneToReturn();
    writeFileSync(join(drifted.ws.dir, execReportBasename('codex', CONTRACT.nonce)), 'the report was rewritten after the run\n');
    const contradicted = run(['return', '--nonce', CONTRACT.nonce], drifted.ws);
    assert.equal(contradicted.code, 1);
    assert.match(contradicted.stderr, /contradicts the terminal receipt/);

    const absent = laneToReturn({ artifacts: { report: null, receipt: { reportDigest: digestOf(Buffer.alloc(0)), reportLength: 0 } } });
    const r = run(['return', '--nonce', CONTRACT.nonce], absent.ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no report artifact is at /);
    assert.match(r.stderr, /published BEFORE the receipt replaces the reservation/);
  });

  it('return refuses an unreadable or foreign artifact by class, and an absent receipt names both recoveries', () => {
    const foreign = laneToReturn();
    rmSync(join(foreign.ws.dir, execReceiptBasename('codex', CONTRACT.nonce)));
    mkdirSync(join(foreign.ws.dir, execReceiptBasename('codex', CONTRACT.nonce)));
    assert.match(run(['return', '--nonce', CONTRACT.nonce], foreign.ws).stderr, /is a directory, not a regular file/);

    const junk = laneToReturn();
    writeFileSync(join(junk.ws.dir, execReceiptBasename('codex', CONTRACT.nonce)), '{ not json');
    assert.match(run(['return', '--nonce', CONTRACT.nonce], junk.ws).stderr, /is REFUSED — exec receipt: the artifact is not valid JSON/);

    // The family's reader decodes FATALLY, so a report that is not valid UTF-8 is a failed probe,
    // never a repaired string and never an absent report.
    const raw = laneToReturn();
    writeFileSync(join(raw.ws.dir, execReportBasename('codex', CONTRACT.nonce)), Buffer.from([0xff, 0xfe, 0x00]));
    assert.match(run(['return', '--nonce', CONTRACT.nonce], raw.ws).stderr, /a FAILED probe, not an absent one/);

    // An ABSENT artifact names ONE recovery, and it is not --no-receipt: that lane reads the SAME
    // path, so suggesting it would send the operator to a refusal that is guaranteed to repeat.
    const none = laneToReturn({ artifacts: { report: null } });
    rmSync(join(none.ws.dir, execReceiptBasename('codex', CONTRACT.nonce)));
    const r = run(['return', '--nonce', CONTRACT.nonce], none.ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no exec receipt at /);
    assert.match(r.stderr, /--no-receipt reads the same path and would refuse the same way/);
    assert.match(r.stderr, /close the thread with degrade/);
    assert.equal(run(['return', '--nonce', CONTRACT.nonce, '--no-receipt', '--exit-status', '1', '--outcome', 'store-failure'], none.ws).stderr,
      r.stderr, 'the --no-receipt lane refuses the absent artifact identically — which is why the message never sends anyone there');
  });

  it('return refuses a tree whose change set is concealed behind an index bit', () => {
    const { ws } = laneToReturn();
    gitIn(ws.cwd, 'update-index', '--skip-worktree', 'base.txt');
    writeFileSync(join(ws.cwd, 'base.txt'), 'the delegate changed this behind the index bit\n');
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carry a tag other than "H" \(S base\.txt\)/);
    assert.equal(kindOf(ws, 'return'), undefined, 'nothing was written');
  });

  // The shapes a UNION of the staged and unstaged name lists let through — each a path whose visible
  // state on ONE side masked its hidden state on the other, so the producer would have counted a
  // stale image without a word. Both were found independently by the review backends.
  it('a path VISIBLE on one side never masks its hidden state on the other (the comparison is per SIDE)', () => {
    // A config-hidden gitlink STANDING BESIDE an ordinary staged file: the boolean arm this replaced
    // ("the index is dirty and the plain staged list is empty") could never see this one.
    const beside = laneToReturn();
    const head = gitIn(beside.ws.cwd, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(beside.ws.cwd, 'sub'));
    gitIn(beside.ws.cwd, 'add', 'delegated.txt');
    gitIn(beside.ws.cwd, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    gitIn(beside.ws.cwd, 'config', 'diff.ignoreSubmodules', 'all');
    const g = run(['return', '--nonce', CONTRACT.nonce], beside.ws);
    assert.equal(g.code, 1);
    assert.match(g.stderr, /staged: sub/);
    assert.equal(kindOf(beside.ws, 'return'), undefined);

    // …and the UNSTAGED side of the same axis: a COMMITTED gitlink whose worktree directory is gone,
    // with the plain diff configured blind to it. The staged side is clean here, so this shape is the
    // one a staged-only probe would miss.
    const unstaged = repo();
    const base = gitIn(unstaged.cwd, 'rev-parse', 'HEAD').trim();
    gitIn(unstaged.cwd, 'update-index', '--add', '--cacheinfo', `160000,${base},sub`);
    gitIn(unstaged.cwd, 'commit', '-qm', 'a submodule pointer');
    gitIn(unstaged.cwd, 'config', 'diff.ignoreSubmodules', 'all');
    const guard = engine.hiddenFromPlainDiff(unstaged.cwd);
    assert.equal(guard.ok, false);
    assert.match(guard.reason, /unstaged: sub/);
  });

  it('return refuses over a thread that was never opened, and over a semantically illegal ledger prefix', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    assert.match(run(['return', '--nonce', 'never-opened'], ws).stderr, /no dispatch for nonce "never-opened" is in the store/);

    const corrupt = writeStore(repo(), [registration(), dispatchRecord('n1'), dispatchRecord('n1', { timestamp: TS(6) })]);
    const r = run(['return', '--nonce', 'n1'], corrupt);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /line 3 carries a record the append path would have REFUSED/);
    assert.match(r.stderr, /refusing a duplicate dispatch/);
  });

  it('the outcome override form is CLOSED — a wrapper outcome stays itself or becomes an orchestrator judgment', () => {
    assert.deepEqual(
      [...engine.ORCHESTRATOR_OUTCOMES].sort(),
      RETURN_OUTCOMES.filter((o) => !['success', 'transport-failure', 'missing-identity'].includes(o)).sort(),
      'the orchestrator-only set is exactly the outcomes no wrapper can prove',
    );
    assert.deepEqual(
      [...engine.allowedRecordedOutcomes('transport-failure')].sort(),
      ['transport-failure', ...engine.ORCHESTRATOR_OUTCOMES].sort(),
    );

    const kept = laneToReturn();
    assert.equal(run(['return', '--nonce', CONTRACT.nonce, '--outcome', 'success'], kept.ws).code, 0);
    assert.equal(kindOf(kept.ws, 'return').outcome, 'success');

    const judged = laneToReturn();
    const graded = run(['return', '--nonce', CONTRACT.nonce, '--outcome', 'acceptance-failure'], judged.ws);
    assert.equal(graded.code, 0, graded.stderr);
    assert.equal(kindOf(judged.ws, 'return').outcome, 'acceptance-failure');

    const failed = laneToReturn({ artifacts: { receipt: { outcome: 'transport-failure', exitStatus: 137, sessionId: null } } });
    const refused = run(['return', '--nonce', CONTRACT.nonce, '--outcome', 'contract-refusal'], failed.ws);
    assert.equal(refused.code, 0, refused.stderr);
    assert.equal(kindOf(failed.ws, 'return').outcome, 'contract-refusal');

    const lied = laneToReturn({ artifacts: { receipt: { outcome: 'transport-failure', exitStatus: 1, sessionId: null } } });
    const claim = run(['return', '--nonce', CONTRACT.nonce, '--outcome', 'success'], lied.ws);
    assert.equal(claim.code, 2);
    assert.match(claim.stderr, /"success" is recordable only from a receipt that already says success/);

    const sideways = laneToReturn();
    assert.match(run(['return', '--nonce', CONTRACT.nonce, '--outcome', 'transport-failure'], sideways.ws).stderr,
      /may not be recorded over a receipt that says "success"/);
    assert.match(run(['return', '--nonce', CONTRACT.nonce, '--outcome', 'frobnicated'], sideways.ws).stderr,
      /--outcome must be one of success \| transport-failure/);
    assert.equal(kindOf(sideways.ws, 'return'), undefined);
  });

  it('return --no-receipt sources wrapperVersion and posture from the RESERVATION and records an honest zero report', () => {
    const { ws } = laneToReturn({ artifacts: { state: 'reserved', report: null } });
    const r = run(['return', '--nonce', CONTRACT.nonce, '--no-receipt', '--exit-status', '137', '--outcome', 'transport-failure'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /absorbed from the RESERVATION, --no-receipt/);
    assert.match(r.stdout, /INELIGIBLE \(empty-report\)/);
    const record = kindOf(ws, 'return');
    assert.equal(record.outcome, 'transport-failure');
    assert.equal(record.exitStatus, 137);
    assert.equal(record.sessionId, null);
    assert.equal(record.wrapperVersion, '3.4.1', 'never hand-typed — the reservation knew it pre-spend');
    assert.deepEqual(record.posture, { model: 'gpt-5-codex', effort: 'high', tier: 'priority' });
    assert.equal(record.reportLength, 0);
    assert.equal(record.metric.ineligibleReason, 'empty-report');
    assert.ok(record.metric.numeratorBytes > 0, 'the bytes the delegate did write are still counted');
  });

  // The recovery lane is decided by the ARTIFACT, not by the caller: over a terminal receipt it would
  // let a hand-stated outcome overwrite an exit status, a session id and a report digest the run
  // actually proved, and skip the report check that guards them — a recorded lie built out of a
  // recovery lane.
  it('return --no-receipt absorbs a RESERVATION only — over a TERMINAL receipt it refuses', () => {
    const { ws } = laneToReturn();
    const r = run(['return', '--nonce', CONTRACT.nonce, '--no-receipt', '--exit-status', '137', '--outcome', 'transport-failure'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--no-receipt absorbs a RESERVATION, and the artifact at .* is TERMINAL/);
    assert.match(r.stderr, /discard proven facts and skip the report check/);
    assert.equal(kindOf(ws, 'return'), undefined, 'nothing was written');
    // …and the ordinary lane still absorbs the very same artifact.
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], ws).code, 0);
    assert.equal(kindOf(ws, 'return').outcome, 'success');
  });

  // The eligibility rule names the DIFF first, so an absent report over an unchanged tree is
  // `no-op-diff`, not `empty-report`. Both names are honest; only one is correct per tree.
  it('a --no-receipt return over an UNCHANGED tree is ineligible by no-op-diff, not empty-report', () => {
    const ws = repo();
    assert.equal(run(REGISTER_WAVE, ws).code, 0);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    // No delegated file and no report: the wrapper reserved the nonce and then died.
    mintArtifacts(ws, { dispatch, contract: CONTRACT, state: 'reserved', report: null });
    const r = run(['return', '--nonce', CONTRACT.nonce, '--no-receipt', '--exit-status', '137', '--outcome', 'transport-failure'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /INELIGIBLE \(no-op-diff\)/);
    const record = kindOf(ws, 'return');
    assert.equal(record.diffLength, 0);
    assert.equal(record.reportLength, 0);
    assert.equal(record.metric.ineligibleReason, 'no-op-diff');
    assert.equal(record.metric.numeratorBytes, 0);
  });

  it('return --no-receipt requires --exit-status and an outcome inside the nullable set; --exit-status alone is refused', () => {
    const { ws } = laneToReturn({ artifacts: { state: 'reserved', report: null } });
    const argv = ['return', '--nonce', CONTRACT.nonce, '--no-receipt'];
    assert.match(run([...argv, '--outcome', 'transport-failure'], ws).stderr, /--exit-status is required/);
    assert.match(run([...argv, '--exit-status', '1'], ws).stderr, /--outcome is required with --no-receipt/);
    assert.match(run([...argv, '--exit-status', '1', '--outcome', 'partial-edit'], ws).stderr,
      new RegExp(`outside the --no-receipt set ${SESSION_ID_NULLABLE_OUTCOMES.join(' \\| ')}`));
    assert.match(run(['return', '--nonce', CONTRACT.nonce, '--exit-status', '1'], ws).stderr,
      /--exit-status belongs to the --no-receipt lane/);
    assert.equal(kindOf(ws, 'return'), undefined);
  });

  it('with no reservation at all there is no return: the thread closes by degrade', () => {
    const { ws } = laneToReturn({ artifacts: { state: 'reserved', report: null } });
    rmSync(join(ws.dir, execReceiptBasename('codex', CONTRACT.nonce)));
    assert.match(run(['return', '--nonce', CONTRACT.nonce, '--no-receipt', '--exit-status', '1', '--outcome', 'store-failure'], ws).stderr,
      /no exec receipt at /);
    const closed = run(['degrade', '--wave', 'wave-a', '--step-class', 'code', '--nonce', CONTRACT.nonce,
      '--rationale', 'the wrapper published no reservation; nothing about the run is knowable'], ws);
    assert.equal(closed.code, 0, closed.stderr);
    assert.match(closed.stdout, /and CLOSED the thread/);
    const report = run(['aggregate', '--wave', 'wave-a'], ws);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /p3-a1 · retry 0 · degrade-closed · L = 0\.000/);
  });

  it('the drift bracket names both digests when the tree moves between the two walks', () => {
    assert.equal(engine.treeDriftRefusal('a'.repeat(64), 'a'.repeat(64)), null);
    const drifted = engine.treeDriftRefusal('a'.repeat(64), 'b'.repeat(64));
    assert.match(drifted, /the tree moved WHILE the return was being computed \(aaaaaaaaaaaa… → bbbbbbbbbbbb…\)/);
    assert.match(drifted, /nothing was written/);
  });

  it('the hidden-path guard fails CLOSED when git cannot answer at all', () => {
    const plain = plainDir();
    assert.match(engine.hiddenFromPlainDiff(plain.cwd).reason, /a git probe of the change set could not be read/);
    assert.match(engine.hiddenFromPlainDiff(join(TMP, 'not-a-repo-at-all')).reason, /a git probe of the change set could not be read/);
  });

  // The INDEX-BIT arm refuses the BIT, never its effect — because the effect can be invisible to
  // every probe this kit owns. Deleting a materialized skip-worktree file changes no diff, no
  // fingerprint and no enumeration, so no comparison of views could ever have reached it.
  it('a tree carrying ANY index bit is refused by name, and the deletion behind one proves why', () => {
    const ws = repo();
    gitIn(ws.cwd, 'update-index', '--skip-worktree', 'base.txt');
    const guard = engine.hiddenFromPlainDiff(ws.cwd, ws.cwd);
    assert.equal(guard.ok, false);
    assert.match(guard.reason, /index entr\(ies\) carry a tag other than "H" \(S base\.txt\)/);
    assert.match(guard.reason, /invisible to EVERY probe this kit owns/);

    // The effect the bit hides: after deleting the file, nothing else in the kit can see it. The
    // digest is captured BEFORE the deletion — comparing two post-deletion computations would pass
    // whatever the deletion did, which is no assertion at all.
    const beforeDeletion = computeTreeFingerprint(ws.cwd);
    rmSync(join(ws.cwd, 'base.txt'));
    assert.equal(computeTreeFingerprint(ws.cwd), beforeDeletion, 'the deletion moved no fingerprint');
    const workingState = computeWorkingState(ws.cwd);
    assert.deepEqual(workingState.unstagedPaths, [], 'the deletion is invisible to the working state');
    assert.deepEqual(enumerateReturnedObjects(ws.cwd).entries, [], 'and to the producer');

    gitIn(ws.cwd, 'update-index', '--no-skip-worktree', 'base.txt');
    assert.deepEqual(engine.hiddenFromPlainDiff(ws.cwd, ws.cwd), { ok: true }, 'clearing the bit clears the refusal');
  });

  // codex's proof case for running the guard at OPEN: the bit is set and the file deleted BEFORE the
  // dispatch, so isTreeClean reports a CLEAN baseline; clearing the bit afterwards hands the delegate
  // a deletion it never made.
  it('open refuses a concealing tree, so a FALSE clean baseline can never be recorded', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    gitIn(ws.cwd, 'update-index', '--skip-worktree', 'base.txt');
    rmSync(join(ws.cwd, 'base.txt'));
    assert.equal(isTreeClean(ws.cwd), true, 'the tree LIES to the baseline probe — this is the case being closed');
    const r = run(openArgv(externalContract(CONTRACT)), ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carry a tag other than "H"/);
    assert.match(r.stderr, /nothing was written/);
    assert.equal(kindOf(ws, 'dispatch'), undefined);
  });

  // The payload holds an untracked binary by NAME alone, so its content never reaches the digest a
  // fold binds — the capability is subtracted rather than documented as a false promise.
  it('return refuses a change set carrying a BINARY object, naming why the lane is fail-closed', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    writeFileSync(join(ws.cwd, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 4]));
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /whose CONTENT never enters the uncommitted-state payload \(binary blob\.bin/);
    assert.match(r.stderr, /fail-closed for them until the shared payload can carry their content/);
    assert.equal(kindOf(ws, 'return'), undefined);

    // The digest's blindness is the reason: mutating the binary — content AND size — moves no
    // fingerprint at all, because the payload carries only the marker line for it.
    const before = computeTreeFingerprint(ws.cwd);
    writeFileSync(join(ws.cwd, 'blob.bin'), Buffer.from([0, 9, 9, 0, 9, 9, 9, 9, 9]));
    assert.equal(computeTreeFingerprint(ws.cwd), before, 'neither the content nor the SIZE reaches the digest');

    // Remove it and the same thread returns normally — the refusal is about the object, not the run.
    rmSync(join(ws.cwd, 'blob.bin'));
    writeFileSync(join(ws.cwd, 'delegated.txt'), DELEGATED_BYTES);
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], ws).code, 0);
  });

  // The refusal list is the CONTENT-BLIND classes and nothing else. The line matters: regular
  // content and symlink targets ARE in the payload — only ambiguously framed — and subtracting them
  // would refuse `new` and `symlink`, which is every delegated change set there is.
  // The ledger may only live inside the git dir for the three verbs that BIND a tree. A store in the
  // work tree is measured as part of the change set — probed: it is enumerated as an object, and the
  // append that follows postTreeDigest moves the tree every later fold binds.
  it('open, return and fold use the CANONICAL ledger and refuse every other store', () => {
    const ws = repo();
    const inTree = { ...ws, store: join(ws.cwd, 'ledger.jsonl'), env: { AW_DELEGATION_STORE: join(ws.cwd, 'ledger.jsonl') } };
    assert.equal(run(REGISTER_WAVE, inTree).code, 0, 'register keeps the unrestricted override — it binds no tree');
    const r = run(openArgv(externalContract(CONTRACT)), inTree);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not this repository's CANONICAL ledger/);
    assert.match(r.stderr, /measured as part of the change set it is supposed to be measuring/);
    assert.equal(kindOf(inTree, 'dispatch'), undefined);

    // A SECOND ledger INSIDE the git dir is refused too — the collision equality closes and mere
    // containment did not: both ledgers' threads would name the same artifact pair.
    const second = { ...ws, store: join(ws.dir, 'other.jsonl'), env: { AW_DELEGATION_STORE: join(ws.dir, 'other.jsonl') } };
    assert.equal(run(REGISTER_WAVE, second).code, 0);
    assert.match(run(openArgv(externalContract(CONTRACT)), second).stderr,
      /a SECOND ledger in this git dir would share artifact names/);

    // The same store, reached from ANOTHER repository, is refused for the same reason — which is the
    // cross-repository half: a ledger opened against one repo can never measure a different one.
    const other = repo();
    assert.match(main(['return', '--nonce', CONTRACT.nonce], { cwd: other.cwd, env: inTree.env, now: clock }).stderr,
      /is not this repository's CANONICAL ledger/);
    assert.match(main(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'x'], { cwd: other.cwd, env: inTree.env, now: clock }).stderr,
      /is not this repository's CANONICAL ledger/);

    // An override whose directory does not exist at all still gets an answer: the containment check
    // falls back to the LEXICAL resolve rather than throwing, so an unresolvable path is judged
    // instead of crashing the verb.
    const absent = join(TMP, `no-such-dir-${seq += 1}`, DELEGATION_STORE_BASENAME);
    assert.match(main(openArgv(externalContract(CONTRACT)), { cwd: ws.cwd, env: { AW_DELEGATION_STORE: absent }, now: clock }).stderr,
      /is not this repository's CANONICAL ledger/);
  });

  // ENOENT is the only errno that means "nothing to check". EINVAL emphatically is not: the producer
  // labels an object `symlink` when ANY layer carries mode 120000, so a committed symlink replaced by
  // a BINARY regular file is a symlink entry whose readlink refuses — and the content-blind guard
  // never sees it either, because no `binary` kind was emitted. The type change falls between two
  // guards unless this one fails closed.
  it('a symlink REPLACED by a binary regular file refuses — the type change falls between two guards', () => {
    const ws = repo();
    symlinkSync('base.txt', join(ws.cwd, 'link'));
    gitIn(ws.cwd, 'add', '-A');
    gitIn(ws.cwd, 'commit', '-qm', 'a tracked symlink');
    run(REGISTER_WAVE, ws);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    rmSync(join(ws.cwd, 'link'));
    writeFileSync(join(ws.cwd, 'link'), Buffer.from([0, 1, 0]));
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    const entry = enumerateReturnedObjects(ws.cwd).entries.find((e) => e.path === 'link');
    assert.equal(entry.kind, 'symlink', 'the producer still calls it a symlink — which is why the content-blind guard misses it');
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not be read \(EINVAL\)/);
    assert.match(r.stderr, /a TYPE CHANGE whose new bytes no guard here can see/);
    assert.equal(kindOf(ws, 'return'), undefined);
  });

  // A DELETED symlink has no target left to lose — its bytes ride the diff, which is exact — so the
  // target guard steps over it rather than refusing a thread it has no reason to stop.
  it('a deleted symlink does not trip the target guard', () => {
    const ws = repo();
    symlinkSync('base.txt', join(ws.cwd, 'link'));
    gitIn(ws.cwd, 'add', '-A');
    gitIn(ws.cwd, 'commit', '-qm', 'a tracked symlink');
    run(REGISTER_WAVE, ws);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    rmSync(join(ws.cwd, 'link'));
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 0, r.stderr);
    const component = kindOf(ws, 'return').metric.components.find((c) => c.path === 'link');
    assert.equal(component.kind, 'symlink', 'it IS a symlink component — the guard simply had nothing to read');
  });

  // ONE nonce, ONE artifact pair, refused PRE-SPEND. The names are a function of {backend, nonce}
  // alone, so a leftover pair would later be absorbed as this dispatch's own evidence.
  it('open refuses when an exec artifact for this {backend, nonce} already exists', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    writeFileSync(join(ws.dir, execReceiptBasename('codex', CONTRACT.nonce)), '{"left":"over"}');
    const r = run(openArgv(externalContract(CONTRACT)), ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /1 exec artifact\(s\) for \{backend "codex", nonce "p3-a1"\} already exist beside the ledger/);
    assert.match(r.stderr, /absorbed as this dispatch's own evidence/);
    assert.equal(kindOf(ws, 'dispatch'), undefined);

    rmSync(join(ws.dir, execReceiptBasename('codex', CONTRACT.nonce)));
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0, 'with the name free, the same dispatch opens');
  });

  it('return refuses a symlink whose target is not valid UTF-8 — the payload loses those bytes before framing', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    symlinkSync(Buffer.from([0xff]), join(ws.cwd, 'link'));
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    const r = run(['return', '--nonce', CONTRACT.nonce], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /symlink target\(s\) are not valid UTF-8 \(link -> 0xff\)/);
    assert.equal(kindOf(ws, 'return'), undefined);

    // Why it is refused: the two distinct targets are ONE payload and ONE enumeration.
    const before = computeTreeFingerprint(ws.cwd);
    const enumeratedBefore = JSON.stringify(enumerateReturnedObjects(ws.cwd).entries);
    rmSync(join(ws.cwd, 'link'));
    symlinkSync(Buffer.from([0xfe]), join(ws.cwd, 'link'));
    assert.equal(computeTreeFingerprint(ws.cwd), before, '0xff and 0xfe are one payload');
    assert.equal(JSON.stringify(enumerateReturnedObjects(ws.cwd).entries), enumeratedBefore);

    // A target that IS valid UTF-8 stays measurable.
    rmSync(join(ws.cwd, 'link'));
    symlinkSync('base.txt', join(ws.cwd, 'link'));
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], ws).code, 0);
  });

  it('the content-blind refusal covers exactly the three classes the payload carries no content for', () => {
    assert.deepEqual([...engine.CONTENT_BLIND_KINDS], ['binary', 'non-regular', 'submodule']);
    assert.equal(engine.contentBlindRefusal([{ kind: 'new', path: 'a.txt' }, { kind: 'symlink', path: 'l' },
      { kind: 'modified', path: 'm' }, { kind: 'deleted', path: 'd' }, { kind: 'renamed', path: 'r' }]), null,
      'the classes whose bytes DO reach the payload stay measurable, ambiguous framing and all');
    assert.match(engine.contentBlindRefusal([{ kind: 'non-regular', path: 'weird' }]), /non-regular weird/);
    // The submodule arm is CONSERVATIVE and says so: a clean pointer change does carry its OIDs.
    assert.match(engine.contentBlindRefusal([{ kind: 'submodule', path: 'vendor' }]),
      /submodule vendor \(refused conservatively: a clean pointer change does carry its OIDs/);
  });

  // The residual limits are pinned as FACTS, not left as prose: what the mode doc says the binding
  // cannot see, the suite demonstrates it cannot see — so a payload upgrade that fixes them will
  // redden these assertions and force the documentation to move with the code.
  it('the STATED residuals hold: the unframed payload aliases two trees, and it is blind to the exec bit', () => {
    // (a) One file whose content imitates the marker that opens the next untracked entry.
    const one = repo();
    writeFileSync(join(one.cwd, 'one.txt'), 'hello\nuntracked:two.txt\nworld\n');
    const two = repo();
    writeFileSync(join(two.cwd, 'one.txt'), 'hello\n');
    writeFileSync(join(two.cwd, 'two.txt'), 'world\n');
    assert.equal(computeTreeFingerprint(one.cwd), computeTreeFingerprint(two.cwd),
      'TWO DIFFERENT TREES, one fingerprint — the payload is unframed (queued: FINGERPRINT-PAYLOAD-IS-UNFRAMED-AND-MODE-BLIND)');

    // (b) A symlink target doing the same thing.
    const linkA = repo();
    symlinkSync('b\nuntracked:x', join(linkA.cwd, 'link'));
    const linkB = repo();
    symlinkSync('b', join(linkB.cwd, 'link'));
    writeFileSync(join(linkB.cwd, 'x'), '');
    assert.equal(computeTreeFingerprint(linkA.cwd), computeTreeFingerprint(linkB.cwd));

    // (c) The executable bit is a blind ATTRIBUTE — not a content class, so it is not subtracted.
    const exec = repo();
    const script = join(exec.cwd, 'script.sh');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    chmodSync(script, 0o644);
    const plain = computeTreeFingerprint(exec.cwd);
    const enumerated = JSON.stringify(enumerateReturnedObjects(exec.cwd).entries);
    chmodSync(script, 0o755);
    assert.equal(computeTreeFingerprint(exec.cwd), plain, 'the mode never enters the payload');
    assert.equal(JSON.stringify(enumerateReturnedObjects(exec.cwd).entries), enumerated, 'nor the enumeration');
  });

  // The STAGED half of the same blindness: a gitlink in the index under diff.ignoreSubmodules=all,
  // which the plain probe cannot list at all. The forced enumeration names the PATH rather than
  // reporting a boolean, which is what lets it be seen beside other staged files.
  it('the hidden-path guard names a STAGED change the plain git diff cannot list, and stays quiet on an ordinary tree', () => {
    const ws = repo();
    const head = gitIn(ws.cwd, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(ws.cwd, 'sub'));
    gitIn(ws.cwd, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    gitIn(ws.cwd, 'config', 'diff.ignoreSubmodules', 'all');
    const guard = engine.hiddenFromPlainDiff(ws.cwd, ws.cwd);
    assert.equal(guard.ok, false);
    assert.match(guard.reason, /staged: sub/);

    // No false positive on an ordinary mixed change set — visible staged, visible unstaged, untracked.
    const plain = repo();
    writeFileSync(join(plain.cwd, 'base.txt'), 'an ordinary visible edit\n');
    writeFileSync(join(plain.cwd, 'fresh.txt'), 'an ordinary untracked file\n');
    gitIn(plain.cwd, 'add', 'base.txt');
    writeFileSync(join(plain.cwd, 'base.txt'), 'edited again after staging\n');
    assert.deepEqual(engine.hiddenFromPlainDiff(plain.cwd, plain.cwd), { ok: true });
  });

  it('return refuses outside a git work tree, even when the override names a readable ledger', () => {
    // A plain directory with a hand-written thread and both artifacts beside it: everything the
    // absorb door reads succeeds, and the REPOSITORY is the thing that is missing.
    const plain = plainDir();
    plain.dir = plain.cwd;
    const dispatch = dispatchRecord(CONTRACT.nonce, { contractDigest: contractDigest(CONTRACT), deadlineS: CONTRACT.deadlineS });
    writeFileSync(plain.store, `${JSON.stringify(registration())}\n${JSON.stringify(dispatch)}\n`);
    mintArtifacts(plain, { dispatch, contract: CONTRACT });
    const r = main(['return', '--nonce', CONTRACT.nonce], { cwd: plain.cwd, env: plain.env, now: clock });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not inside a git work tree — a return is enumerated against a repository/);
  });
});

describe('fold binds the CURRENT tree to what was returned; degrade closes without one', () => {
  const returned = () => {
    const lane = laneToReturn();
    const r = run(['return', '--nonce', CONTRACT.nonce], lane.ws);
    assert.equal(r.code, 0, r.stderr);
    return lane;
  };

  it('fold on the unmoved tree lands and CLOSES the thread, and aggregate reports its computed L', () => {
    const { ws } = returned();
    const r = run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'reviewed by both backends and by hand'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /thread "p3-a1" folded and CLOSED/);
    const fold = kindOf(ws, 'fold');
    const ret = kindOf(ws, 'return');
    assert.equal(fold.returnDigest, canonicalDelegationDigest(ret));
    assert.equal(fold.treeDigestAtFold, ret.postTreeDigest);
    const report = run(['aggregate', '--wave', 'wave-a'], ws);
    assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, /p3-a1 · retry 0 · folded success · L = /);
    assert.match(report.stdout, /COMPUTED — PILOT evidence \(n = 1\)/);
  });

  it('fold refuses when the tree moved since the return, and staging an untracked change set moves it', () => {
    const moved = returned();
    writeFileSync(join(moved.ws.cwd, 'delegated.txt'), `${DELEGATED_BYTES}one more line\n`);
    const r = run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'folding a tree that moved'], moved.ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the tree moved between the return and the fold/);
    assert.equal(kindOf(moved.ws, 'fold'), undefined);

    // Staging an UNTRACKED creation moves the payload (an `untracked:<path>` section plus its bytes
    // becomes a staged diff), so the fold refuses — the ordinary delegated change set.
    const staged = returned();
    gitIn(staged.ws.cwd, 'add', '-A');
    assert.match(run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'folding after git add'], staged.ws).stderr,
      /the tree moved between the return and the fold/);
  });

  // The honest limit, pinned rather than claimed away: a TRACKED-only change passing into a CLEAN
  // index leaves the payload byte-identical (it concatenates the staged and unstaged diffs), so the
  // digest cannot see the move and the fold LANDS. It is still honest — same bytes, same content —
  // which is why the rule is "the fold precedes staging", not "staging refuses the fold".
  it('staging a TRACKED-only change into a clean index does NOT move the fingerprint, and the fold still lands', () => {
    const ws = repo();
    assert.equal(run(REGISTER_WAVE, ws).code, 0);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    writeFileSync(join(ws.cwd, 'base.txt'), 'the delegate edited this TRACKED file and created nothing\n');
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], ws).code, 0);
    const postTreeDigest = kindOf(ws, 'return').postTreeDigest;

    gitIn(ws.cwd, 'add', '-A');
    const r = run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'folded after staging a tracked-only change'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(kindOf(ws, 'fold').treeDigestAtFold, postTreeDigest,
      'the payload is blind to the index↔worktree split, so staging left the digest equal');
  });

  // What the digest cannot catch, the guard does. A change made behind an index bit between the
  // return and the fold leaves the fingerprint EQUAL, so without this guard the fold would accept
  // bytes nobody returned.
  it('fold refuses a change made behind an index bit since the return — the digest alone cannot see it', () => {
    const { ws } = returned();
    const postTreeDigest = kindOf(ws, 'return').postTreeDigest;
    gitIn(ws.cwd, 'update-index', '--skip-worktree', 'base.txt');
    writeFileSync(join(ws.cwd, 'base.txt'), 'changed behind the index bit AFTER the return\n');
    assert.equal(computeTreeFingerprint(ws.cwd), postTreeDigest, 'the fingerprint did NOT move — this is why the guard exists');
    const r = run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'folding over a hidden change'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carry a tag other than "H" \(S base\.txt\)/);
    assert.match(r.stderr, /nothing was written/);
    assert.equal(kindOf(ws, 'fold'), undefined);
    // The digest is the reason this needed its own guard: it did NOT move.
    gitIn(ws.cwd, 'update-index', '--no-skip-worktree', 'base.txt');
    writeFileSync(join(ws.cwd, 'base.txt'), 'base\n');
    assert.equal(run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'folded once the bit was cleared'], ws).code, 0);
    assert.equal(kindOf(ws, 'fold').treeDigestAtFold, postTreeDigest);
  });

  // The fold-side content-blind guard, pinned so that DELETING it reddens a test. The instrument is
  // the payload's own aliasing: the returned tree is one text file `a` holding the marker line that
  // opens a binary entry; the folded tree is an EMPTY `a` plus a real binary `b`. The payloads are
  // byte-identical, so the digest binding cannot notice — only the fold's own refusal can.
  it('fold refuses a binary that arrived under an IDENTICAL payload, which the digest binding cannot see', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const dispatch = kindOf(ws, 'dispatch');
    writeFileSync(join(ws.cwd, 'a'), 'untracked-binary:b\n');
    mintArtifacts(ws, { dispatch, contract: CONTRACT });
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], ws).code, 0);
    const postTreeDigest = kindOf(ws, 'return').postTreeDigest;

    writeFileSync(join(ws.cwd, 'a'), '');
    writeFileSync(join(ws.cwd, 'b'), Buffer.from([0, 1, 0, 2]));
    assert.equal(computeTreeFingerprint(ws.cwd), postTreeDigest,
      'the two trees share one payload — the store\'s fold binding would accept this one');
    const r = run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'folding a tree that grew a binary'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /whose CONTENT never enters the uncommitted-state payload \(binary b/);
    assert.equal(kindOf(ws, 'fold'), undefined, 'only the fold-side guard stopped this');
  });

  it('fold refuses outside a git work tree, even when the override names a readable ledger', () => {
    const plain = plainDir();
    const dispatch = dispatchRecord(CONTRACT.nonce, { contractDigest: contractDigest(CONTRACT) });
    const ret = returnRecord(CONTRACT.nonce, { contractDigest: contractDigest(CONTRACT) });
    writeFileSync(plain.store, [registration(), dispatch, ret].map((r) => `${JSON.stringify(r)}\n`).join(''));
    const r = main(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'x'], { cwd: plain.cwd, env: plain.env, now: clock });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not inside a git work tree — a fold re-confirms the tree it is folding/);
  });

  it('fold refuses a thread with no return and a nonce that was never dispatched', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    assert.match(run(['fold', '--nonce', 'never-opened', '--verdict', 'x'], ws).stderr,
      /no dispatch for nonce "never-opened" is in the store/);
    assert.equal(run(openArgv(externalContract(CONTRACT)), ws).code, 0);
    const r = run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'nothing came back yet'], ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /carries no return to fold/);
  });

  it('degrade without --nonce records the PRE-DISPATCH refusal, and aggregate then REFUSES by name', () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    const r = run(['degrade', '--wave', 'wave-a', '--step-class', 'code',
      '--rationale', 'no backend was available at all, so nothing was dispatched'], ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /a PRE-DISPATCH refusal: it opens NO nonce thread/);
    assert.match(r.stdout, /`aggregate` will REFUSE this wave by name/);
    assert.equal(kindOf(ws, 'degrade').nonce, null);
    const report = run(['aggregate', '--wave', 'wave-a'], ws);
    assert.equal(report.code, 1);
    assert.match(report.stderr, /carries a PRE-DISPATCH degrade/);
  });

  it('fold and degrade each refuse over a semantically illegal ledger prefix (D14)', () => {
    const corrupt = () => writeStore(repo(), [registration(), dispatchRecord('n1'), dispatchRecord('n1', { timestamp: TS(6) })]);
    assert.match(run(['fold', '--nonce', 'n1', '--verdict', 'x'], corrupt()).stderr,
      /line 3 carries a record the append path would have REFUSED/);
    assert.match(run(['degrade', '--wave', 'wave-a', '--step-class', 'code', '--rationale', 'x'], corrupt()).stderr,
      /line 3 carries a record the append path would have REFUSED/);
  });
});

// ── (7) await — the arrival waiter (Phase 4) ──────────────────────────────────────────────────────

// The waiter's clock IS the module's own `now` — one clock per run — so the fixture moves the same
// wall clock the ABSOLUTE deadline is measured against. `offsetS` places the wait relative to the
// DISPATCH record's timestamp; `sleep` advances the clock and can fire the arrival mid-wait, so the
// suite spends no wall-clock at all.
const awaitAt = (ws, { nonce = CONTRACT.nonce, timeoutS = null, offsetS = 0, onSleep, pollMs = 5000 } = {}) => {
  const state = { t: Date.parse(kindOf(ws, 'dispatch').timestamp) + offsetS * 1000, slept: 0 };
  const argv = ['await', '--nonce', nonce, ...(timeoutS === null ? [] : ['--timeout', String(timeoutS)])];
  return engine.mainAwait(argv, {
    cwd: ws.cwd,
    env: ws.env,
    now: () => new Date(state.t).toISOString(),
    sleep: async (ms) => { state.t += ms; state.slept += 1; if (onSleep) onSleep(state.slept); },
    pollMs,
  }).then((r) => ({ ...r, slept: state.slept }));
};

const RESERVED_ONLY = { artifacts: { state: 'reserved', report: null } };
const receiptPathOf = (ws) => join(ws.dir, execReceiptBasename('codex', CONTRACT.nonce));

describe('await observes ARRIVAL, writes nothing, and never releases a writer slot', () => {
  it('await is satisfied by the TERMINAL exec receipt and never by a RESERVED one', async () => {
    const landed = laneToReturn();
    const arrived = await awaitAt(landed.ws);
    assert.equal(arrived.code, 0, arrived.stderr);
    assert.match(arrived.stdout, /ARRIVED — the TERMINAL exec receipt landed/);
    assert.match(arrived.stdout, /outcome success · exit 0 · session sess-1/);
    assert.equal(arrived.slept, 0, 'an artifact already on disk is answered without a single sleep');
    assert.equal(recordsOf(landed.ws).length, 2, 'await writes NOTHING — the registration and the dispatch are all there is');

    const holding = laneToReturn(RESERVED_ONLY);
    const waited = await awaitAt(holding.ws, { timeoutS: 60 });
    assert.equal(waited.code, engine.AWAIT_UNANSWERED_STATUS);
    assert.match(waited.stderr, /a RESERVED receipt at /);
    assert.ok(waited.slept > 0, 'a reservation is "keep waiting", never an answer');
    assert.equal(recordsOf(holding.ws).length, 2);
  });

  it('a reservation REPLACED mid-wait by the terminal receipt arrives on the very next poll', async () => {
    const { ws, dispatch, contract } = laneToReturn(RESERVED_ONLY);
    const r = await awaitAt(ws, { timeoutS: 60, onSleep: (n) => { if (n === 2) mintArtifacts(ws, { dispatch, contract }); } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 2, 'the poll after the replacement answers');
  });

  it('await refuses a --timeout above the REMAINING time — the bound moves as the window closes', async () => {
    const { ws } = laneToReturn(RESERVED_ONLY);
    const over = await awaitAt(ws, { timeoutS: CONTRACT.deadlineS + 1 });
    assert.equal(over.code, 1);
    assert.match(over.stderr, /reaches past this dispatch's ABSOLUTE deadline/);
    assert.match(over.stderr, /of which 900s remain/);
    assert.match(over.stderr, /nothing was waited on/);
    assert.equal(over.slept, 0);

    // The SAME flag value becomes inadmissible later in the window: the bound is the remaining time,
    // never the deadline the contract carried.
    const late = await awaitAt(ws, { timeoutS: 301, offsetS: 600 });
    assert.equal(late.code, 1);
    assert.match(late.stderr, /of which 300s remain/);

    const exact = await awaitAt(ws, { timeoutS: 300, offsetS: 600 });
    assert.equal(exact.code, engine.AWAIT_UNANSWERED_STATUS, 'exactly the remaining time is admissible');
    assert.match(exact.stderr, /EXPIRED/, 'when the two bounds coincide the DEADLINE is the one that answers');
  });

  // The council's round-1 major, and codex's own ruling on the direction: a VISIBLE terminal
  // receipt answers ARRIVED whatever either bound says, because lateness has exactly ONE decision
  // site and it is the absorb door. The --timeout admissibility check bounds a WAIT, so it has
  // nothing to say about an artifact that is already on disk.
  it('an arrival on disk outranks an INADMISSIBLE --timeout — the bound is checked only once there is a wait', async () => {
    const landed = laneToReturn();
    const r = await awaitAt(landed.ws, { timeoutS: CONTRACT.deadlineS + 1 });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ARRIVED/);
    assert.equal(r.slept, 0);

    // …and with nothing on disk the SAME flag value refuses, so the check did not simply vanish.
    const holding = laneToReturn(RESERVED_ONLY);
    assert.equal((await awaitAt(holding.ws, { timeoutS: CONTRACT.deadlineS + 1 })).code, 1);
  });

  // Characterization, not a red-proof: this arm is green on both sides of the fold, and it is here
  // to keep it that way — each pass polls BEFORE it consults the clock, so a receipt landing during
  // the last sleep is reported rather than lost to a cutoff that fires a moment later.
  it('a receipt landing exactly AT the wait bound is ARRIVED, never TIMEOUT', async () => {
    const { ws, dispatch, contract } = laneToReturn(RESERVED_ONLY);
    const r = await awaitAt(ws, { timeoutS: 60, onSleep: (n) => { if (n === 12) mintArtifacts(ws, { dispatch, contract }); } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.slept, 12, 'the poll after the twelfth sleep sits exactly on the bound');
  });

  it('an already-expired dispatch answers immediately — but an arrival on disk still outranks the clock', async () => {
    const { ws } = laneToReturn(RESERVED_ONLY);
    const expired = await awaitAt(ws, { offsetS: CONTRACT.deadlineS + 1, timeoutS: 60 });
    assert.equal(expired.code, engine.AWAIT_UNANSWERED_STATUS);
    assert.equal(expired.slept, 0, 'an expired dispatch is answered, never waited on');
    assert.match(expired.stderr, /EXPIRED/);

    // Arrival is a FACT this verb reports; whether a LATE receipt may be absorbed is the absorb
    // door's question, and it refuses one by name.
    const landed = laneToReturn();
    const late = await awaitAt(landed.ws, { offsetS: CONTRACT.deadlineS + 1 });
    assert.equal(late.code, 0, late.stderr);
    assert.match(late.stdout, /ARRIVED/);
  });

  it('the expiry names the supervision question and states that no writer slot was released', async () => {
    const { ws } = laneToReturn(RESERVED_ONLY);
    const r = await awaitAt(ws, { offsetS: CONTRACT.deadlineS });
    assert.equal(r.code, engine.AWAIT_UNANSWERED_STATUS, 'an expiry is neither a refusal (1) nor usage (2)');
    assert.match(r.stderr, /SUPERVISION question, not an outcome/);
    assert.match(r.stderr, /join or reap it/);
    assert.match(r.stderr, /return --no-receipt or degrade/);
    assert.match(r.stderr, /NO writer slot was released/);
    assert.equal(r.stdout, '', 'an unanswered wait prints no result line');
  });

  it('a --timeout that ends INSIDE the deadline says so, and still releases no slot', async () => {
    const { ws } = laneToReturn(RESERVED_ONLY);
    const r = await awaitAt(ws, { timeoutS: 60 });
    assert.equal(r.code, engine.AWAIT_UNANSWERED_STATUS);
    assert.match(r.stderr, /TIMEOUT after 60s/);
    assert.match(r.stderr, /still INSIDE its absolute deadline \(840s remain/);
    assert.match(r.stderr, /NO writer slot was released/);
  });

  it('await refuses a symlinked, FIFO, invalid-UTF-8 or malformed artifact BY CLASS', async () => {
    const symlinked = laneToReturn(RESERVED_ONLY);
    rmSync(receiptPathOf(symlinked.ws));
    symlinkSync(join(symlinked.ws.dir, 'somewhere-else.json'), receiptPathOf(symlinked.ws));
    const followed = await awaitAt(symlinked.ws);
    assert.equal(followed.code, 1);
    assert.match(followed.stderr, /is a symlink, not a regular file — never followed, never read/);

    const piped = laneToReturn(RESERVED_ONLY);
    rmSync(receiptPathOf(piped.ws));
    assert.equal(spawnSync('mkfifo', [receiptPathOf(piped.ws)], { encoding: 'utf8' }).status, 0, 'mkfifo fixture');
    const fifo = await awaitAt(piped.ws);
    assert.equal(fifo.code, 1);
    assert.match(fifo.stderr, /is a FIFO, not a regular file/);

    const raw = laneToReturn(RESERVED_ONLY);
    writeFileSync(receiptPathOf(raw.ws), Buffer.from([0xff, 0xfe, 0x00]));
    const undecodable = await awaitAt(raw.ws);
    assert.equal(undecodable.code, 1);
    assert.match(undecodable.stderr, /invalid UTF-8 in the file/);
    assert.match(undecodable.stderr, /a FAILED probe, not an absent one/);

    const junk = laneToReturn(RESERVED_ONLY);
    writeFileSync(receiptPathOf(junk.ws), '{ not json');
    const broken = await awaitAt(junk.ws);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /is REFUSED — exec receipt: the artifact is not valid JSON/);
    assert.match(broken.stderr, /only an exec receipt answers an exec dispatch/);
  });

  // D10, the exec side: satisfaction is decided POSITIVELY by the exec-receipt reader, so no
  // artifact of a NEIGHBOURING family — a review receipt, a delegation ledger record, a finding
  // manifest — can answer an exec dispatch, however plausible its bytes look at that path.
  it('a review receipt, a delegation ledger line and a finding manifest never satisfy await (D10 →)', async () => {
    const foreign = [
      ['a review receipt', { schema: 1, artifact: 'code', backend: 'codex', verdict: 'ship', fingerprint: null }],
      ['a delegation ledger line', dispatchRecord(CONTRACT.nonce)],
      ['a finding manifest', { schema: 1, backend: 'codex', nonce: CONTRACT.nonce, fingerprint: D('a1'), findings: [] }],
    ];
    for (const [label, body] of foreign) {
      const { ws } = laneToReturn(RESERVED_ONLY);
      writeFileSync(receiptPathOf(ws), JSON.stringify(body));
      const r = await awaitAt(ws);
      assert.equal(r.code, 1, `${label} must never satisfy an exec waiter`);
      assert.match(r.stderr, /only an exec receipt answers an exec dispatch/);
      assert.equal(r.stdout, '', `${label} never prints ARRIVED`);
    }
  });

  it('await refuses a receipt whose {backend, nonce} BODY answers another dispatch', async () => {
    const { ws } = laneToReturn({ artifacts: { receipt: { nonce: 'someone-else' } } });
    const r = await awaitAt(ws);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /names \{backend "codex", nonce "someone-else"\}/);
    assert.match(r.stderr, /not by the filename it was found under/);
  });

  // A CLOSED thread is not awaited: nothing can answer it any more, and the expiry message would
  // otherwise send the operator to close what is already closed. Checked in the WAITING branch of
  // the first poll ONLY — the third arm pins that a terminal receipt still on disk keeps answering.
  it('await refuses a CLOSED thread by name instead of waiting out its bound', async () => {
    const absorbed = laneToReturn(RESERVED_ONLY);
    assert.equal(run(['return', '--nonce', CONTRACT.nonce, '--no-receipt', '--exit-status', '137', '--outcome', 'transport-failure'], absorbed.ws).code, 0);
    const closed = await awaitAt(absorbed.ws, { timeoutS: 60 });
    assert.equal(closed.code, 1);
    assert.match(closed.stderr, /is already CLOSED by its transport-failure return/);
    assert.equal(closed.slept, 0, 'a closed thread is answered, never waited on — the reservation is still on disk');

    const gone = laneToReturn(RESERVED_ONLY);
    rmSync(receiptPathOf(gone.ws));
    assert.equal(run(['degrade', '--wave', 'wave-a', '--nonce', CONTRACT.nonce, '--step-class', 'code', '--rationale', 'the backend never answered'], gone.ws).code, 0);
    const degraded = await awaitAt(gone.ws, { timeoutS: 60 });
    assert.equal(degraded.code, 1);
    assert.match(degraded.stderr, /is already CLOSED by its degrade/);

    const folded = laneToReturn();
    assert.equal(run(['return', '--nonce', CONTRACT.nonce], folded.ws).code, 0);
    assert.equal(run(['fold', '--nonce', CONTRACT.nonce, '--verdict', 'as returned'], folded.ws).code, 0);
    const still = await awaitAt(folded.ws);
    assert.equal(still.code, 0, 'a TERMINAL receipt on disk is a fact this verb reports, closed thread or not');
    assert.match(still.stdout, /ARRIVED/);
  });

  // The frozen record vocabulary admits ANY positive safe-integer deadlineS, so the bound arithmetic
  // leaves the exactly-representable range: two bounds 1000 ms apart round to the SAME double, and
  // the deadline instant leaves the range a Date can hold. Both are decisions, not cosmetics — the
  // pair below is the one codex named, and it reproduces.
  it('a legal but unrepresentable deadline keeps the refusal exact and the unanswered status intact', async () => {
    const huge = 9007199254740885;
    const { ws } = laneToReturn({ contract: { deadlineS: huge }, artifacts: { state: 'reserved', report: null } });
    // The sleep guard is what makes this arm FAIL rather than HANG when the refusal is skipped: an
    // admitted wait against a bound 9e18 ms away polls forever, so without it the proof would be a
    // timeout — a quarantine, not a red. That unbounded wait is itself part of what the refusal
    // prevents.
    const over = await awaitAt(ws, { timeoutS: huge + 1, onSleep: (n) => { if (n > 2) throw new Error('the wait was ADMITTED past the deadline'); } });
    assert.equal(over.code, 1, 'a --timeout one second past the deadline must refuse, whatever the magnitude');
    assert.match(over.stderr, /reaches past this dispatch's ABSOLUTE deadline/);

    const waited = await awaitAt(ws, { timeoutS: 60 });
    assert.equal(waited.code, engine.AWAIT_UNANSWERED_STATUS, 'an unrenderable deadline never turns the promised status into a thrown RangeError');
    assert.match(waited.stderr, /beyond the range a date can represent/);
  });

  it('await refuses an unopened thread, and re-establishes ledger legality first (D14)', async () => {
    const ws = repo();
    run(REGISTER_WAVE, ws);
    const none = await engine.mainAwait(['await', '--nonce', 'never-opened'], { cwd: ws.cwd, env: ws.env, now: clock });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no dispatch for nonce "never-opened" is in the store/);

    const corrupt = writeStore(repo(), [registration(), dispatchRecord('n1'), dispatchRecord('n1', { timestamp: TS(6) })]);
    const illegal = await engine.mainAwait(['await', '--nonce', 'n1'], { cwd: corrupt.cwd, env: corrupt.env, now: clock });
    assert.equal(illegal.code, 1);
    assert.match(illegal.stderr, /line 3 carries a record the append path would have REFUSED/);
  });

  it('await takes flags only, requires --nonce, and refuses an unusable --timeout or clock', async () => {
    const { ws } = laneToReturn();
    const ctx = { cwd: ws.cwd, env: ws.env, now: clock };
    const stray = await engine.mainAwait(['await', CONTRACT.nonce], ctx);
    assert.equal(stray.code, 2);
    assert.match(stray.stderr, /unknown argument: p3-a1 — await takes flags only/);
    assert.match((await engine.mainAwait(['await'], ctx)).stderr, /--nonce is required/);
    assert.match((await engine.mainAwait(['await', '--nonce', CONTRACT.nonce, '--timeout', '0'], ctx)).stderr, /--timeout must be at least 1/);
    const stopped = await engine.mainAwait(['await', '--nonce', CONTRACT.nonce], { ...ctx, now: () => 'not an instant' });
    assert.equal(stopped.code, 2);
    assert.match(stopped.stderr, /did not produce an instant/);
  });
});

describe('the writer verbs\' flag surface mirrors the D3 key sets', () => {
  const topLevel = (fields) => [...new Set(Object.values(fields).map((f) => f.split('.')[0]))];

  it('open: the flag-decided, header-COPIED and derived fields together ARE the dispatch key set', () => {
    assert.deepEqual(
      [...topLevel(engine.OPEN_FLAG_FIELDS), ...engine.OPEN_CONTRACT_FIELDS, ...engine.OPEN_DERIVED_FIELDS].sort(),
      [...DELEGATION_KEY_SETS.dispatch].sort(),
    );
    // The INPUT flags decide no field of their own and are therefore listed separately rather than
    // hidden inside the scanner: a reader can see the whole accepted surface in one place.
    assert.deepEqual(Object.keys(engine.OPEN_INPUT_FLAGS), ['--contract', '--wrapper-cap-s', '--kill-grace-s']);
  });

  it('return: the flag-decided plus derived fields ARE the return key set, and --no-receipt decides none', () => {
    assert.deepEqual(
      [...topLevel(engine.RETURN_FLAG_FIELDS), ...engine.RETURN_DERIVED_FIELDS].sort(),
      [...DELEGATION_KEY_SETS.return].sort(),
    );
    assert.deepEqual(Object.keys(engine.RETURN_INPUT_FLAGS), ['--no-receipt']);
  });

  // The ninth verb writes NO record, so it has no key set to mirror: its flags are INPUTS, listed
  // beside `open`'s floor operands rather than hidden inside the scanner.
  it('await decides no record field — its whole surface is {--nonce, --timeout}', () => {
    assert.deepEqual(Object.keys(engine.AWAIT_INPUT_FLAGS), ['--nonce', '--timeout']);
  });

  it('fold and degrade mirror their key sets', () => {
    assert.deepEqual(
      [...topLevel(engine.FOLD_FLAG_FIELDS), ...engine.FOLD_DERIVED_FIELDS].sort(),
      [...DELEGATION_KEY_SETS.fold].sort(),
    );
    assert.deepEqual(
      [...topLevel(engine.DEGRADE_FLAG_FIELDS), ...engine.DEGRADE_DERIVED_FIELDS].sort(),
      [...DELEGATION_KEY_SETS.degrade].sort(),
    );
  });
});

// ── the CLI shell: help, routing, the --cwd seam, the process-facing writer ───────────────────────

describe('dispatch CLI shell', () => {
  it('--help states the FORM-only limit and every aggregate refusal by name', () => {
    const r = main(['--help'], {});
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(DISPATCH_CONTRACT));
    for (const phrase of ['no pre-registration record', 'OPEN thread in scope', 'several waves present with no --wave']) {
      assert.ok(r.stdout.includes(phrase), `--help must name the refusal: ${phrase}`);
    }
    for (const verb of ['check', 'register', 'observe', 'open', 'await', 'return', 'fold', 'degrade', 'aggregate']) {
      assert.ok(r.stdout.includes(`node dispatch.mjs ${verb}`), `--help must show the usage of ${verb}`);
    }
    // The v1 limits ride the help, not only the mode doc: a reader who never opens the doc still
    // learns what this metric does NOT account for.
    assert.match(r.stdout, /gate output is\nnever accounted/);
    assert.match(r.stdout, /D10 stands as a BAR, not a mechanism/);
  });

  it('an unknown or absent verb is usage (exit 2), and the expected set names all ten', () => {
    const unknown = main(['frobnicate'], {});
    assert.match(unknown.stderr, /unknown verb: frobnicate/);
    assert.match(unknown.stderr, /check \| advise \| register \| observe \| open \| await \| return \| fold \| degrade \| aggregate/);
    assert.match(main([], {}).stderr, /unknown verb: \(none\)/);
  });

  // The waiting verb has its OWN entry rather than making every immediate verb's answer a promise
  // (the review lane's mainAwait idiom). main() therefore refuses it BY NAME — a bare "unknown verb"
  // there would send a caller looking for a typo instead of at the entry point.
  it('main refuses the WAITING verb by name; mainAwait answers it and delegates every other one', async () => {
    const refused = main(['await', '--nonce', 'p3-a1'], {});
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /await is the one verb that WAITS, so it answers through mainAwait/);

    const helped = await engine.mainAwait(['--help'], {});
    assert.equal(helped.code, 0);
    assert.ok(helped.stdout.startsWith('dispatch — the delegation engine'));
    assert.match((await engine.mainAwait(['frobnicate'], {})).stderr, /unknown verb: frobnicate/);
  });

  it('runCliAwait writes the waiting lane\'s streams, and runEntryPoint routes both lanes', async () => {
    const out = [];
    const err = [];
    const stream = (sink) => ({ write: (s) => sink.push(s) });
    const io = { stdout: stream(out), stderr: stream(err) };
    assert.equal(await engine.runCliAwait(['--help'], io), 0);
    assert.match(out[0], /^dispatch — the delegation engine/);
    assert.ok(out[0].endsWith('\n'), 'the writer terminates the line');

    const { ws } = laneToReturn();
    const ctx = { cwd: ws.cwd, env: ws.env, now: clock };
    assert.equal(await engine.runCliAwait(['await', '--nonce', CONTRACT.nonce], { ...io, ctx }), 0);
    assert.match(out[1], /ARRIVED/);

    // The routing rule itself, in-process: the waiting verb comes back through a promise, every
    // other one lands synchronously.
    const codes = [];
    await engine.runEntryPoint(['await', '--nonce', CONTRACT.nonce], (code) => codes.push(code), { ...io, ctx });
    engine.runEntryPoint(['--help'], (code) => codes.push(code), io);
    assert.deepEqual(codes, [0, 0]);
  });

  it('--cwd relocates the run and needs a value', () => {
    const ws = workspace();
    dispatchFile(ws, 'task.md', CONTRACT);
    assert.equal(main(['check', 'task.md', '--cwd', ws.cwd], { env: ws.env }).code, 0);
    assert.match(main(['check', 'task.md', '--cwd'], { env: ws.env }).stderr, /--cwd needs a value/);
  });

  // The kit is reached through managed symlinks (the documented Codex
  // skill install), and a URL-STRING entry comparison makes the CLI exit 0 having done nothing.
  // The spawned run is the only proof that crosses the process boundary; the in-process branch
  // tests below carry the coverage the changed-line gate requires.
  it('the entry point is decided by REAL PATH, so a symlinked invocation still runs the CLI', () => {
    const link = join(TMP, `dispatch-link-${seq += 1}.mjs`);
    symlinkSync(MODULE_PATH, link);
    const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^dispatch — the delegation engine/);
  });

  it('isEntryPoint compares real paths, refuses an absent entry, and falls back lexically', () => {
    const link = join(TMP, `entry-link-${seq += 1}.mjs`);
    symlinkSync(MODULE_PATH, link);
    assert.equal(engine.isEntryPoint(undefined, MODULE_PATH), false);
    assert.equal(engine.isEntryPoint('', MODULE_PATH), false);
    assert.equal(engine.isEntryPoint(link, MODULE_PATH), true, 'a symlinked entry IS this module');
    assert.equal(engine.isEntryPoint(join(TMP, 'someone-else.mjs'), MODULE_PATH), false);
    const unresolvable = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    assert.equal(engine.isEntryPoint(MODULE_PATH, MODULE_PATH, unresolvable), true, 'an unresolvable side falls back to the lexical resolve');
    assert.equal(engine.isEntryPoint(join(TMP, 'gone.mjs'), MODULE_PATH, unresolvable), false);
  });

  it('runCli writes stdout/stderr and returns the exit code', () => {
    const out = [];
    const err = [];
    const stream = (sink) => ({ write: (s) => sink.push(s) });
    assert.equal(runCli(['--help'], { stdout: stream(out), stderr: stream(err) }), 0);
    assert.match(out[0], /^dispatch — the delegation engine/);
    assert.ok(out[0].endsWith('\n'), 'the writer terminates the line');
    assert.equal(err.length, 0);
    assert.equal(runCli(['frobnicate'], { stdout: stream(out), stderr: stream(err) }), 2);
    assert.match(err[0], /unknown verb/);
  });
});

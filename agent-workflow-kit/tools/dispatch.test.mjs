import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  DELEGATION_SCHEMA_VERSION, DELEGATION_KEY_SETS, canonicalDelegationDigest, expectedBundleLength,
} from './dispatch-record.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from './dispatch-store.mjs';

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

// ── the CLI shell: help, routing, the --cwd seam, the process-facing writer ───────────────────────

describe('dispatch CLI shell', () => {
  it('--help states the FORM-only limit and every aggregate refusal by name', () => {
    const r = main(['--help'], {});
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(DISPATCH_CONTRACT));
    for (const phrase of ['no pre-registration record', 'OPEN thread in scope', 'several waves present with no --wave']) {
      assert.ok(r.stdout.includes(phrase), `--help must name the refusal: ${phrase}`);
    }
  });

  it('an unknown or absent verb is usage (exit 2)', () => {
    assert.match(main(['frobnicate'], {}).stderr, /unknown verb: frobnicate/);
    assert.match(main([], {}).stderr, /unknown verb: \(none\)/);
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

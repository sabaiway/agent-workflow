import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  EXEC_RECEIPT_SCHEMA_VERSION,
  EXEC_RECEIPT_KIND,
  EXEC_RECEIPT_STATES,
  EXEC_RECEIPT_KEYS,
  TERMINAL_ONLY_FIELDS,
  WRAPPER_OUTCOMES,
  execReceiptBasename,
  execReportBasename,
  validateExecReceipt,
  parseExecReceipt,
  wrapperOutcomeFor,
} from './exec-receipt.mjs';

const TS = '2026-08-10T00:00:00.000Z';
const D = (pair) => pair.repeat(32);
const CONTRACT_DIGEST = D('ab');
const REPORT_DIGEST = D('cd');
const POSTURE = { model: 'gpt-5.6-sol', effort: 'xhigh', tier: 'priority' };

const reserved = (over = {}) => ({
  schema: EXEC_RECEIPT_SCHEMA_VERSION,
  kind: EXEC_RECEIPT_KIND,
  state: 'reserved',
  backend: 'codex',
  nonce: 'n1',
  owner: 'run-4711',
  contractDigest: CONTRACT_DIGEST,
  wrapperVersion: '3.5.0',
  posture: { ...POSTURE },
  capS: 3600,
  killGraceS: 15,
  sessionId: null,
  exitStatus: null,
  outcome: null,
  reportDigest: null,
  reportLength: null,
  timestamp: TS,
  ...over,
});

const terminal = (over = {}) => reserved({
  state: 'terminal',
  sessionId: 'sess-1',
  exitStatus: 0,
  outcome: 'success',
  reportDigest: REPORT_DIGEST,
  reportLength: 120,
  ...over,
});

describe('exec-receipt — the closed vocabulary', () => {
  it('pins the states, the terminal-only fields and the wrapper outcome subset', () => {
    assert.deepEqual([...EXEC_RECEIPT_STATES], ['reserved', 'terminal']);
    assert.deepEqual([...TERMINAL_ONLY_FIELDS], ['sessionId', 'exitStatus', 'outcome', 'reportDigest', 'reportLength']);
    assert.deepEqual([...WRAPPER_OUTCOMES], ['success', 'transport-failure', 'missing-identity']);
  });

  it('freezes every exported set', () => {
    assert.ok(Object.isFrozen(EXEC_RECEIPT_STATES) && Object.isFrozen(EXEC_RECEIPT_KEYS));
    assert.ok(Object.isFrozen(TERMINAL_ONLY_FIELDS) && Object.isFrozen(WRAPPER_OUTCOMES));
  });

  it('accepts a well-formed reservation and a well-formed terminal receipt', () => {
    assert.deepEqual(validateExecReceipt(reserved()), { ok: true });
    assert.deepEqual(validateExecReceipt(terminal()), { ok: true });
  });
});

describe('exec-receipt — the state contract', () => {
  it('a reserved receipt carries wrapperVersion, posture, capS and killGraceS', () => {
    const r = reserved();
    assert.equal(r.wrapperVersion, '3.5.0');
    assert.deepEqual(r.posture, POSTURE);
    assert.equal(r.capS, 3600);
    assert.equal(r.killGraceS, 15);
    assert.deepEqual(validateExecReceipt(r), { ok: true });
  });

  for (const field of ['sessionId', 'exitStatus', 'outcome', 'reportDigest', 'reportLength']) {
    it(`a reserved receipt that fills the terminal-only field "${field}" refuses`, () => {
      const filler = { sessionId: 'sess-1', exitStatus: 0, outcome: 'success', reportDigest: REPORT_DIGEST, reportLength: 1 };
      const result = validateExecReceipt(reserved({ [field]: filler[field] }));
      assert.equal(result.ok, false);
      assert.match(result.reason, new RegExp(`RESERVED receipt carries null in every terminal-only field — "${field}"`));
    });
  }

  for (const field of ['exitStatus', 'outcome', 'reportLength']) {
    it(`a terminal receipt with a null "${field}" refuses as a mislabelled reservation`, () => {
      const result = validateExecReceipt(terminal({ [field]: null }));
      assert.equal(result.ok, false);
      assert.match(result.reason, /reservation wearing the terminal label/);
    });
  }
});

describe('exec-receipt — the D3 outcome mapping is total', () => {
  it('success requires exitStatus 0', () => {
    const result = validateExecReceipt(terminal({ exitStatus: 2 }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /"success" requires exitStatus 0/);
  });

  it('success requires a non-null sessionId', () => {
    const result = validateExecReceipt(terminal({ sessionId: null }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /"success" requires a non-null sessionId/);
  });

  it('missing-identity requires exit 0 and a null sessionId', () => {
    assert.deepEqual(validateExecReceipt(terminal({ outcome: 'missing-identity', sessionId: null })), { ok: true });
    const withSession = validateExecReceipt(terminal({ outcome: 'missing-identity' }));
    assert.equal(withSession.ok, false);
    assert.match(withSession.reason, /requires sessionId null/);
    const nonzero = validateExecReceipt(terminal({ outcome: 'missing-identity', sessionId: null, exitStatus: 1 }));
    assert.equal(nonzero.ok, false);
    assert.match(nonzero.reason, /"missing-identity" requires exitStatus 0/);
  });

  it('transport-failure requires a nonzero exitStatus', () => {
    assert.deepEqual(validateExecReceipt(terminal({ outcome: 'transport-failure', exitStatus: 124 })), { ok: true });
    const zero = validateExecReceipt(terminal({ outcome: 'transport-failure' }));
    assert.equal(zero.ok, false);
    assert.match(zero.reason, /"transport-failure" requires a nonzero exitStatus/);
  });

  it('the wrapper outcome subset is closed — an orchestrator judgment refuses', () => {
    for (const outcome of ['partial-edit', 'acceptance-failure', 'stale-return', 'store-failure', 'contract-refusal']) {
      const result = validateExecReceipt(terminal({ outcome }));
      assert.equal(result.ok, false, `${outcome} must not be expressible on a wrapper receipt`);
      assert.match(result.reason, /outcome must be one of/);
    }
  });

  it('wrapperOutcomeFor is the ONE mapping both packages read', () => {
    assert.equal(wrapperOutcomeFor(0, 'sess-1'), 'success');
    assert.equal(wrapperOutcomeFor(0, null), 'missing-identity');
    assert.equal(wrapperOutcomeFor(1, 'sess-1'), 'transport-failure');
    assert.equal(wrapperOutcomeFor(124, null), 'transport-failure');
    assert.equal(wrapperOutcomeFor(137, null), 'transport-failure');
    assert.equal(wrapperOutcomeFor(-1, null), null);
  });
});

describe('exec-receipt — report-if-present', () => {
  it('a TERMINAL receipt with NO report refuses — the publication order puts the report first', () => {
    const result = validateExecReceipt(terminal({ reportDigest: null, reportLength: 0 }));
    assert.equal(result.ok, false, 'the wrapper writes the report atomically BEFORE it replaces the reservation, and exits nonzero without a terminal receipt when that write fails — so a terminal artifact with no report behind it is a state no honest run can mint');
    assert.match(result.reason, /requires a reportDigest/);
  });

  it('a reservation still carries null in BOTH report fields', () => {
    assert.deepEqual(validateExecReceipt(reserved()), { ok: true });
    assert.equal(reserved().reportDigest, null);
    assert.equal(reserved().reportLength, null);
  });

  it('a length without a digest refuses', () => {
    const result = validateExecReceipt(terminal({ reportDigest: null, reportLength: 7 }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /requires a reportDigest/);
  });

  it('a PRESENT but empty report is expressible — digest plus length 0', () => {
    const emptyDigest = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    assert.deepEqual(validateExecReceipt(terminal({ reportDigest: emptyDigest, reportLength: 0 })), { ok: true });
  });
});

describe('exec-receipt — fail-closed in both directions', () => {
  it('an unknown schema, kind or state refuses by name', () => {
    assert.match(validateExecReceipt(reserved({ schema: 2 })).reason, /unknown schema/);
    assert.match(validateExecReceipt(reserved({ kind: 'review-receipt' })).reason, /unknown kind/);
    assert.match(validateExecReceipt(reserved({ state: 'pending' })).reason, /state must be one of/);
  });

  it('an unknown extra field refuses — the key set is closed', () => {
    const result = validateExecReceipt(reserved({ delivery: 'chunked' }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown field "delivery"/);
  });

  it('a missing field refuses by name', () => {
    const r = reserved();
    delete r.capS;
    assert.match(validateExecReceipt(r).reason, /missing field "capS"/);
  });

  it('an accessor field refuses without being invoked', () => {
    const r = reserved();
    let reads = 0;
    Object.defineProperty(r, 'owner', { enumerable: true, get: () => { reads += 1; return 'run-4711'; } });
    const result = validateExecReceipt(r);
    assert.equal(result.ok, false);
    assert.match(result.reason, /field "owner" is an ACCESSOR/);
    assert.equal(reads, 0);
  });

  it('a throwing getter on an identity field refuses instead of escaping', () => {
    const r = reserved();
    Object.defineProperty(r, 'kind', { enumerable: true, get: () => { throw new Error('boom'); } });
    assert.match(validateExecReceipt(r).reason, /field "kind" is an ACCESSOR/);
  });

  it('a digest field carrying anything but bare 64-hex refuses', () => {
    for (const bad of [`${REPORT_DIGEST}  report.txt`, REPORT_DIGEST.toUpperCase(), REPORT_DIGEST.slice(0, 63), '']) {
      const result = validateExecReceipt(terminal({ reportDigest: bad }));
      assert.equal(result.ok, false, `"${bad}" must refuse`);
    }
  });

  it('a field value that cannot be serialised is still NAMED in the refusal', () => {
    // The refusal quotes the offending value, and JSON.stringify THROWS on a BigInt — a reader that
    // let that escape would turn a refusal into a crash.
    const result = validateExecReceipt(reserved({ capS: 10n }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /unserializable bigint/);
  });

  it('a non-object, a null and an array all refuse', () => {
    for (const bad of [null, 'x', 42, []]) assert.equal(validateExecReceipt(bad).ok, false);
  });

  it('the posture object is closed and typed', () => {
    assert.match(validateExecReceipt(reserved({ posture: { ...POSTURE, timeout: '30m' } })).reason, /posture: unknown field "timeout"/);
    assert.match(validateExecReceipt(reserved({ posture: { model: 'm', effort: 'x' } })).reason, /posture: missing field "tier"/);
    assert.match(validateExecReceipt(reserved({ posture: { ...POSTURE, model: '' } })).reason, /posture: model must be/);
    assert.deepEqual(validateExecReceipt(reserved({ posture: { ...POSTURE, tier: null } })), { ok: true });
  });

  it('capS must be positive and killGraceS non-negative', () => {
    assert.match(validateExecReceipt(reserved({ capS: 0 })).reason, /capS must be/);
    assert.match(validateExecReceipt(reserved({ killGraceS: -1 })).reason, /killGraceS must be/);
    assert.deepEqual(validateExecReceipt(reserved({ killGraceS: 0 })), { ok: true });
  });

  it('the timestamp must round-trip through toISOString', () => {
    assert.match(validateExecReceipt(reserved({ timestamp: '2026-08-10T00:00:00Z' })).reason, /timestamp must be/);
  });
});

describe('exec-receipt — the artifact naming grammar', () => {
  it('composes the {backend, nonce}-derived names', () => {
    assert.equal(execReceiptBasename('codex', 'n1'), 'agent-workflow-exec-receipt-5-codex-n1.json');
    assert.equal(execReportBasename('codex', 'n1'), 'agent-workflow-exec-report-5-codex-n1.txt');
  });

  // The name keeps the words "the backend token is hyphen-free" because a declared red-proof binds
  // this test by that pattern and a declaration is one-way — but it names the ABANDONED design, and
  // the assertions below are what the contract actually is.
  it('"the backend token is hyphen-free" was the abandoned design — the name is LENGTH-PREFIXED instead', () => {
    // Both tokens share the safe grammar, which admits `-`, so the name is LENGTH-PREFIXED: the two
    // pairs below would otherwise compose the same file and the no-clobber reservation would refuse
    // a genuinely different dispatch.
    assert.equal(execReceiptBasename('a-b', 'c'), 'agent-workflow-exec-receipt-3-a-b-c.json');
    assert.equal(execReceiptBasename('a', 'b-c'), 'agent-workflow-exec-receipt-1-a-b-c.json');
    assert.notEqual(execReceiptBasename('a-b', 'c'), execReceiptBasename('a', 'b-c'));
    assert.equal(execReportBasename('a-b', 'c'), 'agent-workflow-exec-report-3-a-b-c.txt');
    assert.equal(execReceiptBasename('codex', 'n1'), 'agent-workflow-exec-receipt-5-codex-n1.json');
    // A hyphenated backend is a VALID dispatch (dispatch-record admits any safe token), so it must
    // stay expressible here — a receipt is never invalid while the ledger accepts its dispatch.
    assert.deepEqual(validateExecReceipt(reserved({ backend: 'codex-cli-bridge' })), { ok: true });
    assert.deepEqual(validateExecReceipt(reserved({ nonce: 'b-c' })), { ok: true });
  });

  it('refuses a token outside the safe grammar — a name never escapes its directory', () => {
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a b', 'nönce']) {
      assert.equal(execReceiptBasename('codex', bad), null, `nonce "${bad}" must not compose a name`);
      assert.equal(execReceiptBasename(bad, 'n1'), null, `backend "${bad}" must not compose a name`);
      assert.equal(execReportBasename('codex', bad), null, `nonce "${bad}" must not compose a report name`);
    }
  });
});

describe('exec-receipt — parsing', () => {
  it('parses valid bytes into the receipt', () => {
    const parsed = parseExecReceipt(JSON.stringify(terminal()));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.receipt.nonce, 'n1');
  });

  it('refuses non-text, invalid JSON and a valid-JSON non-receipt', () => {
    assert.match(parseExecReceipt(Buffer.from('{}')).reason, /must be text/);
    assert.match(parseExecReceipt('{not json').reason, /not valid JSON/);
    assert.match(parseExecReceipt('{"schema":1}').reason, /missing field "kind"/);
  });
});

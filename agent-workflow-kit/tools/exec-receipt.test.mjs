import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { checkDispatchContractForm, contractDigest } from './dispatch-record.mjs';
import { resolveDelegationStorePath } from './dispatch-store.mjs';

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
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(65), 'a b', 'n\u00f6nce']) {
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

// ── cross-package parity: the bytes the WRAPPER really mints ──────────────────────────────────────
// Everything above pins the contract against fixtures this file wrote. That proves the reader, not
// the agreement: the producer lives in another package, in another language, and the two could hold
// consistent-but-different beliefs indefinitely. So this suite drives the real
// codex-cli-bridge/bin/codex-exec.sh against a fake CLI and asserts the artifact it leaves behind
// parses HERE without refusal — the settings-valid-parity / posture-parity precedent. Two
// independently computed values are compared, never copied: the wrapper's contractDigest against
// dispatch-record's, and the wrapper's artifact directory against the delegation store's own
// resolution.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(REPO_ROOT, 'codex-cli-bridge', 'bin', 'codex-exec.sh');

const FAKE_CODEX = [
  '#!/usr/bin/env bash',
  'set -u',
  'if [[ "${1:-}" == "login" ]]; then echo "Logged in using ChatGPT"; exit 0; fi',
  'out=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [[ "$prev" == "-o" ]]; then out="$a"; fi',
  '  prev="$a"',
  'done',
  'cat >/dev/null',
  'if [[ -n "$out" ]]; then echo "the delegate reports back" >"$out"; fi',
  // A heredoc, never `echo` — an unquoted JSON literal hits brace expansion and the thread id is lost.
  'cat <<EOF',
  '{"type":"thread.started","thread_id":"sess-parity"}',
  'EOF',
  'exit 0',
  '',
].join('\n');

const CONTRACT = {
  schema: 1,
  nonce: 'parity.1',
  stepClass: 'code',
  vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'the bounded sub-task',
  inputs: 'the files it may touch',
  acceptance: 'the named tests',
  returnShape: 'a diff plus a report',
  producerContract: 'wrapper-git',
  deadlineS: 3700,
  retry: { cap: 1, index: 0 },
};

// One wrapper run, shared by every assertion below: the run costs ~200ms and nothing in it varies.
const minted = (() => {
  const root = mkdtempSync(join(tmpdir(), 'exec-receipt-parity-'));
  const bin = join(root, 'bin');
  const repo = join(root, 'repo');
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'probe@example.com');
  git('config', 'user.name', 'probe');
  writeFileSync(join(repo, 'AGENTS.md'), '# AGENTS\n\nHard Constraints: none (test fixture).\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const fence = '```';
  const contractFile = 'sub-task.md';
  writeFileSync(join(repo, contractFile), `# sub-task\n\n${fence}aw-dispatch-contract\n${JSON.stringify(CONTRACT, null, 2)}\n${fence}\n`);
  const run = spawnSync('bash', [WRAPPER, '--nonce', CONTRACT.nonce, contractFile], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: repo, TMPDIR: process.env.TMPDIR ?? '/tmp' },
  });
  const dir = resolveDelegationStorePath(repo) === null ? null : dirname(resolveDelegationStorePath(repo));
  const read = (name) => {
    try { return readFileSync(join(dir, name)); } catch { return null; }
  };
  const receiptBytes = read(execReceiptBasename('codex', CONTRACT.nonce));
  const reportBytes = read(execReportBasename('codex', CONTRACT.nonce));
  rmSync(root, { recursive: true, force: true });
  return { run, dir, receiptBytes, reportBytes };
})();

describe('exec-receipt — the WRAPPER and this reader agree (cross-package parity)', () => {
  it('the wrapper run lands where the delegation store resolves — one directory, two packages', () => {
    assert.equal(minted.run.status, 0, minted.run.stderr);
    assert.notEqual(minted.dir, null, 'the fixture repo must resolve a delegation store path');
    assert.notEqual(minted.receiptBytes, null, `no receipt under ${minted.dir}: ${minted.run.stderr}`);
    assert.notEqual(minted.reportBytes, null, 'the report rides beside the receipt');
  });

  it('the bytes the wrapper minted parse under THIS reader without refusal', () => {
    const parsed = parseExecReceipt(minted.receiptBytes.toString('utf8'));
    assert.equal(parsed.ok, true, `the wrapper minted bytes this reader refuses: ${parsed.reason}`);
    const receipt = parsed.receipt;
    assert.equal(receipt.state, 'terminal');
    assert.equal(receipt.backend, 'codex');
    assert.equal(receipt.nonce, CONTRACT.nonce);
    assert.equal(receipt.sessionId, 'sess-parity');
    assert.equal(receipt.exitStatus, 0);
    assert.equal(receipt.outcome, wrapperOutcomeFor(receipt.exitStatus, receipt.sessionId), 'the D3 mapping is ONE rule, not two implementations that agree today');
  });

  it('the report the wrapper published is exactly what its receipt describes', () => {
    const receipt = parseExecReceipt(minted.receiptBytes.toString('utf8')).receipt;
    assert.equal(receipt.reportLength, minted.reportBytes.length);
    assert.equal(receipt.reportDigest, createHash('sha256').update(minted.reportBytes).digest('hex'));
  });

  it('the wrapper computed the SAME contractDigest this kit computes — independently, from the same header', () => {
    const receipt = parseExecReceipt(minted.receiptBytes.toString('utf8')).receipt;
    const fence = '```';
    const form = checkDispatchContractForm(`# sub-task\n\n${fence}aw-dispatch-contract\n${JSON.stringify(CONTRACT, null, 2)}\n${fence}\n`);
    assert.equal(form.ok, true, form.reason);
    assert.equal(receipt.contractDigest, contractDigest(form.contract),
      'the two canonicalizations must agree, or `dispatch return` would refuse every honest run');
  });

  it('the wrapperVersion it stamps is the bridge version the release lane bumps', () => {
    const receipt = parseExecReceipt(minted.receiptBytes.toString('utf8')).receipt;
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'codex-cli-bridge', 'capability.json'), 'utf8'));
    assert.equal(receipt.wrapperVersion, manifest.version);
  });
});

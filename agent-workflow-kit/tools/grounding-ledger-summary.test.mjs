// grounding-ledger-summary.test.mjs — the (e) --ledger-summary source (BUGFREE-3 / AD-049): a
// deterministic, loop/base-SCOPED digest of the in-flight plan-execution segment (unrelated loops
// excluded), empty when the segment holds no records, resolved to the SINGLE in-flight plan, and
// tail-trimmed to the byte budget like every other grounding source.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderLedgerSummary, main } from './grounding.mjs';
import { resolveBase } from './review-ledger.mjs';

const BASE = 'BASE00000001';
const OTHER_BASE = 'BASEfeeddead';
const round = (loop, base, r, backends, findings, origins) => ({ schema: 4, loop, activity: 'plan-execution', kind: 'round', round: r, base, fingerprint: 'fp', origins, backends, findings, timestamp: 't' });
const triage = (loop, base, r, classifications) => ({ schema: 4, loop, activity: 'plan-execution', kind: 'triage', round: r, base, fingerprint: 'fp', classifications, timestamp: 't' });
const override = (loop, base, r, extra) => ({ schema: 4, loop, activity: 'plan-execution', kind: 'override', round: r, base, fingerprint: 'fp', reason: 'big segment', timestamp: 't', ...extra });

const codex = (b, m, mi, verdict) => ({ backend: 'codex', degraded: false, blockers: b, majors: m, minors: mi, verdict });
const agy = (b, m, mi, verdict) => ({ backend: 'agy', degraded: false, blockers: b, majors: m, minors: mi, verdict });

// A fixture ledger: the in-flight `demo` segment + an unrelated `other` loop that must be excluded.
const fixtureRecords = (base) => [
  round('demo', base, 1, [codex(0, 0, 0, 'ship'), agy(1, 0, 0, 'revise')], [{ findingKey: 'F1', severity: 'blocker', origin: 'first-draft', backend: 'agy' }], { 'first-draft': 1, 'fold-induced': 0, mechanics: 0 }),
  triage('demo', base, 1, [{ findingKey: 'F1', class: 'fixable-bug', accepted: false, testId: 't.mjs#F1', note: '' }]),
  override('demo', base, 2, { scope: 'size-cap', sanctionedLines: 500 }),
  round('demo', base, 2, [codex(0, 0, 0, 'ship'), agy(0, 0, 0, 'ship')], [], { 'first-draft': 0, 'fold-induced': 0, mechanics: 0 }),
  round('other', base, 1, [codex(0, 1, 0, 'revise')], [{ findingKey: 'OTHERBUG', severity: 'major', origin: 'first-draft', backend: 'codex' }], { 'first-draft': 1, 'fold-induced': 0, mechanics: 0 }),
];

describe('renderLedgerSummary — scoped to one segment', () => {
  it('renders the in-flight loop and EXCLUDES unrelated loops', () => {
    const out = renderLedgerSummary(fixtureRecords(BASE), { loop: 'demo', base: BASE });
    assert.match(out, /loop demo @ base BASE00000001/);
    assert.match(out, /rounds 2/);
    assert.match(out, /F1\(blocker\)/);
    assert.match(out, /F1=fixable-bug/);
    assert.match(out, /\[size-cap\] — sanctioned 500 lines/);
    assert.match(out, /classifications — fixable-bug:1/);
    assert.doesNotMatch(out, /OTHERBUG/, 'the unrelated loop must be excluded');
  });

  it('an empty ledger → empty string (nothing to ground)', () => {
    assert.equal(renderLedgerSummary([], { loop: 'demo', base: BASE }), '');
  });

  it('a segment at a different base → empty string (pre-commit / other-segment records excluded)', () => {
    assert.equal(renderLedgerSummary(fixtureRecords(BASE), { loop: 'demo', base: OTHER_BASE }), '');
  });
});

// ── integration: main --ledger-summary over a real repo + AW_REVIEW_LEDGER fixture ──────
const makeRepo = ({ plans = ['demo.md'] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'grounding-ls-'));
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e.com');
  g('config', 'user.name', 'p');
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  for (const p of plans) writeFileSync(join(root, 'docs', 'plans', p), '# plan\n');
  return root;
};

describe('main --ledger-summary', () => {
  it('emits the scoped section for the single in-flight plan, and honors the byte budget', () => {
    const root = makeRepo();
    const base = resolveBase(root);
    const ledger = join(root, 'ledger.jsonl');
    writeFileSync(ledger, fixtureRecords(base).map((r) => JSON.stringify(r)).join('\n') + '\n');

    const ok = main(['--ledger-summary'], { cwd: root, env: { AW_REVIEW_LEDGER: ledger } });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Review-ledger summary — loop demo/);
    assert.match(ok.stdout, /F1=fixable-bug/);

    const trimmed = main(['--ledger-summary'], { cwd: root, env: { AW_REVIEW_LEDGER: ledger, AGY_MAX_PROMPT_BYTES: '120' } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(trimmed.code, 0, trimmed.stderr);
    assert.match(trimmed.stdout, /TRIMMED/, 'over-budget output is tail-trimmed with a loud in-band marker');
    assert.ok(Buffer.byteLength(trimmed.stdout, 'utf8') <= 120, 'output never exceeds the budget');
  });

  it('a loud STOP unless exactly one plan is in flight', () => {
    const root = makeRepo({ plans: ['demo.md', 'second.md'] });
    const r = main(['--ledger-summary'], { cwd: root, env: {} });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exactly one in-flight plan/);
  });

  // Fail-CLOSED like every sibling ledger reader (No-silent-failures): an unreadable OR malformed
  // ledger must never render an empty/partial digest the reviewer then silently grounds against.
  it('fails CLOSED (loud) when the ledger is unreadable — never a silent empty digest', () => {
    const root = makeRepo();
    // AW_REVIEW_LEDGER pointing at a DIRECTORY → readFileSync throws EISDIR → readLedger.readError.
    const r = main(['--ledger-summary'], { cwd: root, env: { AW_REVIEW_LEDGER: root } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1, 'an unreadable ledger must fail closed, not render empty at exit 0');
    assert.match(r.stderr, /cannot read the ledger|failing closed/);
  });

  it('fails CLOSED (loud) when the ledger has a malformed line — a dropped line could hide a round', () => {
    const root = makeRepo();
    const ledger = join(root, 'ledger.jsonl');
    writeFileSync(ledger, 'not json at all\n');
    const r = main(['--ledger-summary'], { cwd: root, env: { AW_REVIEW_LEDGER: ledger } });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /malformed/);
  });
});

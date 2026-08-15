// doc-parity.test.mjs — the deterministic doc-drift lint (BUGFREE-3 / AD-049, item (b)): a stale
// token fails, a matching set passes, an unreadable/absent binding fails closed, and the REAL
// registry is consistent with the shipped references/modes/*.md contract (the dogfood).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkBinding, checkParity, BINDINGS, main } from './doc-parity.mjs';
import { INCLUDE_IDENTITY_RULE, RESUME_VERIFY_RULE } from './worktrees.mjs';
import { DISPATCH_CONTRACT } from './dispatch.mjs';
import { FLOW_SCHEMA_VERSION, FLOW_LAGGING_KIT_CONTRACT } from './orchestration-config.mjs';
import { COVERAGE_PRODUCER_BODY } from './coverage-producer.mjs';
// Through the NAMESPACE, not named imports: the relayed-cause export is what this contract
// introduces, and a red-first test has to LOAD against the pre-fix module.
import * as ensureVocabulary from './ensure-vocabulary.mjs';

// A synthetic file surface: rel → text. A rel absent from the map THROWS (fails closed like a real
// unreadable file).
const surface = (map) => (rel) => {
  if (!(rel in map)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return map[rel];
};

describe('checkBinding — value drift is detected', () => {
  const binding = { constant: 'DEFAULT_DIFF_CAP', value: 400, token: 'default 400', files: ['doc.md'] };

  it('passes when the doc carries the current-value token', () => {
    const r = checkBinding(binding, surface({ 'doc.md': '...the default 400 new-side lines...' }));
    assert.equal(r.ok, true);
  });

  it('FAILS a stale doc (says 300 while the constant is 400)', () => {
    const r = checkBinding(binding, surface({ 'doc.md': '...the default 300 new-side lines...' }));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /not found/);
  });

  it('FAILS CLOSED when a bound file is unreadable', () => {
    const r = checkBinding(binding, surface({}));
    assert.equal(r.ok, false);
    assert.match(r.files[0].reason, /unreadable/);
  });

  it('requires the token in EVERY bound file (one drifted file fails the binding)', () => {
    const multi = { constant: 'X', value: 1, token: 'v1', files: ['a.md', 'b.md'] };
    const r = checkBinding(multi, surface({ 'a.md': 'has v1', 'b.md': 'missing it' }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.files.map((f) => f.ok), [true, false]);
  });
});

describe('checkParity + main — over a synthetic registry', () => {
  const bindings = [
    { constant: 'CAP', value: 400, token: 'cap 400', files: ['x.md'] },
    { constant: 'vocab:refuted', value: 'refuted', token: 'refuted', files: ['x.md'] },
  ];

  it('a matching set passes every binding', () => {
    const results = checkParity(bindings, surface({ 'x.md': 'the cap 400 and the refuted lane' }));
    assert.ok(results.every((r) => r.ok));
  });

  it('a stale token fails closed under checkParity', () => {
    const results = checkParity(bindings, surface({ 'x.md': 'the cap 300 and the refuted lane' }));
    assert.equal(results.find((r) => r.constant === 'CAP').ok, false);
  });
});

describe('the REAL registry is consistent with the shipped contract docs (dogfood)', () => {
  it('every binding renders into its bound references/modes/*.md file', () => {
    const results = checkParity(); // real BINDINGS + real files
    const drifted = results.filter((r) => !r.ok);
    assert.deepEqual(
      drifted.map((r) => ({ constant: r.constant, misses: r.files.filter((f) => !f.ok).map((f) => f.rel) })),
      [],
      'a drifted binding means a mode doc lags a code constant — update the doc in the same edit as the code',
    );
  });

  it('--check over the real registry exits 0 (the dogfood gate is green)', () => {
    const r = main(['--check']);
    assert.equal(r.code, 0, r.stdout);
  });

  it('the registry carries NO binding into the deleted ledger/fold contracts (they died with their tools)', () => {
    const names = BINDINGS.map((b) => b.constant);
    for (const c of ['SCHEMA_VERSION', 'HARD_MAX', 'DEFAULT_DIFF_CAP', 'REVIEW_CAP', 'RESULT_SCHEMA_VERSION']) {
      assert.ok(!names.includes(c), `the deleted-contract binding ${c} must not survive`);
    }
    assert.ok(!names.some((n) => n.startsWith('vocab:')), 'the ledger vocabulary died with the ledger');
  });

  // AD-055 Part I: the ack-store path drift guard must itself be pinned — a deleted binding would
  // otherwise leave the whole suite green and silently disable the guard.
  it('the registry binds ACKS_FILE (docs/ai/acks.json) to the recommendations AND velocity mode docs', () => {
    const acks = BINDINGS.find((b) => b.constant === 'acks-file');
    assert.ok(acks, 'registry must bind the ACKS_FILE apply target (the ack-store path drift guard)');
    assert.equal(acks.token, 'docs/ai/acks.json', 'the token is the family-owned ack store path');
    assert.deepEqual([...acks.files].sort(), ['references/modes/recommendations.md', 'references/modes/velocity.md']);
  });

  // AD-056: the refresh read-only degrade outcome (skipped-readonly) is doc-pinned to the setup +
  // upgrade mode contracts, so a reworded doc cannot silently drop the new outcome token.
  it('the registry binds SKIPPED_READONLY (skipped-readonly) to the setup AND upgrade mode docs', () => {
    const binding = BINDINGS.find((b) => b.constant === 'refresh-skipped-readonly');
    assert.ok(binding, 'registry must bind the skipped-readonly refresh outcome (the read-only degrade doc pin)');
    assert.equal(binding.token, 'skipped-readonly', 'the token is the exported outcome constant');
    assert.deepEqual([...binding.files].sort(), ['references/modes/setup.md', 'references/modes/upgrade.md']);
  });

  // The parity verdict that outcome carries (feedback-hardening Plan 1 F3). A DELETION pin, not a
  // value pin: the bindings ride a spread over PARITY, so deleting the spread would leave the
  // dogfood --check green (nothing missing to find) while the docs went free to re-promise a claim
  // the tool no longer makes. Exactly three, their backticked tokens, and both bound docs.
  it('the registry binds ALL THREE refresh-parity verdicts to the setup AND upgrade mode docs', () => {
    const bound = BINDINGS.filter((b) => b.constant.startsWith('refresh-parity:'));
    assert.equal(bound.length, 3, 'the verdict set is CLOSED at three — a dropped spread fails here');
    assert.deepEqual(bound.map((b) => b.token).sort(), ['`clean-parity`', '`drifted`', '`unverifiable`'],
      'backticked, so a bare word in prose cannot pass for the pinned token');
    for (const b of bound) {
      assert.deepEqual([...b.files].sort(), ['references/modes/setup.md', 'references/modes/upgrade.md'],
        `${b.constant} must be bound in BOTH docs that enumerate the refresh outcomes`);
    }
  });

  // The D9 promise "every failure cause lands in the relay" (index-navigator hotfix): the ensures'
  // cause vocabulary is closed, and the mode doc that relays a `failed` line has to teach every word
  // that can open one. A DELETION pin like the parity verdicts above — the bindings ride a spread
  // over RELAYED_FAILURE_CAUSES, so dropping the spread would leave --check green while the doc went
  // free to relay a cause it never named.
  it('the registry binds EVERY relayed failure cause to the upgrade mode doc', () => {
    const relayed = ensureVocabulary.RELAYED_FAILURE_CAUSES ?? [];
    const bound = BINDINGS.filter((b) => b.constant.startsWith('ensure-cause:'));
    assert.ok(relayed.length > 0, 'the relayed-cause export must exist and be non-empty');
    assert.equal(bound.length, relayed.length, 'the cause set is CLOSED — a dropped spread fails here');
    assert.deepEqual(
      bound.map((b) => b.token).sort(),
      [...relayed].map((cause) => `\`${cause}\``).sort(),
      'backticked, so a bare word in prose cannot pass for the pinned cause',
    );
    for (const b of bound) {
      assert.deepEqual([...b.files], ['references/modes/upgrade.md'], `${b.constant} must be bound in the doc that relays it`);
    }
  });

  it('every D9 index cause is IN the relayed set (the promise, not just the spread)', () => {
    for (const cause of ['generator-unlaunchable', 'generator-failed', 'index-probe-failed', 'index-stale-after-write']) {
      assert.ok(ensureVocabulary.FAILURE_CAUSES.includes(cause), `${cause} must be a closed cause`);
      assert.ok((ensureVocabulary.RELAYED_FAILURE_CAUSES ?? []).includes(cause), `${cause} must be relayed to the mode doc`);
    }
  });

  it('a doc that drops one relayed cause goes RED (non-vacuous)', () => {
    const binding = BINDINGS.find((b) => b.constant === 'ensure-cause:index-stale-after-write');
    assert.ok(binding, 'registry must bind the index write-verification cause');
    const doc = 'references/modes/upgrade.md';
    assert.equal(checkBinding(binding, surface({ [doc]: 'the line opens with `index-stale-after-write` — relay it' })).ok, true);
    assert.equal(checkBinding(binding, surface({ [doc]: 'the line opens with its cause — relay it' })).ok, false);
  });

  // The "the tool knows and does not say" contract: a clean-tree PASS must still name a latent arm.
  // It was a prose-only bar before, so a deleted binding would leave the suite green and silently
  // re-open the drift it closes.
  it('the registry binds the worktrees provision-record orientation contract to the worktrees mode doc', () => {
    for (const constant of ['queue-shared-rule', 'landing-from-main', 'no-dependencies-posture']) {
      const binding = BINDINGS.find((b) => b.constant === constant);
      assert.ok(binding, `registry must bind ${constant} (the provision-record orientation contract)`);
      assert.deepEqual([...binding.files].sort(), ['references/modes/worktrees.md']);
    }
    assert.equal(
      BINDINGS.find((b) => b.constant === 'landing-from-main').token,
      'landing runs FROM MAIN, never from this worktree',
    );
    assert.equal(
      BINDINGS.find((b) => b.constant === 'no-dependencies-posture').token,
      'no install needed — the project declares no dependencies',
      'the token is the live recorded posture',
    );
    assert.match(
      BINDINGS.find((b) => b.constant === 'queue-shared-rule').token,
      /never copy it into this worktree/,
      'the queue rule token states the prohibition',
    );
  });

  // kit-inert-gate Phase 2 / Decision 8: the coverage= vocabulary is a CLOSED set the gates contract
  // doc must enumerate. Binding every value makes the docs-first rule mechanical — a fifth value, or
  // a renamed one, fails this gate instead of quietly leaving the contract doc describing a
  // vocabulary the runner no longer speaks.
  it('the registry binds every coverage= value to the gates mode doc', () => {
    for (const value of ['certified', 'not-run', 'none', 'unknown']) {
      const binding = BINDINGS.find((b) => b.constant === `coverage-state:${value}`);
      assert.ok(binding, `registry must bind the coverage=${value} summary value`);
      assert.equal(binding.token, `\`coverage=${value}\``);
      assert.deepEqual([...binding.files].sort(), ['references/modes/gates.md']);
    }
    assert.equal(
      BINDINGS.filter((b) => b.constant.startsWith('coverage-state:')).length,
      4,
      'the vocabulary is closed at four values — a new one is bound here or it is not shipped',
    );
  });

  // The gates contract doc prints the canonical suite command byte for byte, so it is a HAND COPY
  // of a constant that has already moved once. Without this pin, deleting the binding would shrink
  // BINDINGS and leave every dogfood check green — the guard disarmed in silence.
  it('doc-parity registry carries the coverage producer body binding', () => {
    const binding = BINDINGS.find((b) => b.constant === 'coverage-producer-body');
    assert.ok(binding, 'registry must bind the canonical producer body to the gates contract doc');
    assert.equal(binding.value, COVERAGE_PRODUCER_BODY, 'the binding tracks the LIVE constant, never re-typed bytes');
    assert.equal(binding.token, COVERAGE_PRODUCER_BODY, 'the doc must carry the whole command, not a fragment');
    assert.deepEqual([...binding.files].sort(), ['references/modes/gates.md']);
    assert.match(main(['--help']).stdout, /coverage-producer-body/, 'the HELP inventory must name the binding');
  });

  it('doc-parity registry carries the worktrees cleanup-ownership binding', () => {
    const binding = BINDINGS.find((b) => b.constant === 'cleanup-ownership-rule');
    assert.ok(binding, 'registry must bind the cleanup-ownership contract (AD-069)');
    assert.deepEqual([...binding.files].sort(), ['references/modes/worktrees.md']);
    assert.match(binding.token, /raw target bytes/, 'the token states the strict-bytes contract');
    assert.match(binding.token, /ignored lane/, 'the token states the single exempt lane');
    const helpResult = main(['--help']);
    assert.match(helpResult.stdout, /cleanup-ownership/, 'the HELP inventory must name the binding');
  });

  it('doc-parity registry carries the worktrees include-identity binding (F3)', () => {
    const binding = BINDINGS.find((b) => b.constant === 'include-identity-rule');
    assert.ok(binding, 'registry must bind the include-identity contract (F3)');
    assert.deepEqual([...binding.files].sort(), ['references/modes/worktrees.md']);
    assert.equal(binding.token, INCLUDE_IDENTITY_RULE, 'the token is the live exported constant');
    assert.match(binding.token, /door-time queue/, 'the token states the door-time queue refusal');
    assert.match(binding.token, /preflight recorded/, 'the token states the preflight identity binding');
    const helpResult = main(['--help']);
    assert.match(helpResult.stdout, /include-identity/, 'the HELP inventory must name the binding');
  });

  it('doc-parity registry carries the worktrees resume-verify binding (slice R2)', () => {
    const binding = BINDINGS.find((b) => b.constant === 'resume-verify-rule');
    assert.ok(binding, 'registry must bind the resume-verify contract (D6)');
    assert.deepEqual([...binding.files].sort(), ['references/modes/worktrees.md']);
    assert.equal(binding.token, RESUME_VERIFY_RULE, 'the token is the live exported constant');
    assert.match(binding.token, /only what THIS run placed or kept/, 'the token states the per-owned-path scope');
    assert.match(binding.token, /never probed and never a stop cause/, 'the token states the session guarantee');
    assert.match(binding.token, /a first provision keeps the blanket clean-tree verify/, 'the token states the first-provision carve-out');
    const helpResult = main(['--help']);
    assert.match(helpResult.stdout, /resume-verify/, 'the HELP inventory must name the binding');
  });

  // The flow tolerate contract (FLOW-TOLERATE doc pins): a deleted binding would re-open the silent
  // doc-drift lane for BOTH procedures.md contract lines, so each pin is itself pinned here.
  it('the registry binds the accepted flow schema version to the procedures mode doc', () => {
    const binding = BINDINGS.find((b) => b.constant === 'flow-schema-version');
    assert.ok(binding, 'registry must bind FLOW_SCHEMA_VERSION (the flow allowed-shape doc pin)');
    assert.equal(binding.value, FLOW_SCHEMA_VERSION, 'the value is the live exported constant');
    assert.equal(binding.token, `\`"schema": ${FLOW_SCHEMA_VERSION}\``, 'the token renders the NUMERIC wire value');
    assert.deepEqual([...binding.files].sort(), ['references/modes/procedures.md']);
    const helpResult = main(['--help']);
    assert.match(helpResult.stdout, /flow schema/, 'the HELP inventory must name the binding');
  });

  it('the registry binds the honest lagging-kit contract sentence to BOTH flow-facing mode docs (P12)', () => {
    const binding = BINDINGS.find((b) => b.constant === 'flow-lagging-kit');
    assert.ok(binding, 'registry must bind FLOW_LAGGING_KIT_CONTRACT (the exit-1 contract doc pin)');
    assert.equal(binding.token, FLOW_LAGGING_KIT_CONTRACT, 'the token is the live exported constant');
    assert.match(binding.token, /config load loudly/, 'the sentence states the pre-flow failure');
    assert.match(binding.token, /null-guarded comparison/, 'the sentence states the now-armed set-flow floor (P12)');
    assert.match(binding.token, /no in-config floor can reach a kit that dies on the unknown key/, 'the honest limit of the armed floor stays admitted');
    assert.match(binding.token, /tolerate-first ordering remains the only protection/, 'the sentence keeps the pre-flow-reader admission');
    assert.deepEqual([...binding.files].sort(), ['references/modes/procedures.md', 'references/modes/set-flow.md']);
    const helpResult = main(['--help']);
    assert.match(helpResult.stdout, /lagging-kit/, 'the HELP inventory must name the binding');
  });

  it('the registry binds the set-flow bookkeeping-floor residual and the procedures armed-halves header', () => {
    const residual = BINDINGS.find((b) => b.constant === 'flow-bookkeeping-floor-residual');
    assert.ok(residual, 'registry must bind FLOW_BOOKKEEPING_FLOOR_RESIDUAL (the honest floor boundary)');
    assert.match(residual.token, /not a pretended rule/, 'the residual admits its boundary');
    assert.deepEqual([...residual.files], ['references/modes/set-flow.md']);
    const header = BINDINGS.find((b) => b.constant === 'flow-armed-halves-header');
    assert.ok(header, 'registry must bind FLOW_ARMED_HALVES_HEADER (the P8 session-start surface)');
    assert.match(header.token, /armed halves/, 'the header names the three halves surface');
    assert.deepEqual([...header.files], ['references/modes/procedures.md']);
  });

  it('the registry binds the review-state clean-tree latent-arm notice to its mode doc', () => {
    const binding = BINDINGS.find((b) => b.constant === 'latent-arm-notice');
    assert.ok(binding, 'registry must bind the clean-tree latent-arm notice');
    assert.equal(binding.token, 'this gate arms as soon as the tree is dirty', 'the token is the live emitted notice');
    assert.deepEqual([...binding.files].sort(), ['references/modes/review-state.md']);
  });

  // AD-044 Plan 2: the autonomy-doctor D7 exit/status contract is bound to its mode doc.
  it('the registry binds the autonomy-doctor EXIT table + every non-usage status token', () => {
    const names = BINDINGS.map((b) => b.constant);
    for (const key of ['ready', 'stop', 'usage', 'notReady', 'installFailed', 'verifyFailed', 'unsupported']) {
      assert.ok(names.includes(`doctor-exit:${key}`), `registry must bind doctor-exit:${key}`);
    }
    for (const token of ['ready-verified', 'ready-assumed', 'no-deployment', 'missing-binaries', 'present-unverified', 'handoff-required', 'install-failed', 'verify-failed', 'indeterminate', 'root-unproven', 'unsupported-platform', 'unknown-pm', 'untrusted-path']) {
      assert.ok(names.includes(`doctor-status:${token}`), `registry must bind doctor-status:${token}`);
    }
    const doctorBindings = BINDINGS.filter((b) => b.constant.startsWith('doctor-'));
    assert.ok(doctorBindings.every((b) => b.files.includes('references/modes/autonomy-doctor.md')));
    // The D2 trusted-dir allowlist is bound as the joined LITERAL — a widened allowlist (e.g.
    // +/usr/local/bin) makes the doc token drift and this pin plus the gate go red.
    const trusted = BINDINGS.find((b) => b.constant === 'doctor-trusted-dirs');
    assert.equal(trusted.token, '/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

// The delegation engine's contract sentence (delegation Plan 1 Phase 3). A binding that merely
// EXISTS proves nothing — the pin below drives the real checker over a doc with the sentence removed
// and requires it to go red, so the guard cannot be satisfied by a doc that never carried it.
describe('doc-parity: the dispatch mode-doc contract sentence binds through the doc-parity registry (non-vacuous)', () => {
  const DOC = 'references/modes/dispatch.md';
  const binding = () => BINDINGS.find((b) => b.constant === 'dispatch-contract');

  it('the registry binds the LIVE DISPATCH_CONTRACT constant to the dispatch mode doc', () => {
    const b = binding();
    assert.ok(b, 'registry must bind the dispatch engine contract sentence');
    assert.equal(b.token, DISPATCH_CONTRACT, 'the token is the live exported constant, never a re-typed copy');
    assert.deepEqual([...b.files], [DOC]);
    assert.match(b.token, /FORM-only/, 'the sentence states the form-only limit of the checker');
    assert.match(b.token, /REFUSES/, 'the sentence states that the aggregator refuses');
    for (const refusal of ['no pre-registration record', 'OPEN thread in scope', 'several waves']) {
      assert.ok(b.token.includes(refusal), `the sentence names the refusal: ${refusal}`);
    }
    assert.match(main(['--help']).stdout, /dispatch engine/, 'the HELP inventory must name the binding');
  });

  it('the shipped mode doc carries the sentence, and a doc that drops it goes RED (non-vacuous)', () => {
    const b = binding();
    assert.equal(checkBinding(b, surface({ [DOC]: `head\n${DISPATCH_CONTRACT}\ntail` })).ok, true);
    const softened = DISPATCH_CONTRACT.replace('FORM-only', 'thorough');
    assert.equal(checkBinding(b, surface({ [DOC]: `head\n${softened}\ntail` })).ok, false, 'a softened sentence must not pass');
    assert.equal(checkBinding(b, surface({ [DOC]: 'a mode doc with no contract sentence' })).ok, false);
    // …and the REAL file passes the same checker (the dogfood half of the pin).
    assert.equal(checkParity([b]).every((r) => r.ok), true, 'references/modes/dispatch.md must carry the live sentence');
  });
});

describe('doc-parity CLI surface', () => {
  it('--help is read-only and 0', () => {
    const r = main(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /deterministic doc-drift lint/);
  });

  it('an unknown argument is a usage error (exit 2)', () => {
    const r = main(['--frobnicate']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument/);
  });

  it('the default report renders every binding as ✓ and a PASS check line', () => {
    const r = main([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /doc-parity — code constants/);
    assert.match(r.stdout, /✓ doctor-exit:ready/);
    assert.match(r.stdout, /check: PASS/);
  });

  it('--json emits the structured result (ok:true, per-binding files)', () => {
    const r = main(['--json']);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.results) && j.results.length === BINDINGS.length);
    assert.ok(j.results.every((res) => res.files.every((f) => f.ok)));
  });

  it('the CLI entry runs end-to-end (subprocess smoke: --check exits 0)', () => {
    const script = fileURLToPath(new URL('./doc-parity.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /check: PASS/);
  });
});

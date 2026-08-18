// dispatch-advisor.test.mjs — spec-first for the vehicle-routing advisor (delegation Plan 3, D1-D4).
// The advisor answers ONE question — "which vehicle carries this step class on THIS host, and what
// has the ledger recorded for it" — and DECIDES nothing: it refuses no dispatch, gates no verb, and
// its recorded-history half arrives as an argument rather than through a second ledger door.
//
// The module is imported DYNAMICALLY (the authoring pattern): this spec LOADS on the
// pre-implementation tree and fails per fixture instead of failing to link.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STEP_CLASSES } from './dispatch-record.mjs';
import { FALLBACK_LENS_ADDITIONAL_ONLY } from './cheap-agents.mjs';

const advisor = await import('./dispatch-advisor.mjs').catch(() => null);
const {
  ADVISOR_ROWS, ADVISOR_NO_GATE, ADVISOR_FALLBACK, HARNESS_SUBAGENT_LANE, ADVISOR_PROBE_POSTURE,
  ADVISOR_MATRIX_COLUMNS, ADVISOR_MATRIX_HEADER, ADVISOR_MATRIX_RULE, HARNESS_LANE_ROW,
  AGENT_PRESENT, AGENT_MISSING, AGENT_UNANCHORED, AGENT_PROBE_ERROR, AGENT_UNKNOWN_STATES,
  AGENT_UNRECOGNIZED_LABEL: ADVISOR_UNRECOGNIZED_LABEL,
  advisorRow, renderAdvisorBlock, renderAdvisorMatrix, renderSelectionNote,
} = advisor ?? {};

// Every vehicle present, every backend ready — the host half is injected, so a test never depends on
// what happens to be installed where it runs.
const readyDeps = { agentState: () => AGENT_PRESENT, backendReadiness: () => 'ready' };
const bareDeps = { agentState: () => AGENT_MISSING, backendReadiness: () => 'needs-cli' };
const blindDeps = { agentState: () => AGENT_UNANCHORED, backendReadiness: () => 'ready' };
const brokenDeps = { agentState: () => AGENT_PROBE_ERROR, backendReadiness: () => 'ready' };

const thread = (nonce, stepClass, closing = null) => [
  { kind: 'dispatch', nonce, stepClass },
  ...(closing === null ? [] : [closing]),
];
const folded = (nonce, stepClass) => thread(nonce, stepClass, { kind: 'fold', nonce });
const degraded = (nonce, stepClass) => thread(nonce, stepClass, { kind: 'degrade', nonce });
const failed = (nonce, stepClass) => thread(nonce, stepClass, { kind: 'return', nonce, outcome: 'transport-failure' });
const open = (nonce, stepClass) => thread(nonce, stepClass);
const ledgerOf = (...threads) => ({ ok: true, records: threads.flat() });

const block = (stepClass, { ledger = { ok: true, records: [] }, deps = readyDeps } = {}) =>
  renderAdvisorBlock({ stepClass, ledger, deps });

const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('dispatch advisor — the frozen row set', () => {
  it('the module exists and exports its two bound sentences', () => {
    assert.ok(advisor, 'dispatch-advisor.mjs must exist');
    assert.equal(typeof ADVISOR_NO_GATE, 'string');
    assert.equal(typeof HARNESS_SUBAGENT_LANE, 'string');
  });

  it('every D9 step class has exactly one advisor row', () => {
    // Totality over the IMPORTED class set, so a class added to dispatch-record.mjs fails here
    // rather than printing nothing at the point of use.
    assert.deepEqual(ADVISOR_ROWS.map((r) => r.stepClass), [...STEP_CLASSES]);
    for (const stepClass of STEP_CLASSES) {
      assert.equal(ADVISOR_ROWS.filter((r) => r.stepClass === stepClass).length, 1, stepClass);
      assert.ok(advisorRow(stepClass), stepClass);
    }
    assert.equal(advisorRow('not-a-class'), undefined);
  });

  it('the row set is frozen — a consumer cannot rewrite the registry it reads', () => {
    // Asserted through Object.isFrozen rather than through a throwing write: on the
    // pre-implementation tree an undefined ADVISOR_ROWS throws for the WRONG reason, and the test
    // would pass while proving nothing.
    assert.equal(Object.isFrozen(ADVISOR_ROWS), true);
    for (const row of ADVISOR_ROWS) assert.equal(Object.isFrozen(row), true, row.stepClass);
  });

  it('every row names a vehicle, a return artifact and a why — no row renders a hole', () => {
    for (const row of ADVISOR_ROWS) {
      for (const key of ['vehicle', 'returns', 'why', 'availabilityNote']) {
        assert.equal(typeof row[key], 'string', `${row.stepClass}.${key}`);
        assert.ok(row[key].length > 0, `${row.stepClass}.${key} is empty`);
        assert.ok(!row[key].includes('|'), `${row.stepClass}.${key} carries a pipe — it would break the matrix row`);
      }
    }
  });
});

describe('dispatch advisor — host capability, stated not assumed', () => {
  it('an absent bundled vehicle renders unavailable and names the solo fallback', () => {
    const out = block('extraction', { deps: bareDeps });
    assert.match(out, /advice: mechanical-sweep \(unavailable/);
    assert.match(out, new RegExp(`fallback: ${quote(ADVISOR_FALLBACK)}`));
    assert.match(ADVISOR_FALLBACK, /solo \(this orchestrator\) — recorded as a degrade, never a silent skip/);
  });

  it('a present bundled vehicle renders ready, and the fallback line stands either way', () => {
    const out = block('extraction');
    assert.match(out, /advice: mechanical-sweep \(ready\)/);
    assert.match(out, /fallback: solo \(this orchestrator\)/, 'the fallback is not a failure notice — it is the other lane');
  });

  it('doc-research renders HOST-LOCAL in BOTH states and is never claimed portable', () => {
    const present = block('research');
    const absent = block('research', { deps: bareDeps });
    assert.match(present, /advice: doc-research \(ready — host-local\)/);
    assert.match(absent, /advice: doc-research \(unavailable — host-local, not bundled\)/);
    const row = advisorRow('research');
    assert.equal(row.portable, false, 'the shipped bundle places the other four; this one is a per-host grant');
    for (const other of ADVISOR_ROWS.filter((r) => r.stepClass !== 'research')) {
      assert.equal(other.portable, true, other.stepClass);
    }
  });

  it('the execute backend answers from readiness, never from a spawn', () => {
    assert.match(block('code'), /advice: codex-exec \(ready\)/);
    assert.match(block('code', { deps: bareDeps }), /advice: codex-exec \(unavailable — needs-cli\)/);
  });

  it('the review-opinion row quotes FALLBACK_LENS_ADDITIONAL_ONLY verbatim', () => {
    // Imported from cheap-agents.mjs rather than re-typed: the bar and the row can never drift.
    assert.match(block('review-opinion'), new RegExp(quote(FALLBACK_LENS_ADDITIONAL_ONLY)));
  });

  it('the worktree-stream row is the kit itself — present wherever the kit is', () => {
    assert.match(block('worktree-stream', { deps: bareDeps }), /advice: worktrees \(ready/);
  });

  it('an UNKNOWN agent state never renders as a verdict — neither ready nor unplaced', () => {
    // An absent file under an unanchored directory is not evidence of absence, and a present one
    // there is not evidence it is THIS repository's vehicle (a nested shadow copy reads identically).
    const portable = block('extraction', { deps: blindDeps });
    assert.match(portable, /advice: mechanical-sweep \(unknown — the repository root was not resolved/);
    assert.ok(!portable.includes('not placed'), 'an unlocatable vehicle is never reported as unplaced');

    const hostLocal = block('research', { deps: blindDeps });
    assert.match(hostLocal, /advice: doc-research \(unknown — host-local, and the repository root was not resolved\)/);

    // The lanes that have no anchor question are untouched by it.
    assert.match(block('code', { deps: blindDeps }), /advice: codex-exec \(ready\)/);
    assert.match(block('worktree-stream', { deps: blindDeps }), /advice: worktrees \(ready/);
  });

  it('a PROBE ERROR is a different ignorance and says so — the root WAS resolved', () => {
    // Both states print `unknown`, and naming the wrong cause would be a false statement about a
    // root that resolved fine: EACCES under an anchored repository is not "no repository root".
    const portable = block('extraction', { deps: brokenDeps });
    assert.match(portable, /advice: mechanical-sweep \(unknown — the repository root resolved, but \.claude\/agents\/ could not be probed there\)/);
    assert.ok(!portable.includes('was not resolved'), 'a resolved root is never reported as unresolved');

    assert.match(block('research', { deps: brokenDeps }), /advice: doc-research \(unknown — host-local, and \.claude\/agents\/ could not be probed\)/);
    assert.deepEqual([...AGENT_UNKNOWN_STATES], [AGENT_UNANCHORED, AGENT_PROBE_ERROR]);
  });

  it('an unrecognized agent state degrades to unknown rather than to a verdict', () => {
    // And it claims NOTHING about the root in either direction: reusing the probe-error wording here
    // would assert "the repository root resolved" about a value that establishes no such thing.
    const out = block('extraction', { deps: { agentState: () => 'something-else', backendReadiness: () => 'ready' } });
    assert.match(out, /advice: mechanical-sweep \(unknown — the availability probe returned an unrecognized state, so nothing about this vehicle is established\)/);
    assert.ok(!out.includes('repository root'), 'an unrecognized state is not evidence about the root, in either direction');
    assert.match(block('research', { deps: { agentState: () => 'something-else', backendReadiness: () => 'ready' } }), new RegExp(quote(ADVISOR_UNRECOGNIZED_LABEL)));
  });

  it('ADVISOR_PROBE_POSTURE states the module/verb split rather than claiming a spawn-free verb', () => {
    assert.match(ADVISOR_PROBE_POSTURE, /module itself writes nothing, spawns nothing/);
    assert.match(ADVISOR_PROBE_POSTURE, /the VERB may run read-only git probes/);
    assert.match(ADVISOR_PROBE_POSTURE, /AW_DELEGATION_STORE/, 'the store probe is conditional — an override means no git probe at all');
    assert.match(ADVISOR_PROBE_POSTURE, /never runs a vehicle, a subscription CLI, or anything that writes/);
  });
});

describe('dispatch advisor — the column registry is the ONE statement of the table shape', () => {
  it('the columns are frozen, and so is every entry', () => {
    assert.equal(Object.isFrozen(ADVISOR_MATRIX_COLUMNS), true);
    for (const column of ADVISOR_MATRIX_COLUMNS) assert.equal(Object.isFrozen(column), true, column.key);
  });

  it('the header and the alignment rule are DERIVED from it, never re-typed', () => {
    assert.equal(ADVISOR_MATRIX_HEADER, `| ${ADVISOR_MATRIX_COLUMNS.map((c) => c.label).join(' | ')} |`);
    assert.equal(ADVISOR_MATRIX_RULE, `| ${ADVISOR_MATRIX_COLUMNS.map(() => '---').join(' | ')} |`);
  });

  it('every rendered row places its cells in COLUMN order, the lane included', () => {
    const lines = renderAdvisorMatrix().split('\n');
    assert.equal(lines[0], ADVISOR_MATRIX_HEADER);
    assert.equal(lines[1], ADVISOR_MATRIX_RULE);
    for (const [i, entry] of ADVISOR_ROWS.entries()) {
      const cells = ADVISOR_MATRIX_COLUMNS.map(({ key }) => (key === 'stepClass' ? `\`${entry.stepClass}\`` : entry[key]));
      assert.equal(lines[i + 2], `| ${cells.join(' | ')} |`, entry.stepClass);
    }
    assert.equal(lines.at(-1), `| ${ADVISOR_MATRIX_COLUMNS.map(({ key }) => HARNESS_LANE_ROW[key]).join(' | ')} |`);
    assert.equal(Object.isFrozen(HARNESS_LANE_ROW), true);
  });

  it('every registry row carries exactly the column keys the table renders', () => {
    for (const entry of ADVISOR_ROWS) {
      for (const { key } of ADVISOR_MATRIX_COLUMNS) assert.equal(typeof entry[key], 'string', `${entry.stepClass}.${key}`);
    }
  });
});

describe('dispatch advisor — the harness-subagent lane', () => {
  it('renders ASSUMED/manual and carries NO availability verdict', () => {
    const matrix = renderAdvisorMatrix();
    assert.match(HARNESS_SUBAGENT_LANE, /ASSUMED\/manual/);
    assert.match(HARNESS_SUBAGENT_LANE, /not kit-detectable/);
    assert.ok(matrix.includes(HARNESS_SUBAGENT_LANE), 'the lane renders into the matrix verbatim');
    const lane = ADVISOR_ROWS.find((r) => r.kind === 'harness');
    assert.equal(lane, undefined, 'the lane is NOT a step-class row — it has no class and no acceptance weight');
  });

  it('the matrix carries one row per class, in class order, plus the lane', () => {
    const matrix = renderAdvisorMatrix();
    const rows = matrix.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
    assert.equal(rows.length, STEP_CLASSES.length + 2, 'the header row, one row per class, and the lane');
    for (const [i, stepClass] of STEP_CLASSES.entries()) {
      assert.match(rows[i + 1], new RegExp(`^\\| \`${stepClass}\` \\|`), stepClass);
    }
  });
});

describe('dispatch advisor — the ledger is READ by the caller, counted here', () => {
  it('an absent ledger prints no recorded history', () => {
    assert.match(block('code', { ledger: { ok: true, records: [] } }), /history: no recorded history/);
  });

  it('a ledger read outcome of ok:false prints history unavailable in the store OWN words, and the advice still prints', () => {
    const out = block('code', { ledger: { ok: false, reason: 'the store carries 2 malformed line(s)' } });
    assert.match(out, /history: unavailable — the store carries 2 malformed line\(s\)/);
    assert.match(out, /advice: codex-exec \(ready\)/, 'an unreadable store never suppresses the advice');
    assert.match(out, /note: /);
  });

  it('the four thread states are counted separately and open is not a closed thread', () => {
    const ledger = ledgerOf(
      folded('n1', 'code'), folded('n2', 'code'), degraded('n3', 'code'), open('n4', 'code'),
      folded('n5', 'extraction'),
    );
    assert.match(block('code', { ledger }), /history: 3 closed threads — 2 folded, 1 degrade-closed · 1 open/);
    assert.match(block('extraction', { ledger }), /history: 1 closed thread — 1 folded · 0 open/);
  });

  it('a terminal-failure return counts as failure-terminal', () => {
    const ledger = ledgerOf(failed('n1', 'code'), folded('n2', 'code'));
    assert.match(block('code', { ledger }), /history: 2 closed threads — 1 folded, 1 failure-terminal · 0 open/);
  });

  it('a non-terminal return leaves its thread OPEN — the fold or degrade closes it', () => {
    // A success return is NOT terminal: the thread stays live until its fold or degrade, which is
    // the store's own vocabulary rather than a second rule stated here.
    const ledger = ledgerOf([{ kind: 'dispatch', nonce: 'n1', stepClass: 'code' }, { kind: 'return', nonce: 'n1', outcome: 'success' }]);
    assert.match(block('code', { ledger }), /history: 0 closed threads · 1 open/);
  });

  it('a PRE-DISPATCH degrade belongs to no thread and is never counted', () => {
    const ledger = { ok: true, records: [{ kind: 'degrade', nonce: null, stepClass: 'code' }] };
    assert.match(block('code', { ledger }), /history: no recorded history/);
  });
});

describe('dispatch advisor — the pinned block and the divergence NOTE', () => {
  it('the rendered block matches the pinned shape', () => {
    const ledger = ledgerOf(folded('n1', 'code'), folded('n2', 'code'), degraded('n3', 'code'), open('n4', 'code'));
    assert.equal(block('code', { ledger }), [
      'dispatch advisor — step class: code',
      '  advice: codex-exec (ready) — a bounded code sub-task returns a diff you review + gate',
      '  fallback: solo (this orchestrator) — recorded as a degrade, never a silent skip',
      '  history: 3 closed threads — 2 folded, 1 degrade-closed · 1 open',
      `  note: ${ADVISOR_NO_GATE}`,
    ].join('\n'));
  });

  it('ADVISOR_NO_GATE says what the advisor is NOT', () => {
    assert.match(ADVISOR_NO_GATE, /never/);
    assert.match(ADVISOR_NO_GATE, /judgment/);
  });

  it('an unknown step class renders nothing and is refused by the caller, not here', () => {
    assert.equal(renderAdvisorBlock({ stepClass: 'not-a-class', ledger: { ok: true, records: [] }, deps: readyDeps }), null);
  });

  it('the selection NOTE fires only on a divergence, and names vehicle.requested when the pair differs', () => {
    const agreed = renderSelectionNote({ stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' }, deps: readyDeps });
    assert.equal(agreed, null, 'an agreeing selection prints no divergence at all');

    const diverged = renderSelectionNote({ stepClass: 'code', vehicle: { requested: 'review-lens', selected: 'mechanical-sweep' }, deps: readyDeps });
    assert.match(diverged, /divergence: the contract selected "mechanical-sweep" \(requested "review-lens"\)/);
    assert.match(diverged, /the advisor advises "codex-exec"/);
    assert.match(diverged, /a NOTE, never a refusal/);

    const same = renderSelectionNote({ stepClass: 'code', vehicle: { requested: 'mechanical-sweep', selected: 'mechanical-sweep' }, deps: readyDeps });
    assert.match(same, /the contract selected "mechanical-sweep"; the advisor advises "codex-exec"/);
    assert.ok(!same.includes('requested'), 'an equal pair names no requested vehicle — there is nothing to distinguish');
  });
});

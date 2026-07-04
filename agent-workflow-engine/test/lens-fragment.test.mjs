import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Canon-presence guard for the agent-rules lens fragment (the ONE canonical home of the
// planning/review/process-fidelity lens block) + shape guard for its append-only prior store.
// This is the single discipline-token list going forward: when a future canon change adds a
// discipline to the lens, append its distinctive token HERE (the kit's lens-mirror test checks
// render-parity against this fragment, never tokens). The engine knows nobody: this test reads
// only the engine's own files.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRAGMENT_PATH = join(ROOT, 'references', 'agent-rules-lens.md');
const PRIORS_PATH = join(ROOT, 'references', 'agent-rules-lens-priors.md');

// CRLF-tolerant reads (a Windows autocrlf checkout must not break the guard — the same
// normalization the kit-side parser applies per the frozen-format contract).
const fragment = readFileSync(FRAGMENT_PATH, 'utf8').replace(/\r\n/g, '\n');
const priorsText = readFileSync(PRIORS_PATH, 'utf8').replace(/\r\n/g, '\n');

const normalize = (s) => String(s).replace(/\r\n/g, '\n').trim();

// The frozen prior-store format (documented in the file's own header, mirrored by the kit's
// lens-region module): a delimiter is a line starting `<!-- prior` and ending `-->`; an entry
// body is everything after it up to the next delimiter / EOF, trimmed; the pre-delimiter header
// is ignored. APPEND-ONLY — an old reader must keep parsing a newer engine's file.
const parsePriors = (text) => {
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('<!-- prior') && line.endsWith('-->')) {
      if (current) entries.push(current.join('\n'));
      current = [];
    } else if (current) current.push(line);
  }
  if (current) entries.push(current.join('\n'));
  return entries.map(normalize).filter((e) => e !== '');
};

// The 22 discipline tokens (the former lens-mirror Set-1 cross-all-four + Set-2 template-scoped
// lists, united here — the fragment is now the one canonical home of the whole block). Matched
// lowercased-substring, like the mirror guard always did.
const DISCIPLINE_TOKENS = [
  // review/fold + convergence disciplines (ex Set-1)
  'fold by code',
  'file:line',
  'right altitude',
  '0 blockers + 0 majors',
  'test-as-spec',
  'no code-mechanics',
  'at the diff',
  'characterize-first',
  '≤2 rounds',
  'crossover',
  'backend divergence',
  'diff-review',
  'self-consistency',
  'checked syntax',
  'logic-bearing',
  // process-fidelity + cost-lane disciplines (ex Set-2)
  'exitplanmode',
  'every round',
  'finding-origin',
  'cheapest adequate executor',
  'no named guardrail does not move down',
  'red lines never move down',
  'salvage recorded state first',
];

// The pre-E4 intro line (the outgoing body differs from the current fragment ONLY by the
// Decision-7 provenance clause in the intro) — lets the test compute the exact outgoing body
// and pin its priors membership without relying on git history (CI checkouts may be shallow).
const CURRENT_INTRO =
  "Apply these when authoring a plan, reviewing, folding a finding, or editing code — the layer read **before any code change**. (Full canon: the project's planning / workflow-methodology + orchestration canon. This section is rendered from that canon and refreshed on upgrade; a custom edit is preserved verbatim, but flagged.)";
const PRE_E4_INTRO =
  "Apply these when authoring a plan, reviewing, folding a finding, or editing code — the layer read **before any code change**. (Full canon: the project's planning / workflow-methodology + orchestration canon.)";

describe('agent-rules-lens fragment — canon presence', () => {
  it('starts with the number-neutral heading', () => {
    assert.match(fragment.split('\n')[0], /^### 2\.x\. Planning, review & process-fidelity invariants$/);
  });

  it('carries every discipline token (the single token list going forward)', () => {
    const lower = fragment.toLowerCase();
    for (const token of DISCIPLINE_TOKENS) {
      assert.ok(lower.includes(token), `missing discipline token "${token}" in the lens fragment`);
    }
  });

  it('carries the Decision-7 provenance intro (rendered-from-canon honesty)', () => {
    assert.ok(fragment.includes(CURRENT_INTRO), 'the fragment intro must carry the provenance clause verbatim');
  });

  it('is path-neutral — no kit-command literals (the engine knows nobody)', () => {
    assert.ok(!fragment.includes('agent-workflow-kit'), 'the fragment must never name the kit');
    for (const entry of parsePriors(priorsText)) {
      assert.ok(!entry.includes('agent-workflow-kit'), 'no priors entry may name the kit');
    }
  });

  it('non-vacuity: stripping a token from an in-memory copy goes red (injected)', () => {
    for (const token of ['checked syntax', 'cheapest adequate executor', 'backend divergence']) {
      assert.ok(fragment.toLowerCase().includes(token), `sanity: the real fragment carries "${token}"`);
      const corrupted = fragment.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), 'REDACTED');
      assert.ok(
        !corrupted.toLowerCase().includes(token),
        `the check must go RED when "${token}" is removed — otherwise the token guard is vacuous`,
      );
    }
  });
});

describe('agent-rules-lens-priors — append-only prior store shape', () => {
  const priors = parsePriors(priorsText);

  it('is parseable and non-empty', () => {
    assert.ok(priors.length >= 1, 'the prior store must carry at least one entry');
  });

  it('every entry is a lens block (number-neutral heading) and differs from the current fragment', () => {
    const current = normalize(fragment);
    for (const entry of priors) {
      assert.match(entry.split('\n')[0], /^### 2\.x\. Planning, review & process-fidelity invariants$/, 'every entry starts with the number-neutral heading');
      assert.notEqual(entry, current, 'a priors entry must never equal the current fragment (append the OUTGOING body, not the new one)');
    }
  });

  it('the pre-E4 outgoing body IS an entry (unmodified in-the-wild deploys converge on first touch)', () => {
    assert.ok(fragment.includes(CURRENT_INTRO), 'sanity: the fragment carries the current intro');
    const outgoing = normalize(fragment.replace(CURRENT_INTRO, PRE_E4_INTRO));
    assert.notEqual(outgoing, normalize(fragment), 'sanity: the computed outgoing body differs from the fragment');
    assert.ok(priors.includes(outgoing), 'the pre-E4 body (current bullets + the pre-provenance intro) must be a priors entry');
  });

  it('non-vacuity: dropping the pre-E4 entry from an in-memory copy goes red (injected)', () => {
    const outgoing = normalize(fragment.replace(CURRENT_INTRO, PRE_E4_INTRO));
    const withoutLast = parsePriors(priorsText).filter((e) => e !== outgoing);
    assert.ok(!withoutLast.includes(outgoing), 'the membership check must go RED when the pre-E4 entry is removed');
  });
});

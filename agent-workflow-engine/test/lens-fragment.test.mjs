import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  // prompt-economy disciplines (D7, REC-UX-REWORK) — one token per invariant, pinned on all
  // three surfaces (canon · kit advisor render · this lens fragment)
  'forbidden lane downgrade',
  'plain pipeline per call',
  'vehicle mandate a host cannot satisfy',
  'stay at the frontier lane',
  'no deterministic gate classifies a dispatch',
  // writer-economy (AD-054; strip-the-kit rewording) — evidence declarations batch, stage
  // writers combine
  'unbatched writer scatter',
  // finding scope (the fold channel) — the rule's three arms plus the two bars each round declares.
  // The token carries its SCOPE: this lens intro applies every bullet to plan-AUTHORING as well, and
  // the rule is plan-execution's alone (a plan has no shipped behaviour to call a live defect in), so
  // an unqualified bullet would contradict the canon it is rendered from.
  'finding scope (plan-execution)',
  'narrow fix',
  'never queued',
  'write/remove decision',
  'routes to subtraction',
  // spec-first (the spec layer, AD-112) — governing specs are plural and cited per touched slice,
  // page-only coverage governs as an adoption shim, the revision lands with the code.
  'spec-first',
  'governing spec',
  'zero, one or many',
  'no global union',
  'before approval',
  'spec review',
  'lands with the code',
  'adoption shim',
  // the adoption state (AD-123) — a zero governing-spec citation names the state it relies on
  'adoption state',
  'never a licence',
];

// The pre-E4 intro line (the outgoing body differs from the current fragment ONLY by the
// Decision-7 provenance clause in the intro) — lets the test compute the exact outgoing body
// and pin its priors membership without relying on git history (CI checkouts may be shallow).
const CURRENT_INTRO =
  "Apply these when authoring a plan, reviewing, folding a finding, or editing code — the layer read **before any code change**. (Full canon: the project's planning / workflow-methodology + orchestration canon. This section is rendered from that canon and refreshed on upgrade; a custom edit is preserved verbatim, but flagged.)";
const PRE_E4_INTRO =
  "Apply these when authoring a plan, reviewing, folding a finding, or editing code — the layer read **before any code change**. (Full canon: the project's planning / workflow-methodology + orchestration canon.)";

// This release's delta: the four review bullets move to the spec review. The previous release's line of
// each is pinned by its sha256, so the outgoing body is checkable without git history.
const OUTGOING_BULLETS = {
  '- **Finding scope': '6c87401b5fb7b941ec3bdabd3f001d8837b82bed71a3c2ae5b62682b3727b063',
  '- **Spec-first.**': '63103e3751328213e7eec5d8bcc01d354469a58850054fe5e413525692ac11ac',
  '- **Fold minimally': 'd8593615bb06b2bf0fcf0138e33ea813fa5258dc3608b58fb57dc885739a9414',
  '- **Heavy review': '796be6ece068a99c557b8abe925512a38d2a6ac5f0ea3ca945f9b697571ef1dc',
};
const PLAN_REVIEW_RE = /plan[- ]review|reviews? (a|the) plan/i;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const leadOf = (line) => Object.keys(OUTGOING_BULLETS).find((lead) => line.startsWith(lead));

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

  it("spec:story-flow/S4 the four review bullets name the spec review, the heavy-review bullet has it read the plan's ledger in the same rounds, and no bullet gives the plan a review of its own", () => {
    const bullets = fragment.split('\n').filter((line) => line.startsWith('- '));
    for (const lead of Object.keys(OUTGOING_BULLETS)) {
      const found = bullets.filter((line) => line.startsWith(lead));
      assert.ok(found.length === 1 && /spec review/i.test(found[0]), `S4: the ${lead}** bullet names the spec review`);
    }
    const heavy = bullets.find((line) => line.startsWith('- **Heavy review'));
    for (const [reason, pattern] of [["have the spec review read the plan's ledger", /\bplan's ledger\b/], ["read the plan's ledger in the spec review's rounds", /\bsame rounds\b/]]) assert.match(heavy, pattern, `S4: the heavy-review bullet does not ${reason}`);
    assert.doesNotMatch(heavy, /\bnever reviewed\b/i, 'S4: the heavy-review bullet still keeps the plan out of the spec review');
    for (const line of bullets) assert.doesNotMatch(line, PLAN_REVIEW_RE, `S4: a bullet gives the plan a review of its own: ${line.slice(0, 40)}`);
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

  it('the OUTGOING body of the previous release IS the newest entry — line by line', () => {
    // The newest prior equals the fragment on every line but this release's delta, which carries the
    // pinned outgoing lines. This pin moves with every canon release: it names THIS release's delta.
    const lines = normalize(fragment).split('\n');
    for (const line of lines.filter(leadOf)) assert.notEqual(sha256(line), OUTGOING_BULLETS[leadOf(line)], `S4: the ${leadOf(line)}** bullet is still the outgoing one`);
    const newest = priors[priors.length - 1].split('\n');
    assert.ok(priors[priors.length - 1].includes(CURRENT_INTRO), 'the outgoing body carries the provenance intro (post-E4)');
    assert.equal(newest.length, lines.length, 'S4: the newest prior has the fragment\'s line count');
    for (const [index, line] of lines.entries()) {
      if (leadOf(line)) assert.equal(sha256(newest[index]), OUTGOING_BULLETS[leadOf(line)], `S4: the newest prior's ${leadOf(line)}** bullet`);
      else assert.equal(newest[index], line, `S4: the newest prior's line ${index + 1}`);
    }
  });

  it('the pre-E4 body REMAINS an entry (append-only: a deployment seeded from any past release keeps converging)', () => {
    assert.ok(
      priors.some((e) => e.includes(PRE_E4_INTRO) && e.toLowerCase().includes('cheapest adequate executor')),
      'a pre-provenance-intro cost-lanes body stays in the store forever',
    );
  });

  it('non-vacuity: dropping the newest entry from an in-memory copy goes red (injected)', () => {
    const newest = priors[priors.length - 1];
    const withoutNewest = parsePriors(priorsText).filter((e) => e !== newest);
    assert.ok(!withoutNewest.includes(newest), 'the membership check must go RED when the newest entry is removed');
  });
});

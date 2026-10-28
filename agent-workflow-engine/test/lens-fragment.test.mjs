import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Canon-presence guard for the engine's lens rules theme (the ONE canonical home of the
// planning/review/process-fidelity lens bullets), the theme the kit lays down as docs/ai/rules/lens.md.
// This is the single discipline-token list going forward: when a future canon change adds a
// discipline to the lens, append its distinctive token HERE. The engine knows nobody: this test reads
// only the engine's own files, so the kit's PRECEDENCE_LINE and the theme title are copied here.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME_PATH = join(ROOT, 'references', 'rules', 'lens.md');
const TITLE = '# Planning, review and process-fidelity invariants';
const PRECEDENCE_LINE = "The kit block of AGENTS.md is the kit's and is rewritten on every upgrade; it and docs/ai/rules/effective/ govern over any copy of kit text elsewhere in this project's files; text of your own goes outside the block, and a change to a kit rule goes in its theme's file under docs/ai/rules/local/.";

// CRLF-tolerant read (a Windows autocrlf checkout must not break the guard). Read inside each cell.
const readTheme = () => readFileSync(THEME_PATH, 'utf8').replace(/\r\n/g, '\n');
const partsOf = (text) => {
  const lines = text.split('\n');
  assert.equal(lines[0], '---', 'the theme opens with frontmatter');
  const close = lines.indexOf('---', 1);
  assert.ok(close > 0, 'the frontmatter closes');
  const rest = lines.slice(close + 1).filter((line) => line.trim() !== '');
  return { frontmatter: lines.slice(1, close), title: rest[0], first: rest[1], body: rest.slice(2), lineCount: lines.length - (text.endsWith('\n') ? 1 : 0) };
};

// The 22 discipline tokens (the former lens-mirror Set-1 cross-all-four + Set-2 template-scoped
// lists, united here). Matched lowercased-substring, like the mirror guard always did.
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
  // three surfaces (canon · kit advisor render · this lens theme)
  'forbidden lane downgrade',
  'plain pipeline per call',
  'vehicle mandate a host cannot satisfy',
  'stay at the frontier lane',
  'no deterministic gate classifies a dispatch',
  // writer-economy (AD-054; strip-the-kit rewording) — evidence declarations batch, stage
  // writers combine
  'unbatched writer scatter',
  // finding scope (the fold channel) — the rule's three arms plus the two bars each round declares.
  // The token carries its SCOPE: the rule is plan-execution's alone (a plan has no shipped behaviour
  // to call a live defect in), so an unqualified bullet would contradict the canon it is rendered from.
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

const REVIEW_LEADS = ['- **Finding scope', '- **Spec-first.**', '- **Fold minimally', '- **Heavy review'];
const PLAN_REVIEW_RE = /plan[- ]review|reviews? (a|the) plan/i;

describe('the lens rules theme references/rules/lens.md — canon presence', () => {
  it('carries frontmatter with maxLines, the title, then PRECEDENCE_LINE as the first non-blank line after the title', () => {
    const text = readTheme();
    const { frontmatter, title, first, lineCount } = partsOf(text);
    const maxLines = frontmatter.find((line) => /^maxLines:\s*\d+\s*$/.test(line));
    assert.ok(maxLines, 'the frontmatter carries maxLines');
    assert.ok(lineCount <= Number(maxLines.split(':')[1]), `the theme fits its maxLines (${lineCount} lines)`);
    assert.deepEqual([title, first], [TITLE, PRECEDENCE_LINE]);
  });

  it('the body after the precedence line is the lens bullets alone: no heading, no intro line', () => {
    const { body } = partsOf(readTheme());
    assert.ok(body.length > 0, 'the theme carries bullets');
    assert.deepEqual(body.filter((line) => !line.startsWith('- ')), []);
  });

  it('carries every discipline token (the single token list going forward)', () => {
    const lower = readTheme().toLowerCase();
    for (const token of DISCIPLINE_TOKENS) {
      assert.ok(lower.includes(token), `missing discipline token "${token}" in the lens theme`);
    }
  });

  it("spec:story-flow/S4 the four review bullets name the spec review, the heavy-review bullet has it read the plan's ledger in the same rounds, and no bullet gives the plan a review of its own", () => {
    const bullets = readTheme().split('\n').filter((line) => line.startsWith('- '));
    for (const lead of REVIEW_LEADS) {
      const found = bullets.filter((line) => line.startsWith(lead));
      assert.ok(found.length === 1 && /spec review/i.test(found[0]), `S4: the ${lead}** bullet names the spec review`);
    }
    const heavy = bullets.find((line) => line.startsWith('- **Heavy review'));
    for (const [reason, pattern] of [["have the spec review read the plan's ledger", /\bplan's ledger\b/], ["read the plan's ledger in the spec review's rounds", /\bsame rounds\b/]]) assert.match(heavy, pattern, `S4: the heavy-review bullet does not ${reason}`);
    assert.doesNotMatch(heavy, /\bnever reviewed\b/i, 'S4: the heavy-review bullet still keeps the plan out of the spec review');
    for (const line of bullets) assert.doesNotMatch(line, PLAN_REVIEW_RE, `S4: a bullet gives the plan a review of its own: ${line.slice(0, 40)}`);
  });

  it('is path-neutral — no kit-command literals (the engine knows nobody)', () => {
    assert.ok(!readTheme().includes('agent-workflow-kit'), 'the theme must never name the kit');
  });

  it('non-vacuity: stripping a token from an in-memory copy goes red (injected)', () => {
    const theme = readTheme();
    for (const token of ['checked syntax', 'cheapest adequate executor', 'backend divergence']) {
      assert.ok(theme.toLowerCase().includes(token), `sanity: the real theme carries "${token}"`);
      const corrupted = theme.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), 'REDACTED');
      assert.ok(
        !corrupted.toLowerCase().includes(token),
        `the check must go RED when "${token}" is removed — otherwise the token guard is vacuous`,
      );
    }
  });
});

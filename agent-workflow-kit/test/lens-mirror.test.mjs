import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Flagship canon ↔ mirror guard. The right-altitude/code-grounded review lens lives in FOUR files that
// share no runtime import — the engine canon (planning.md §9 + procedures.md activity steps) and BOTH
// `agent_rules.md` templates (memory rich + kit fallback). Nothing else keeps their shared vocabulary in
// lockstep, so this dev-only test ties them together: every distinctive token must survive in EACH file's
// lens REGION (not merely somewhere in the file — a token that leaks elsewhere must not keep the guard
// green), and the two template blocks must stay byte-identical apart from their heading number.
//
// Reads the full monorepo checkout (sibling packages present); same cross-package precedent as
// lineage-head-drift.test.mjs / bridges-mirror.test.mjs. Lives under test/ (outside the kit tarball) yet
// matched by the gate glob.
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = join(HERE, '..');
const FAMILY_ROOT = join(KIT_ROOT, '..');

const DRIFT_MESSAGE =
  'planning/review/process-fidelity lens drifted — re-sync the lens across the engine canon + both agent_rules templates.';
// Set 1 — CROSS-ALL-FOUR. DISTINCTIVE phrases — each occurs ONLY inside the lens region of every file (a
// bare word like "Execute"/"invariant" recurs elsewhere and would make the guard vacuous). Matched
// plural-robustly via a lowercased substring ("altitude" matches "right altitude"). These are the
// §9-native review/fold + convergence disciplines, pinned PRESENT in EACH of the four lens regions
// (planning §9, procedures `## plan-authoring` onward, both template lens blocks).
const LENS_TOKENS = [
  'fold by code', // fold-by-code (existing)
  'file:line', // cite the grounding (existing)
  'right altitude', // right-altitude bullet (distinctive: "altitude" alone recurs in §9, so pin the bullet lead)
  '0 blockers + 0 majors', // A3 — convergence bar
  'test-as-spec', // B4 — fold as a red→green test, not prose
  'no code-mechanics', // B5 — altitude ceiling
  'at the diff', // B6 — heavy review against real code
  'characterize-first', // B7 — pin behaviour before editing uncovered code
  // Review-loop economics (M2 — closes the round-cap/crossover token-guard hole): the ≤2-round cap +
  // crossover already lived in planning.md §9 + both templates but were token-UNGUARDED (deletable with
  // every test green); the divergence/thin-plan/self-consistency disciplines are new. All five are pinned
  // PRESENT in EACH of the four lens regions (planning §9, procedures `## plan-authoring` onward, both templates).
  '≤2 rounds', // architecture plan-review round cap
  'crossover', // the pre-existing→fold-induced (and backend-divergence) stop point
  'backend divergence', // M3 — one backend ships while another revises mechanics IS the crossover
  'diff-review', // M5-b — route all-mechanics/CI or prose-only artifacts to a thin plan + diff-review
  'self-consistency', // M4 — a self-consistency read across a prose plan before every re-review
];
// Set 2 — TEMPLATE-SCOPED PRESENCE. The process-fidelity invariants A1/A2 are NOT §9-native (A1 → §6,
// A2 → orchestration.md §4), so they are not in Set 1; without this set they could be dropped from BOTH
// template lens blocks undetected (the byte-identical check only proves the templates AGREE, not that the
// content EXISTS). These pin A1/A2 PRESENT in each template's lens block. (A1/A2 are ALSO pinned in the
// engine canon by planning-canon §6 / orchestration-canon §4 / procedures-canon.)
const TEMPLATE_INVARIANT_TOKENS = [
  'exitplanmode', // A1 — ExitPlanMode ≠ execute (lowercased; matched case-insensitively)
  'every round', // A2 — recipe fidelity: every named backend, every round
  'finding-origin', // M6 — the required per-round {round N · finding-origin tally · per-backend verdict} emission
  // Cost lanes (cost-tiered execution) — canon home is orchestration.md §5 (pinned by
  // orchestration-canon.test.mjs + the advisor guard in tools/procedures.test.mjs), so like A1/A2
  // these are template-scoped here: the ONE lens bullet must survive in BOTH template blocks.
  'cheapest adequate executor', // the routing rule
  'no named guardrail does not move down', // the no-guardrail-no-move rule
  'red lines never move down', // the red-line list lead
  'salvage recorded state first', // the incident-repair down-lane default
];

const PLANNING = join(FAMILY_ROOT, 'agent-workflow-engine', 'references', 'planning.md');
const PROCEDURES = join(FAMILY_ROOT, 'agent-workflow-engine', 'references', 'procedures.md');
const MEMORY_TEMPLATE = join(FAMILY_ROOT, 'agent-workflow-memory', 'references', 'templates', 'agent_rules.md');
const KIT_TEMPLATE = join(KIT_ROOT, 'references', 'templates', 'agent_rules.md');

const FILES = [
  ['engine planning canon', PLANNING],
  ['engine procedures canon', PROCEDURES],
  ['memory agent_rules template', MEMORY_TEMPLATE],
  ['kit agent_rules template', KIT_TEMPLATE],
];
const TEMPLATE_FILES = [
  ['memory agent_rules template', MEMORY_TEMPLATE],
  ['kit agent_rules template', KIT_TEMPLATE],
];

const contents = FILES.map(([label, file]) => [label, file, readFileSync(file, 'utf8')]);

// A `## <heading>` section: the heading line through the line before the next `## ` (or EOF).
const sectionFrom = (text, headingRe) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

// Extract the `### 2.x.` lens block from a template: the heading through the line before the next
// structural boundary (`---` or any `## `/`### ` heading), trailing blanks trimmed, heading number
// normalised. Stopping at the boundary (not the first blank line) keeps it robust if a blank line is ever
// added between the bullets.
const extractLensBlock = (label, text) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^### 2\.\d+\. Planning, review & process-fidelity/.test(line));
  assert.notEqual(start, -1, `${label} missing lens block. ${DRIFT_MESSAGE}`);
  const tail = lines.slice(start);
  const end = tail.findIndex((line, index) => index > 0 && (line === '---' || /^#{2,3} /.test(line)));
  const block = tail
    .slice(0, end === -1 ? tail.length : end)
    .join('\n')
    .replace(/\n+$/, '');
  return block.replace(/^### 2\.\d+\./, '### 2.x.');
};

// The per-file REGION the lens vocabulary must live in — so a token surviving ELSEWHERE in the same file
// (e.g. planning.md §8 also names "file:line"/"altitude") can never keep the guard green when the lens
// block itself is gone.
const lensRegionOf = (label, text) => {
  if (label.includes('template')) return extractLensBlock(label, text);
  if (label.includes('planning')) return sectionFrom(text, /^## 9\. /);
  // procedures: the lens lives in the rendered activity sections (plan-authoring onward), never the preamble.
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## plan-authoring');
  return start === -1 ? '' : lines.slice(start).join('\n');
};

describe('planning/review/process-fidelity lens — cross-package drift guard', () => {
  it('keeps the Set-1 cross-all-four tokens inside the lens region of the engine canon and both templates', () => {
    for (const token of LENS_TOKENS) {
      for (const [label, file, text] of contents) {
        const region = lensRegionOf(label, text);
        assert.ok(
          region.toLowerCase().includes(token),
          `missing token "${token}" in the lens region of ${label} (${file}). ${DRIFT_MESSAGE}`,
        );
      }
    }
  });

  it('keeps the Set-2 process-fidelity tokens (A1/A2) present in BOTH template lens blocks', () => {
    for (const token of TEMPLATE_INVARIANT_TOKENS) {
      for (const [label, file] of TEMPLATE_FILES) {
        const block = extractLensBlock(label, readFileSync(file, 'utf8'));
        assert.ok(
          block.toLowerCase().includes(token),
          `missing process-fidelity token "${token}" in the lens block of ${label} (${file}). ${DRIFT_MESSAGE}`,
        );
      }
    }
  });

  it('keeps the agent_rules template lens blocks byte-identical apart from the heading number', () => {
    const blocks = TEMPLATE_FILES.map(([label, file]) => extractLensBlock(label, readFileSync(file, 'utf8')));
    assert.equal(blocks[0], blocks[1], DRIFT_MESSAGE);
  });

  // Injected red→green NON-VACUITY proof (the AD-029/AD-031 precedent): corrupt the token IN
  // MEMORY (a string substitution on the real template text — never a disk write, so "restoring"
  // is simply not using the substituted copy) and assert the guard's own check goes RED on the
  // corrupted copy. Proves each new cost-lane token is checked WHERE THE BULLET LIVES — the
  // extracted lens block — not satisfied by an accidental occurrence elsewhere in the file.
  it('non-vacuity: deleting a cost-lane token from a template lens block makes the guard go red (injected, in-memory)', () => {
    const [label, file] = TEMPLATE_FILES[0];
    const real = readFileSync(file, 'utf8');
    for (const token of ['cheapest adequate executor', 'no named guardrail does not move down', 'red lines never move down']) {
      // sanity (green half): the real block carries the token
      assert.ok(extractLensBlock(label, real).toLowerCase().includes(token), `sanity: real block carries "${token}"`);
      // red half: the same check on a token-stripped copy fails
      const corrupted = real.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), 'REDACTED');
      assert.ok(
        !extractLensBlock(label, corrupted).toLowerCase().includes(token),
        `the guard must go RED when "${token}" is removed from the lens block — otherwise the token check is vacuous`,
      );
    }
  });
});

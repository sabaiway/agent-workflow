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
  'right-altitude/code-grounded lens drifted — re-sync the lens across the engine canon + both agent_rules templates.';
// DISTINCTIVE phrases — each occurs ONLY inside the lens region of every file (a bare word like
// "Execute"/"invariant" recurs elsewhere and would make the guard vacuous). Matched plural-robustly via a
// lowercased substring ("altitude" matches "right altitude").
const LENS_TOKENS = ['fold by code', 'file:line', 'altitude'];

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
  const start = lines.findIndex((line) => /^### 2\.\d+\. Right-altitude/.test(line));
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

describe('right-altitude/code-grounded lens — cross-package drift guard', () => {
  it('keeps the distinctive lens tokens inside the lens region of the engine canon and both templates', () => {
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

  it('keeps the agent_rules template lens blocks byte-identical apart from the heading number', () => {
    const blocks = TEMPLATE_FILES.map(([label, file]) => extractLensBlock(label, readFileSync(file, 'utf8')));
    assert.equal(blocks[0], blocks[1], DRIFT_MESSAGE);
  });
});

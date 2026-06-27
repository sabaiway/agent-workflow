import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The engine is the canonical source for the activity PROCEDURES (the kit reads this canon live and
// renders it via the read-only `/agent-workflow-kit procedures <activity>`; it parses ONLY each
// section's `Slots:` line, drift-guarded against its activity table — never the steps). This test
// guards the shapes the kit relies on: the two `## <activity>` sections, each declaring its typed
// recipe slots; the binds to planning.md §§4/7/8 (without restating); the load-bearing "Delegated →
// dispatch first" phrasing + the universal commit rule; and that the canon stays GENERIC (no concrete
// project release-publishing bake-in — that is a project overlay, not engine canon).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROCEDURES = join(ROOT, 'references', 'procedures.md');
const METHODOLOGY_SLOT = join(ROOT, 'references', 'methodology-slot.md');

const procedures = readFileSync(PROCEDURES, 'utf8');

const contentLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// Extract a `## <activity>` section (heading → next `## ` heading or EOF) — the same boundary the kit
// parser uses. Returns the section text including its heading.
const sectionOf = (text, activity) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${activity}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
};

// The first non-blank content line after the `## <activity>` heading must be the `Slots:` line.
const slotsLineOf = (section) => {
  const body = section.split('\n').slice(1); // drop the heading
  return body.map((l) => l.trim()).find((l) => l.length > 0) ?? '';
};

describe('procedures.md — canonical activity-procedures reference', () => {
  it('exists and carries real content', () => {
    assert.ok(procedures.length > 500, 'the procedures canon must carry real content');
  });

  it('declares both v1 activities as their own `## <activity>` section', () => {
    assert.ok(sectionOf(procedures, 'plan-authoring'), 'has a ## plan-authoring section');
    assert.ok(sectionOf(procedures, 'plan-execution'), 'has a ## plan-execution section');
  });

  it('plan-authoring declares `Slots: review` as its first content line', () => {
    assert.equal(slotsLineOf(sectionOf(procedures, 'plan-authoring')), 'Slots: review');
  });

  it('plan-execution declares `Slots: execute, review` as its first content line', () => {
    assert.equal(slotsLineOf(sectionOf(procedures, 'plan-execution')), 'Slots: execute, review');
  });

  it('binds to planning.md §§4/7/8 (the structure, self-review, and Cleanup canon) without restating', () => {
    assert.match(procedures, /planning\.md/, 'points at the plan-lifecycle canon');
    for (const sec of ['§7', '§8', '§4']) {
      assert.ok(procedures.includes(sec), `binds to planning.md ${sec}`);
    }
    // "Without restating": it must NOT re-define the plan vocabulary (planning.md §1) nor re-enumerate
    // the §7 document structure inline (a pure pointer to §7 is the contract; an inline section list is
    // drift risk). The §7 enumeration is recognisable by its tail trio Critical files → Reuse →
    // Verification appearing together.
    assert.ok(!procedures.includes('Substep'), 'does not restate the Plan→Phase→Step→Substep vocabulary');
    assert.ok(
      !/Critical files[^]*Reuse[^]*Verification/.test(procedures),
      'does not re-enumerate the planning.md §7 document structure inline (points at §7, never restates it)',
    );
  });

  it('carries the load-bearing "Delegated → dispatch first" phrasing', () => {
    assert.match(
      procedures,
      /Delegated[^]*?dispatch execution FIRST/i,
      'plan-execution dispatches a Delegated execution before integrating',
    );
  });

  it('states the commit rule as a commit-BOUNDARY rule (not every activity commits; a backend never commits)', () => {
    const flat = procedures.replace(/\s+/g, ' ').toLowerCase();
    assert.match(flat, /when an activity has a commit boundary, the orchestrator owns that commit/, 'the rule is conditional on a commit boundary');
    assert.match(flat, /never commits/, 'a backend never commits');
    // plan-authoring must NOT push toward committing the plan — it ends at approval, plans never committed.
    // (the flat text keeps markdown emphasis, e.g. "ends at **approval**", so match tolerantly.)
    assert.match(flat, /ends at \*?\*?approval/, 'plan-authoring produces no commit (ends at approval)');
    assert.match(flat, /plans are ephemeral, never committed/, 'plans are ephemeral and never committed');
    assert.match(procedures, /orchestration\.md/, 'cross-references the commit-rule canon');
  });

  it('stays GENERIC — no concrete project release-publishing bake-in', () => {
    // The generic deferral phrase ("project-declared release/publishing … per the workflow:methodology
    // slot") is REQUIRED; the concrete enforcement (skill names, a mandatory Release-Publishing phase)
    // is a project overlay and must NOT appear in the engine canon.
    assert.match(procedures, /workflow:methodology/, 'defers project stages to the methodology slot');
    assert.ok(!/release-engineering/.test(procedures), 'no concrete release-engineering skill bake-in');
    assert.ok(!/release-marketing/.test(procedures), 'no concrete release-marketing skill bake-in');
    assert.ok(!/Phase:\s*Release Publishing/i.test(procedures), 'no mandatory Release-Publishing phase bake-in');
  });

  it('is terse — stays smaller than the planning.md canon it binds to (points, not restates)', () => {
    const planning = readFileSync(join(ROOT, 'references', 'planning.md'), 'utf8');
    assert.ok(
      procedures.length < planning.length,
      'the procedures canon stays a terse pointer, not a restatement of planning.md',
    );
  });
});

// §3.2 (engine) — the methodology slot fragment gained the procedures auto-discovery clause. It must
// stay a bounded ONE-line, marker-free fragment (the kit frames it with the markers) that routes to the
// in-project /agent-workflow-kit procedures surface (NOT the engine-internal procedures.md).
describe('methodology-slot.md — bounded fragment carries the procedures route', () => {
  const slot = readFileSync(METHODOLOGY_SLOT, 'utf8');

  it('is exactly one content line', () => {
    assert.equal(contentLines(slot).length, 1, 'the methodology slot fragment must be exactly one content line');
  });

  it('carries no marker text (the kit frames it with the markers, the fragment must not)', () => {
    assert.ok(!slot.includes('<!--'), 'the fragment must not contain an HTML comment / marker');
    assert.ok(!slot.includes('workflow:methodology'), 'the fragment must not contain the slot marker name');
  });

  it('routes to the in-project /agent-workflow-kit procedures surface (auto-discovery clause)', () => {
    assert.match(slot, /\/agent-workflow-kit procedures/, 'the slot must route to the in-project procedures advisor');
    assert.ok(!slot.includes('references/procedures.md'), 'the slot must never point at the engine-internal canon (absent from a user project)');
  });

  it('names both v1 activities so a reader knows which activities have procedures', () => {
    for (const activity of ['plan-authoring', 'plan-execution']) {
      assert.ok(slot.includes(activity), `the slot names the "${activity}" activity`);
    }
  });
});

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS_DIR,
  EXPECTED_WORKFLOW_VERSION,
  WORKFLOW_STAMP,
  preflightCheapAgents,
  readBundledAgents,
  writeCheapAgents,
  formatResult,
} from './cheap-agents.mjs';
import { LENS_VERDICTS } from './review-roster.mjs';

const { CHEAP_AGENTS_CONFIG } = await import('./cheap-agents-read.mjs');

const roots = [];
const makeProject = (review) => {
  const root = mkdtempSync(join(tmpdir(), 'cheap-agents-derived-'));
  roots.push(root);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  writeFileSync(join(root, WORKFLOW_STAMP), `${EXPECTED_WORKFLOW_VERSION}\n`);
  writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), JSON.stringify(review));
  return root;
};
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('agents writer derived review lenses (spec:review-roster/S6)', () => {
  it('plans, previews and applies a configured derived lens through the ordinary placement path', () => {
    const root = makeProject({ 'plan-execution': { review: ['review-lens:opus:xhigh'] } });
    const preview = writeCheapAgents({ cwd: root, dryRun: true });
    const derived = preview.plan.filter((item) => item.name === 'review-lens-opus-xhigh.md');
    assert.equal(derived.length, 1);
    assert.equal(derived[0].action, 'place');
    assert.match(formatResult(preview), /\.claude\/agents\/review-lens-opus-xhigh\.md: would place/u);
    assert.match(formatResult(preview), /^5 vehicles are Claude Code subagents with READ-ONLY tools/mu, 'the footer counts the listed plan, the derived lens included');
    assert.equal(existsSync(join(root, AGENTS_DIR, derived[0].name)), false, 'preview writes nothing');

    const applied = writeCheapAgents({ cwd: root, dryRun: false });
    assert.equal(applied.wrote, true);
    assert.match(readFileSync(join(root, AGENTS_DIR, derived[0].name), 'utf8'),
      /^---\nname: review-lens-opus-xhigh\ndescription:[\s\S]*\nmodel: opus\neffort: xhigh\ntools: Read, Grep, Glob\n---/u);
  });

  it('dedupes globally by stem, lets the derived form win, and preserves a customized derived file', () => {
    const root = makeProject({
      'plan-authoring': { review: ['review-lens-opus-xhigh'] },
      'plan-execution': { review: ['review-lens:opus:xhigh'] },
    });
    mkdirSync(join(root, AGENTS_DIR), { recursive: true });
    const target = join(root, AGENTS_DIR, 'review-lens-opus-xhigh.md');
    writeFileSync(target, 'custom\n');
    const result = writeCheapAgents({ cwd: root, dryRun: false });
    const rows = result.plan.filter((item) => item.name === 'review-lens-opus-xhigh.md');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'customized-preserved');
    assert.match(rows[0].content, /^---\nname: review-lens-opus-xhigh\n/u, 'the configured derived template wins the collision');
    assert.equal(readFileSync(target, 'utf8'), 'custom\n');
  });

  it('an unreadable config is a STOP attributed to the agents writer, in a dry-run too', () => {
    const root = makeProject({});
    writeFileSync(join(root, 'docs', 'ai', 'orchestration.json'), '{"plan-execution": {"review": "council",}}');
    for (const dryRun of [true, false]) {
      assert.throws(() => writeCheapAgents({ cwd: root, dryRun }), {
        code: CHEAP_AGENTS_CONFIG,
        message: /orchestration\.json.*malformed JSON.*the agents writer cannot read the configured review lenses — nothing is placed/u,
      });
    }
    assert.equal(existsSync(join(root, AGENTS_DIR)), false, 'a config STOP places nothing');
  });

  it('keeps the config-free advisor preflight bundle-only when a derived file is absent', () => {
    const root = makeProject({ 'plan-execution': { review: ['review-lens:opus:xhigh'] } });
    const advisor = preflightCheapAgents({ cwd: root });
    assert.equal(advisor.plan.length, readBundledAgents().length);
    assert.ok(!advisor.plan.some((item) => item.name === 'review-lens-opus-xhigh.md'));
  });
});

describe('bundled review lens contract (spec:review-roster/S12)', () => {
  it('uses the vehicles-part additional wording, stays read-only and ends with the closed verdict line', () => {
    const template = readBundledAgents().find((item) => item.name === 'review-lens.md').content;
    assert.match(template, /additional to the orchestrator's own review and to whatever configured backends ran; never a substitute for either/u);
    assert.match(template, /^tools: Read, Grep, Glob$/mu);
    assert.equal(template.trimEnd().split('\n').at(-1), `Verdict: ${LENS_VERDICTS.join(' | ')}`);
    assert.deepEqual(LENS_VERDICTS, ['ship', 'ship with nits', 'revise', 'rethink']);
  });
});

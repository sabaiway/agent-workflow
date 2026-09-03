import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READY, NEEDS_CLI, NEEDS_SKILL } from './detect-backends.mjs';

const { main, CONFIG_REL } = await import('./procedures.mjs');
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-workflow-engine');
const detect = (codex, agy) => () => [
  { name: 'codex-cli-bridge', readiness: codex },
  { name: 'antigravity-cli-bridge', readiness: agy },
];
const LENS_PLACED = { state: 'placed', model: 'opus', effort: 'xhigh', rel: '.claude/agents/review-lens.md' };
const LENS_MISSING = { state: 'missing', reason: null, rel: '.claude/agents/review-lens.md' };
const EXECUTOR_MISSING = { state: 'missing', reason: null, rel: '.claude/agents/executor.md' };
const EXECUTOR_PLACED = { state: 'placed', model: 'haiku', effort: 'low', rel: '.claude/agents/executor.md' };

describe('procedures on a roster slot — no invented dispatch before the roster render lands', () => {
  it('a codex-only roster with codex not ready never dispatches agy and carries the roster in the envelope', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'procedures-roster-'));
    try {
      mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
      writeFileSync(join(cwd, CONFIG_REL), JSON.stringify({ 'plan-execution': { review: ['codex-review', 'review-lens'] } }));
      const r = main(['plan-execution', '--json'], {
        cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: detect(NEEDS_CLI, READY),
        surveyLens: (spec) => (spec.stem === 'review-lens' ? LENS_MISSING : EXECUTOR_PLACED),
      });
      assert.equal(r.code, 0, r.stderr);
      const review = JSON.parse(r.stdout).slots.review;
      assert.deepEqual(
        [review.recipe, review.source, review.degradedFrom, review.backends, review.contracts],
        ['reviewed', 'config', null, [], []],
      );
      assert.deepEqual(review.roster.map(({ member, kind, state }) => ({ member, kind, state })), [
        { member: 'codex-review', kind: 'bridge', state: NEEDS_CLI },
        { member: 'review-lens', kind: 'lens', state: 'missing' },
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

const STEPS = ['1. Record', '2. Verify', '3. Check', '4. review {recipe}', '5. Rows', '6. Fold'];
const CANON = ['# Procedures', '', '## feedback-triage', '', 'Slots: review', '', ...STEPS, ''].join('\n');
const ALWAYS = ['feedback-record-cli.mjs --check <record> --excerpts <facts>', 'review-rounds-cli.mjs --artifact <record> --activity feedback-triage'];
const BRIDGES = ['codex-review plan <record>', 'agy-review plan <record> --facts @<facts>'];
const FORBIDDEN = ['agy-review code', 'grounding.mjs', '--plan', 'fold-scope-cli', 'core-evidence red-proof', 'codex-exec --resume'];
const FACT = 'the table judges the obligation review-rounds-cli resolves from';

const makeFeedbackFixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'procedures-feedback-cwd-'));
  const engine = mkdtempSync(join(tmpdir(), 'procedures-feedback-engine-'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(engine, 'references'), { recursive: true });
  writeFileSync(join(engine, 'capability.json'), JSON.stringify({
    family: 'agent-workflow', schema: 1, name: 'agent-workflow-engine', kind: 'methodology-engine',
    version: '1.2.0', available: true, provides: ['plan'], roles: {},
  }));
  writeFileSync(join(engine, 'SKILL.md'), "---\nname: agent-workflow-engine\nmetadata:\n  version: '1.2.0'\n---\n# engine\n");
  writeFileSync(join(engine, 'references', 'procedures.md'), CANON);
  return { cwd, engine };
};
const runFeedback = (fixture, review, { codex, agy, lens = LENS_MISSING, vehicle = EXECUTOR_MISSING }, json = false) => {
  writeFileSync(join(fixture.cwd, CONFIG_REL), JSON.stringify({ 'feedback-triage': { review } }));
  return main(['feedback-triage', ...(json ? ['--json'] : [])], {
    cwd: fixture.cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: fixture.engine }, detect: detect(codex, agy),
    surveyVehicle: () => vehicle,
    surveyLens: (spec) => (spec.stem === 'review-lens' ? lens : EXECUTOR_MISSING),
  });
};
const withFeedbackFixture = (fn) => {
  const fixture = makeFeedbackFixture();
  try { return fn(fixture); }
  finally {
    rmSync(fixture.cwd, { recursive: true, force: true });
    rmSync(fixture.engine, { recursive: true, force: true });
  }
};
const getViews = (fixture, review, setup) => {
  const human = runFeedback(fixture, review, setup);
  const structured = runFeedback(fixture, review, setup, true);
  assert.equal(human.code, 0, human.stderr);
  assert.equal(structured.code, 0, structured.stderr);
  const parsed = JSON.parse(structured.stdout);
  const advice = parsed.feedbackTriage;
  return { human: human.stdout, advice, slots: parsed.slots, views: [human.stdout, advice.join('\n')] };
};

describe('feedback-triage advisor [spec:feedback-triage/S13]', () => {
  it('renders only the record-bound review lines for the shorthand rosters', () => withFeedbackFixture((fixture) => {
    for (const [review, setup, expected, degraded = false] of [
      [['codex-review'], { codex: READY, agy: NEEDS_SKILL }, [BRIDGES[0]]],
      [['agy-review'], { codex: NEEDS_SKILL, agy: READY }, [BRIDGES[1]]],
      ['council', { codex: READY, agy: READY }, BRIDGES],
      ['council', { codex: NEEDS_CLI, agy: NEEDS_SKILL }, [], true],
    ]) {
      const { human, advice, slots, views } = getViews(fixture, review, setup);
      assert.match(human, /Slots: review/u);
      for (const step of STEPS) assert.ok(human.includes(step), `verbatim: ${step}`);
      assert.equal(human.match(/^  review:/gmu)?.length, 1);
      assert.doesNotMatch(human, /Autonomy for/u);
      for (const view of views) {
        for (const line of [...ALWAYS, ...expected]) assert.ok(view.includes(line), line);
        for (const line of BRIDGES) assert.equal(view.includes(line), expected.includes(line), line);
        for (const line of FORBIDDEN) assert.ok(!view.includes(line), line);
        const lines = view.split('\n');
        assert.ok(lines[lines.findIndex((line) => line.includes(ALWAYS[1])) + 1].includes(FACT));
      }
      assert.equal(advice.some((line) => line.includes(ALWAYS[1])), true);
      if (degraded) {
        assert.equal(typeof slots.review.reason, 'string');
        assert.ok(slots.review.reason.length > 0);
        const lines = human.split('\n');
        const reasonIndex = lines.findIndex((line) => line.startsWith('      ↳ '));
        const runIndex = lines.findIndex((line) => line.includes('run:  node'));
        assert.ok(reasonIndex >= 0 && runIndex >= 0 && reasonIndex < runIndex);
      }
    }
  }));

  it("renders one line per roster member — a ready bridge's command, a ready lens's brief, a skipped line for a not-ready member, and no round table for a lens-only roster", () => withFeedbackFixture((fixture) => {
    const cases = [
      {
        review: ['codex-review', 'review-lens'], setup: { codex: READY, agy: NEEDS_SKILL, lens: LENS_PLACED },
        present: [BRIDGES[0], 'review-lens — the Agent tool', '<record> plus <facts>', ALWAYS[1]], absent: [BRIDGES[1]],
      },
      {
        review: ['codex-review', 'review-lens'], setup: { codex: NEEDS_CLI, agy: NEEDS_SKILL, lens: LENS_PLACED },
        present: ['codex-review — skipped this round', 'review-lens — the Agent tool', ALWAYS[1]], absent: BRIDGES,
      },
      {
        review: ['review-lens'], setup: { codex: NEEDS_SKILL, agy: NEEDS_SKILL, lens: LENS_PLACED },
        present: ['review-lens — the Agent tool', 'a roster with no bridge mints no receipt'], absent: [...BRIDGES, ALWAYS[1]],
      },
      {
        review: ['agy-review', 'review-lens'], setup: { codex: NEEDS_SKILL, agy: READY, lens: LENS_MISSING },
        present: [BRIDGES[1], 'review-lens — skipped this round', ALWAYS[1]], absent: [BRIDGES[0]], round: true,
      },
      {
        review: ['codex-review', 'review-lens'], setup: { codex: READY, agy: NEEDS_SKILL, lens: LENS_MISSING, vehicle: EXECUTOR_PLACED },
        present: [BRIDGES[0], 'review-lens — skipped this round', ALWAYS[1]], absent: [BRIDGES[1]], round: true,
      },
    ];
    for (const entry of cases) {
      const { advice, views } = getViews(fixture, entry.review, entry.setup);
      const round = entry.round ?? entry.present.includes(ALWAYS[1]);
      assert.equal(advice.slice(1, round ? -2 : -1).length, entry.review.length);
      for (const view of views) {
        for (const line of entry.present) assert.ok(view.includes(line), line);
        for (const line of entry.absent) assert.ok(!view.includes(line), line);
        const lines = view.split('\n');
        const index = lines.findIndex((line) => line.includes(ALWAYS[1]));
        if (round) assert.ok(lines[index + 1].includes(FACT));
        else assert.equal(view.includes(FACT), false);
      }
    }
  }));
});

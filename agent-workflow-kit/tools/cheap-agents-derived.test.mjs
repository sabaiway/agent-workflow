import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_DIR,
  CHEAP_AGENTS_SYMLINK,
  EXPECTED_WORKFLOW_VERSION,
  WORKFLOW_STAMP,
  preflightCheapAgents,
  readBundledAgents,
  writeCheapAgents,
  formatResult,
  main,
} from './cheap-agents.mjs';
import { LENS_VERDICTS } from './review-roster.mjs';

const read = await import('./cheap-agents-read.mjs');
const { CHEAP_AGENTS_CONFIG } = read;
const { fileLine } = await import('./distribution-files/index.mjs');
const agentsAccepted = (...args) => (read.agentsAccepted ?? (() => { throw new Error('agentsAccepted is absent'); }))(...args);
const TOOLS = dirname(fileURLToPath(import.meta.url));
const DERIVED = 'review-lens-opus-xhigh.md';
const REVIEW = { 'plan-execution': { review: ['review-lens:opus:xhigh'] } };
const OWN = '.claude/agents/<name>.local.md with a name: of its own';
const FIFO = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false, isFIFO: () => true };

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
const agentsOf = (root) => readdirSync(join(root, AGENTS_DIR)).sort();
const bodyOf = (root, name) => readFileSync(join(root, AGENTS_DIR, name), 'utf8');
// A placed component made older: four differing kit files, one of each kind, and one absent.
const ageComponent = (root) => {
  writeCheapAgents({ cwd: root, dryRun: false });
  for (const name of ['mechanical-sweep.md', 'executor.md', 'review-lens.md', DERIVED]) writeFileSync(join(root, AGENTS_DIR, name), 'an earlier body\n');
  rmSync(join(root, AGENTS_DIR, 'gate-triage.md'));
};

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

  it('dedupes globally by stem, lets the derived form win, and writes a differing derived file with its derived body, no copy kept', () => {
    const root = makeProject({
      'plan-authoring': { review: ['review-lens-opus-xhigh'] },
      'plan-execution': { review: ['review-lens:opus:xhigh'] },
    });
    mkdirSync(join(root, AGENTS_DIR), { recursive: true });
    writeFileSync(join(root, AGENTS_DIR, DERIVED), 'custom\n');
    const result = writeCheapAgents({ cwd: root, dryRun: false });
    const rows = result.plan.filter((item) => item.name === DERIVED);
    assert.deepEqual(rows.map((row) => row.action), ['re-derive']);
    assert.match(rows[0].content, /^---\nname: review-lens-opus-xhigh\n/u, 'the configured derived template wins the collision');
    assert.equal(bodyOf(root, DERIVED), rows[0].content);
    assert.deepEqual(agentsOf(root), result.plan.map((item) => item.name).sort(), 'no copy kept');
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

describe('agentsAccepted, the component and its acceptance (spec:carriers/S22)', () => {
  it('is true exactly when a kit agent path of the given file names holds a regular file, judged by lstat and never followed', () => {
    const root = makeProject({});
    const names = ['executor.md', 'gate-triage.md'];
    const answers = [agentsAccepted(root, names)];
    mkdirSync(join(root, AGENTS_DIR, 'gate-triage.md'), { recursive: true });
    writeFileSync(join(root, 'elsewhere.md'), 'x\n');
    symlinkSync(join(root, 'elsewhere.md'), join(root, AGENTS_DIR, 'executor.md'));
    writeFileSync(join(root, AGENTS_DIR, 'doc-research.md'), 'own\n');
    answers.push(agentsAccepted(root, names), agentsAccepted(root, ['doc-research.md']), agentsAccepted(root, []));
    rmSync(join(root, AGENTS_DIR, 'gate-triage.md'), { recursive: true });
    writeFileSync(join(root, AGENTS_DIR, 'gate-triage.md'), 'x\n');
    const fifo = (path) => (path === join(root, AGENTS_DIR, 'gate-triage.md') ? FIFO : lstatSync(path));
    answers.push(agentsAccepted(root, names), agentsAccepted(root, ['gate-triage']), agentsAccepted(root, names, { lstat: fifo }));
    assert.deepEqual(answers, [false, false, true, false, true, false, false]);
  });

  it('is one export of the read core that the writer, the advisor and the danger check import, none restating it', () => {
    const imported = ['cheap-agents.mjs', 'recommendations.mjs', 'apply-danger-check.mjs'].filter((name) =>
      !/import\s*\{[^}]*\bagentsAccepted\b[^}]*\}\s*from\s*'\.\/cheap-agents(?:-read)?\.mjs'/u.test(readFileSync(join(TOOLS, name), 'utf8')));
    const declarations = readdirSync(TOOLS).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
      .filter((name) => /\b(?:const|function)\s+agentsAccepted\b/u.test(readFileSync(join(TOOLS, name), 'utf8')));
    assert.deepEqual([imported, declarations], [[], ['cheap-agents-read.mjs']]);
  });
});

describe('the writer by cells over every kit template kind (spec:carriers/S23)', () => {
  it('places the absent, writes every differing kit file with its body, leaves the current, keeps no copy, and a second run writes nothing', () => {
    const root = makeProject(REVIEW);
    const bodies = Object.fromEntries(writeCheapAgents({ cwd: root, dryRun: true }).plan.map((item) => [item.name, item.content]));
    ageComponent(root);
    const actions = Object.fromEntries(writeCheapAgents({ cwd: root, dryRun: true }).plan.map((item) => [item.name, item.action]));
    assert.deepEqual(actions, { 'changelog-skeleton.md': 'already-current', 'executor.md': 're-derive', 'gate-triage.md': 'place', 'mechanical-sweep.md': 're-derive', 'review-lens.md': 're-derive', [DERIVED]: 're-derive' });
    assert.equal(writeCheapAgents({ cwd: root, dryRun: false }).wrote, true);
    assert.deepEqual(agentsOf(root), Object.keys(bodies).sort(), 'no copy kept');
    for (const [name, body] of Object.entries(bodies)) assert.equal(bodyOf(root, name), body, name);
    const writes = [];
    const again = writeCheapAgents({ cwd: root, dryRun: false }, { writeFile: (...args) => writes.push(args) });
    assert.deepEqual([again.wrote, writes, again.plan.every((item) => item.action === 'already-current')], [false, [], true]);
  });

  it('prints the hidden-mode note exactly on an apply that wrote over a component not accepted before it', () => {
    const root = makeProject({});
    mkdirSync(join(root, AGENTS_DIR), { recursive: true });
    writeFileSync(join(root, AGENTS_DIR, 'doc-research.md'), 'own\n');
    const reports = [formatResult(writeCheapAgents({ cwd: root, dryRun: true })), formatResult(writeCheapAgents({ cwd: root, dryRun: false }))];
    rmSync(join(root, AGENTS_DIR, 'gate-triage.md'));
    reports.push(formatResult(writeCheapAgents({ cwd: root, dryRun: false })), formatResult(writeCheapAgents({ cwd: root, dryRun: false })));
    assert.deepEqual(reports.map((report) => /^hidden-mode note:/mu.test(report)), [false, true, false, false]);
  });
});

describe('the writer lines (spec:carriers/S24)', () => {
  it('fileLine lines for a differing file of each kind, place and already current unchanged, each dry run its would-be form, the fleet line as the kit writes them', () => {
    const root = makeProject(REVIEW);
    ageComponent(root);
    const stateOf = (name) => (['executor.md', 'review-lens.md'].includes(name) ? 'derived' : 'agent');
    for (const dryRun of [true, false]) {
      const report = formatResult(writeCheapAgents({ cwd: root, dryRun }));
      const rowOf = (name) => report.split('\n').find((line) => line.startsWith(`  - ${AGENTS_DIR}/${name}:`));
      for (const name of ['mechanical-sweep.md', 'executor.md', 'review-lens.md', DERIVED]) {
        assert.equal(rowOf(name), `  - ${fileLine({ rel: `${AGENTS_DIR}/${name}`, name, state: stateOf(name) }, dryRun ? undefined : 'written', dryRun)}`, name);
      }
      assert.deepEqual([rowOf('gate-triage.md'), rowOf('changelog-skeleton.md')], [`  - ${AGENTS_DIR}/gate-triage.md: ${dryRun ? 'would place' : 'place'}`, `  - ${AGENTS_DIR}/changelog-skeleton.md: already current`]);
      assert.match(report, /READ-ONLY tools and NO shell as the kit writes them\b/u);
      assert.doesNotMatch(report, /\bcustomized\b|\bpreserved\b|delete the file|earlier body|\b(?:you|user) edited\b|hand edit/iu);
    }
  });

  it('the agent line ends with AGENT_CHANNEL of scripts.mjs, which the index does not re-export', async () => {
    const index = await import('./distribution-files/index.mjs');
    const rel = `${AGENTS_DIR}/gate-triage.md`;
    const line = (tail) => `${rel}: differs from the body the kit writes for it — ${tail} with that body; a vehicle of your own goes in ${OWN}`;
    const file = { rel, name: 'gate-triage.md', state: 'agent' };
    const declared = readFileSync(join(TOOLS, 'distribution-files', 'scripts.mjs'), 'utf8').includes(`export const AGENT_CHANNEL = '${OWN}';`);
    assert.deepEqual([declared, 'AGENT_CHANNEL' in index], [true, false]);
    assert.deepEqual([fileLine(file, 'written', false), fileLine(file, undefined, true)], [line('written'), line('would be written')]);
  });
});

describe('the STOPs (spec:carriers/S25)', () => {
  it('a symlink, a directory, a fifo and an unreadable file at any kit agent path stop the writer naming it, exit 1, nothing written, dry run and apply alike', () => {
    for (const name of ['gate-triage.md', 'executor.md', 'review-lens.md', DERIVED]) {
      for (const kind of ['symlink', 'directory', 'fifo', 'unreadable']) {
        const root = makeProject(REVIEW);
        const target = join(root, AGENTS_DIR, name);
        mkdirSync(join(root, AGENTS_DIR), { recursive: true });
        writeFileSync(join(root, 'elsewhere.md'), 'x\n');
        if (kind === 'symlink') symlinkSync(join(root, 'elsewhere.md'), target);
        else if (kind === 'directory') mkdirSync(target);
        else writeFileSync(target, 'an earlier body\n');
        const deps = kind === 'fifo' ? { lstat: (path) => (path === target ? FIFO : lstatSync(path)) }
          : kind === 'unreadable' ? { readFile: (path, ...rest) => {
            if (path === target) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
            return readFileSync(path, ...rest);
          } } : {};
        for (const dryRun of [true, false]) {
          assert.throws(() => writeCheapAgents({ cwd: root, dryRun }, deps), { code: kind === 'unreadable' ? 'EACCES' : CHEAP_AGENTS_SYMLINK }, `${name} ${kind}`);
          const errors = [];
          const exit = main([dryRun ? '--dry-run' : '--apply', '--cwd', root], { ...deps, log: () => {}, errlog: (line) => errors.push(line) });
          assert.deepEqual([exit, errors.some((line) => line.includes(`${AGENTS_DIR}/${name}`) || line.includes(target)), agentsOf(root)], [1, true, [name]], `${name} ${kind}`);
          assert.equal(readFileSync(join(root, 'elsewhere.md'), 'utf8'), 'x\n');
        }
      }
    }
  });

  it('a place target swapped for a link after the plan stops the apply by CHEAP_AGENTS_SYMLINK, nothing written through it, the earlier writes kept', () => {
    const root = makeProject({});
    const [elsewhere, target] = [join(root, 'elsewhere.md'), join(root, AGENTS_DIR, 'gate-triage.md')];
    writeFileSync(elsewhere, 'x\n');
    let swapped = false;
    const writeFile = (path, ...rest) => {
      if (!swapped) { swapped = true; symlinkSync(elsewhere, target); }
      return writeFileSync(path, ...rest);
    };
    assert.throws(() => writeCheapAgents({ cwd: root, dryRun: false }, { writeFile }), (error) => error.code === CHEAP_AGENTS_SYMLINK && error.message.includes(`${AGENTS_DIR}/gate-triage.md`));
    assert.deepEqual([readFileSync(elsewhere, 'utf8'), bodyOf(root, 'changelog-skeleton.md')], ['x\n', readBundledAgents()[0].content]);
  });

  it('the read core keeps its answer: the executor survey reads a non-regular executor as unusable with the reason', () => {
    const root = makeProject({});
    mkdirSync(join(root, AGENTS_DIR, 'executor.md'), { recursive: true });
    const survey = read.surveyExecutorVehicle(root);
    assert.deepEqual([survey.state, survey.reason.includes(`${AGENTS_DIR}/executor.md`)], ['unusable', true]);
  });
});

describe('bundled review lens contract (spec:review-roster/S12)', () => {
  it('carries the walk-around line and additional wording, stays read-only and ends with the closed verdict line', () => {
    const template = readBundledAgents().find((item) => item.name === 'review-lens.md').content;
    assert.equal(template.split('- **When the artifact is a plan, walk around every check.** For every check bullet of each governing spec, name the invariant it proves and one state that walks around it; a named state is a finding with the replacement invariant, never an added case.').length - 1, 1);
    assert.match(template, /additional to the orchestrator's own review and to whatever configured backends ran; never a substitute for either/u);
    assert.match(template, /^tools: Read, Grep, Glob$/mu);
    assert.equal(template.trimEnd().split('\n').at(-1), `Verdict: ${LENS_VERDICTS.join(' | ')}`);
    assert.deepEqual(LENS_VERDICTS, ['ship', 'ship with nits', 'revise', 'rethink']);
  });
});

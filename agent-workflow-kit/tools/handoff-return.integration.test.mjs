// handoff-return.integration.test.mjs — the real-git E2E of the return rung (delegation Plan 3,
// Phase 3, 3.1.f): provision → edit → land --prepare → dispatch handoff-return, twice — once
// add-only (delivery, proof AND an append through the single ledger door), once carrying a rename
// and a delete (delivery, proof AND observation: NOT RECORDED). Real git and the real worktrees
// lanes; only the land-time children (review-state, run-gates) ride the documented spawn seam.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, handoffBasename, runCli } from './worktrees.mjs';
import { main as dispatchMain } from './dispatch.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-hr-integration-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PLANTED_BEFORE = 'planted finding for the series index → arrives byte verbatim\n';
const PLANTED_AFTER = '## Session notes\nplanted after-record content → arrives byte verbatim too\n';

const sh = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

const run = (argv, { cwd, deps = {} }) => {
  const out = [];
  const err = [];
  const code = runCli(argv, { cwd, log: (l) => out.push(l), logError: (l) => err.push(l), ...deps });
  return { code, text: out.join('\n'), errText: err.join('\n') };
};

const stubChildren = () => (command, args = []) => {
  const line = [command, ...args].join(' ');
  if (line.includes('review-state.mjs')) return { status: 0, stdout: 'satellite review-state: green\n', stderr: '' };
  if (line.includes('run-gates.mjs')) return { status: 0, stdout: 'gate matrix: green\n', stderr: '' };
  return { status: 0, stdout: '', stderr: '' };
};

const makeRepo = (name) => {
  const main = join(TMP, name);
  mkdirSync(main, { recursive: true });
  sh(['init', '-q', '-b', 'main'], main);
  sh(['config', 'user.email', 'coder-tools@proton.me'], main);
  sh(['config', 'user.name', 'coder-tool'], main);
  writeFileSync(join(main, 'README.md'), 'base\n');
  writeFileSync(join(main, 'old.txt'), 'rename me\n');
  writeFileSync(join(main, 'drop.txt'), 'delete me\n');
  mkdirSync(join(main, 'docs/ai'), { recursive: true });
  writeFileSync(join(main, 'docs/ai/gates.json'), JSON.stringify({
    gates: [{ id: 'review-state', title: 'review state', cmd: 'node review-state.mjs --check' }],
  }, null, 2));
  mkdirSync(join(main, 'agent-workflow-kit/tools'), { recursive: true });
  writeFileSync(join(main, 'agent-workflow-kit/tools/review-state.mjs'), 'export {};\n');
  writeFileSync(join(main, 'agent-workflow-kit/tools/run-gates.mjs'), 'export {};\n');
  sh(['add', '-A'], main);
  sh(['commit', '-q', '-m', 'base'], main);
  writeFileSync(join(main, '.git/info/exclude'), ['/docs/ai/', '/docs/plans/', '/.claude/', '/.vscode/', '/node_modules', ''].join('\n'));
  mkdirSync(join(main, 'docs/plans'), { recursive: true });
  writeFileSync(join(main, 'docs/plans/SEED-PROMPT-feature.md'), '# feature plan\n');
  return main;
};

const provisionAndPlant = (name, slug) => {
  const main = makeRepo(name);
  const provisioned = run(['provision', slug, '--plan', 'docs/plans/SEED-PROMPT-feature.md', '--as', 'feature.md'], { cwd: main });
  assert.equal(provisioned.code, EXIT.ok, provisioned.errText);
  const worktree = join(dirname(main), `${basename(main)}--${slug}`);
  const handoff = join(worktree, 'docs/plans', handoffBasename(slug));
  const stub = readFileSync(handoff, 'utf8');
  writeFileSync(handoff, stub.replace('provisioned, nothing done yet\n', `provisioned, nothing done yet\n${PLANTED_BEFORE}`));
  appendFileSync(handoff, PLANTED_AFTER);
  return { main, worktree, slug, handoff };
};

const land = (f) => run(['land', f.slug, '--prepare'], { cwd: f.main, deps: { spawn: stubChildren() } });

const registerWave = (main) => {
  const r = dispatchMain(['register', '--wave', 'wave-hr', '--step-classes', 'worktree-stream',
    '--pairing-key', 'stepClass', '--min-per-class', '99', '--mean-l-threshold', '1',
    '--first-pass-num', '0', '--first-pass-den', '1', '--cwd', main]);
  assert.equal(r.code, 0, r.stderr);
};

const handoffReturn = (main, slug) => dispatchMain([
  'handoff-return', '--slug', slug, '--wave', 'wave-hr', '--plan', 'delegation-3', '--phase', '3', '--cwd', main,
]);

const storeRecords = (main) => {
  const p = join(main, '.git', 'agent-workflow-delegation.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

describe('handoff-return — the real-git end-to-end', () => {
  it('an add-only landing delivers, proves, and appends through the single ledger door', () => {
    const f = provisionAndPlant('e2e-add', 'e2e-add');
    writeFileSync(join(f.worktree, 'feature.txt'), 'a new feature file\n');
    sh(['add', '-A'], f.worktree);
    const landed = land(f);
    assert.equal(landed.code, EXIT.ok, landed.errText);
    registerWave(f.main);
    const r = handoffReturn(f.main, f.slug);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(PLANTED_BEFORE), 'the planted before-record content arrives byte verbatim');
    assert.ok(r.stdout.includes(PLANTED_AFTER), 'the planted after-record content arrives byte verbatim');
    assert.match(r.stdout, /proof — handoff sha256 [0-9a-f]{64} over \d+ bytes/);
    assert.match(r.stdout, /observation: RECORDED/);
    const obs = storeRecords(f.main).at(-1);
    assert.equal(obs.kind, 'observation');
    assert.equal(obs.stepClass, 'worktree-stream');
    assert.equal(obs.metric.provenance, 'self-reported');
    assert.ok(JSON.parse(obs.scope).includes('feature.txt'), obs.scope);
  });

  it('a landing carrying a rename and a delete delivers, proves, and reports observation NOT RECORDED', () => {
    const f = provisionAndPlant('e2e-mixed', 'e2e-mixed');
    sh(['mv', 'old.txt', 'renamed.txt'], f.worktree);
    sh(['rm', '-q', '--', 'drop.txt'], f.worktree);
    sh(['add', '-A'], f.worktree);
    const landed = land(f);
    assert.equal(landed.code, EXIT.ok, landed.errText);
    registerWave(f.main);
    const r = handoffReturn(f.main, f.slug);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(PLANTED_BEFORE), 'delivery still runs');
    assert.match(r.stdout, /proof — handoff sha256 [0-9a-f]{64}/);
    assert.match(r.stdout, /observation: NOT RECORDED — (a deletion|a rename's absent old side) at \S+ is outside the observation domain/);
    assert.equal(storeRecords(f.main).some((rec) => rec.kind === 'observation'), false, 'no partial scope is ever recorded');
  });

  it('a malformed slug is usage and an absent satellite is a runtime STOP that appends nothing', () => {
    const main = makeRepo('e2e-refusals');
    const usage = dispatchMain(['handoff-return', '--slug', 'NOT/a/slug', '--wave', 'w', '--plan', 'p', '--phase', '1', '--cwd', main]);
    assert.equal(usage.code, 2);
    const absent = handoffReturn(main, 'does-not-exist');
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /no registered satellite worktree for does-not-exist/);
    assert.equal(storeRecords(main).length, 0, 'nothing was appended');
  });
});

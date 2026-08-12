// recommendations-source-size.test.mjs — the advisor item that DISCOVERS the source-size practice
// (Plan 1 Phase 4, 4.1.c).
//
// Why this item carries the whole discovery lane: the checker ships with every kit and refuses until
// a project declares its own scope, so nothing in a deployment would ever mention it. The advisor
// section is the one surface a user receives passively, at every upgrade — new and existing
// deployments alike — which is exactly the OPT-IN-SHIPS-INVISIBLE hole the capability registry
// exists to close.
//
// The probe deliberately keys on the DECLARATION, not on the config: a project with no config is the
// project that most needs to hear about the practice, and the apply's own refusal is what teaches
// the one manual step. That is why the last test here runs the rendered command against exactly that
// state and reads what it says.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecommendations, SEVERITY_ATTENTION, SEVERITY_OPTIONAL } from './recommendations.mjs';
import { main } from './source-size-check.mjs';
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_GATE_ID } from './source-size-core.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'source-size-check.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-rec-source-size-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const AUTHORED = {
  _README: 'fixture',
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
};

// Keeps the host machine out of every OTHER probe in the chain — this suite reads one item, and a
// placed wrapper or a real HOME would make the rest of the report machine-dependent.
const hermeticDeps = (root) => ({
  findWrapper: () => false,
  env: { PATH: '/nonexistent-path-for-tests' },
  getenv: { PATH: '/nonexistent-path-for-tests' },
  home: root,
});

let seq = 0;
const project = ({ config = AUTHORED, gates } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  writeFileSync(join(cwd, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }, null, 2));
  writeFileSync(join(cwd, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  if (gates !== undefined) writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify(gates, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const report = (cwd) => {
  const built = buildRecommendations({ cwd, deps: hermeticDeps(cwd) });
  return {
    item: built.items.find((i) => i.key === 'source-size'),
    skip: built.skips.find((s) => s.key === 'source-size'),
  };
};

describe('recommendations — the source-size discovery item', () => {
  it('rec-item-when-gate-undeclared: it fires on a project with no gate, whatever the config state', () => {
    for (const [label, config] of [['no config at all', null], ['authored, unminted', AUTHORED]]) {
      const cwd = project({ config });
      const { item, skip } = report(cwd);
      assert.equal(skip, undefined, `${label}: the probe answered rather than failing`);
      assert.ok(item, `${label}: an unadopted project must hear about the practice`);
      assert.equal(item.severity, SEVERITY_OPTIONAL, `${label}: this is an offer, not a broken declaration`);
      assert.match(item.what, /no source-size gate/, label);
      assert.match(item.benefit, /maintainability/, label);
    }
  });

  it('rec-item-when-gate-undeclared: an EXISTING declaration without the gate still fires', () => {
    const cwd = project({ gates: { gates: [{ id: 'lint', title: 'Lint', cmd: 'true' }] } });
    assert.ok(report(cwd).item, 'a declared matrix that does not carry this gate has not adopted the practice');
  });

  it('rec-silent-when-declared: once --adopt has run, the item is gone', () => {
    const cwd = project();
    assert.ok(report(cwd).item, 'it fires before adoption');
    assert.equal(main(['--adopt', '--reason', 'initial adoption', '--cwd', cwd]).code, 0);
    git(cwd, ['add', '-A']);
    const { item, skip } = report(cwd);
    assert.equal(item, undefined, 'an adopted project is not nagged');
    assert.equal(skip, undefined, 'and convergence is a real answer, never a skipped probe');
  });

  it('rec-silent-when-declared: an id SQUATTER does not read as adopted', () => {
    // The probe asks through the practice's own matcher, so a gate that merely carries the id — and
    // runs something else entirely — must not silence the offer.
    const cwd = project({ gates: { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Mine', cmd: 'true' }] } });
    assert.ok(report(cwd).item, 'the id is not the identity — the canonical invocation is');
  });

  // A declared gate is not the same fact as a WORKING one. The checker refuses on every config state
  // but MINTED, so a gate declared over an absent or half-written record is a matrix that reds on
  // every run — a CONFIGURED declaration that is broken, which is the attention class by definition.
  // Reading the gate alone would report that deployment as adopted and say nothing.
  it('rec-declared-gate-over-unminted-config is ATTENTION, not silence', () => {
    const gates = { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Source size', cmd: `node "${TOOL}" --check` }] };
    for (const [label, config] of [['config deleted after adoption', null], ['authored but never minted', AUTHORED]]) {
      const cwd = project({ config, gates });
      const { item, skip } = report(cwd);
      assert.equal(skip, undefined, `${label}: answered, not skipped`);
      assert.ok(item, `${label}: a declared gate that is certain to refuse must not read as adopted`);
      assert.equal(item.severity, SEVERITY_ATTENTION, `${label}: a broken declaration needs attention, it is not an offer`);
      assert.match(item.what, /declared/, label);
      assert.match(item.apply, /--adopt/, `${label}: and the same verb is the way out`);
    }
  });

  it('rec-apply-line-byte-exact-resolved-path: absolute tool path, pinned reason, pinned --cwd — and it works from a foreign cwd', () => {
    const cwd = project();
    const { item } = report(cwd);
    // Every byte a reader would paste: the resolved absolute tool path, the mode, the PINNED reason
    // (it lands verbatim in every entry the first mint records), and the explicit target project.
    assert.ok(item.apply.startsWith(`node ${TOOL} --adopt --reason "initial adoption" --cwd `), item.apply);
    assert.ok(item.apply.endsWith(cwd), `the --cwd names the target project: ${item.apply}`);
    assert.equal(item.apply.includes('\n'), false, 'a single line, like every apply');
    // The claim the absolute path and the pinned --cwd exist to make: running it from ANYWHERE
    // adopts the project it names. TMP is a foreign directory — not the project, not the kit.
    const run = spawnSync('node', [TOOL, '--adopt', '--reason', 'initial adoption', '--cwd', cwd], { cwd: TMP, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const declared = JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'gates.json'), 'utf8'));
    assert.deepEqual(declared.gates.map((g) => g.id), [SOURCE_SIZE_GATE_ID]);
    git(cwd, ['add', '-A']);
    assert.equal(report(cwd).item, undefined, 'and the item converged, which is what makes the apply the right one');
  });

  it('rec-apply-on-unauthored-config-refuses-teaching: the rendered command on an unauthored project teaches instead of guessing', () => {
    const cwd = project({ config: null });
    const { item } = report(cwd);
    assert.ok(item, 'the item is the discovery lane — it fires precisely here');
    const run = spawnSync('node', [TOOL, '--adopt', '--reason', 'initial adoption', '--cwd', cwd], { cwd: TMP, encoding: 'utf8' });
    assert.equal(run.status, 1, 'a refusal, not a silent scope guess');
    assert.match(run.stdout, /is absent, so this practice has no declared scope yet/);
    assert.match(run.stdout, /EXPECTED, not a failure/, 'the one manual step is named as expected work');
    assert.match(run.stdout, /"<a directory this practice covers>"/, 'the printed template is inert until a human fills it');
    assert.match(run.stdout, /source-size: WHY —/, 'and the refusal still carries the practice\'s reason');
    assert.equal(readFileSync(join(cwd, 'docs', 'ai', '.workflow-version'), 'utf8').trim(), EXPECTED_WORKFLOW_VERSION, 'nothing else was touched');
  });
});

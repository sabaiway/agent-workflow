// recommendations-source-size.test.mjs — the advisor item that DISCOVERS the source-size practice
// (Plan 1 Phase 4, 4.1.c). The checker ships with every kit and refuses until a project declares its
// scope, so the advisor section, received passively at every upgrade, is the one surface that names it
// (the OPT-IN-SHIPS-INVISIBLE hole). The probe keys on the DECLARATION, not on the config: a project
// with no config most needs to hear about the practice, and the apply's own refusal teaches the one
// manual step, which is why the first suite's last test runs the rendered command in that state.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecommendations, ACKS_FILE, ITEM_LINE_CAP, SEVERITY_ATTENTION, SEVERITY_OPTIONAL } from './recommendations.mjs';
import { main } from './source-size-check.mjs';
import * as core from './source-size-core.mjs';
import { hermeticGitEnv } from './git-env.mjs';
import { shellQuoteArg } from './repo-lex.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_GATE_ID } = core;
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'source-size-check.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-rec-source-size-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
// The fixtures' own env for every spawn and the in-process advisor: no inherited GIT_* or host git config.
const GIT_ENV = hermeticGitEnv(process.env, TMP);
for (const key of Object.keys(process.env)) if (!Object.hasOwn(GIT_ENV, key)) delete process.env[key];
Object.assign(process.env, GIT_ENV);

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const AUTHORED = { _README: 'fixture', schema: 1, defaults: { ...SOURCE_SIZE_DEFAULTS }, roots: ['src'], exclude: [], extensions: ['.mjs'] };

// Keeps the host machine out of every OTHER probe in the chain — this suite reads one item, and a
// placed wrapper or a real HOME would make the rest of the report machine-dependent.
const hermeticDeps = (root) => ({ findWrapper: () => false, env: { PATH: '/nonexistent-path-for-tests' }, getenv: { PATH: '/nonexistent-path-for-tests' }, home: root });

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
  return { item: built.items.find((i) => i.key === 'source-size'), skip: built.skips.find((s) => s.key === 'source-size') };
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

// The three-outcome split (feedback-hardening Plan 2, D5). The boolean this probe used to ask made a
// DELIBERATELY VENDORED copy of the checker read as "no source-size gate at all" — a false absence
// whose rendered remedy (`--adopt`) then exits 1 on the very id already in the declaration. The
// realpath anchor is right and does not move; what was missing is the vocabulary to say which of the
// three things a declared cmd actually claims.
describe('recommendations — the source-size item over a VENDORED copy of the checker (D5)', () => {
  const ACK_WRITE = join(HERE, 'ack-write.mjs');
  // A real second copy of the checker inside the project: same invocation shape, a different realpath.
  const vendored = (cwd, rel = join('vendor', 'source-size-check.mjs')) => {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(TOOL, abs);
    git(cwd, ['add', '-A']);
    return { abs, cmd: `node "${abs}" --check` };
  };
  const gateFor = (cmd, id = SOURCE_SIZE_GATE_ID) => ({ gates: [{ id, title: 'Source size', cmd }] });
  const mint = (cwd) => {
    const r = spawnSync('node', [TOOL, '--write-baseline', '--reason', 'initial adoption', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    git(cwd, ['add', '-A']);
  };

  it('rec-vendored-copy-is-ADOPTED-ELSEWHERE, never a false "no source-size gate"', () => {
    const cwd = project();
    const copy = vendored(cwd);
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify(gateFor(copy.cmd), null, 2));
    mint(cwd);
    const { item, skip } = report(cwd);
    assert.equal(skip, undefined, 'a readable declaration is decided');
    assert.ok(item, 'the advisor still has something to say — but not that the practice is missing');
    assert.equal(item.variant, 'source-size.adopted-elsewhere');
    assert.equal(item.severity, SEVERITY_OPTIONAL, 'a vendored copy is a deployment choice, not a broken declaration');
    assert.match(item.what, /DIFFERENT copy of this checker/, item.what);
    assert.doesNotMatch(item.what, /no source-size gate/, 'the retired false absence never renders over a vendored copy');
    // The remedy that used to render here EXITS 1 on the id collision — correct against a squatter,
    // wrong against a second copy of the same tool.
    assert.doesNotMatch(item.apply, /--adopt/, `--adopt would collide on the declared id: ${item.apply}`);
    assert.ok(item.apply.startsWith(`node ${ACK_WRITE} --lane source-size-copy --fingerprint `), item.apply);
  });

  it('rec-vendored-copy-converges-on-its-own-ack, and re-fires when the declared claim SET changes', () => {
    const cwd = project();
    const copy = vendored(cwd);
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify(gateFor(copy.cmd), null, 2));
    mint(cwd);
    const fingerprint = report(cwd).item.apply.match(/--fingerprint ([0-9a-f]{16})/)[1];
    // Non-vacuity: the RENDERED lane is what converges the item it was rendered for.
    const applied = spawnSync('node', [ACK_WRITE, '--lane', 'source-size-copy', '--fingerprint', fingerprint, '--cwd', cwd, '--apply'], { encoding: 'utf8' });
    assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(cwd, ACKS_FILE), 'utf8')).sourceSizeCopyAck, fingerprint);
    assert.equal(report(cwd).item, undefined, 'the acknowledged claim converges');
    // A SECOND external copy is a different fact: the maintainer acknowledged one, not any number.
    const second = vendored(cwd, join('vendor2', 'source-size-check.mjs'));
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({
      gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Source size', cmd: copy.cmd }, { id: 'source-size-b', title: 'B', cmd: second.cmd }],
    }, null, 2));
    git(cwd, ['add', '-A']);
    const after = report(cwd);
    assert.ok(after.item, 'a changed claim set re-fires');
    assert.match(after.item.what, /\(2 declared\)/, after.item.what);
    assert.notEqual(after.item.apply.match(/--fingerprint ([0-9a-f]{16})/)[1], fingerprint);
  });

  it('rec-vendored-copy-over-an-unminted-record is the SAME attention outcome — and no ack silences it', () => {
    // The config-state guard survives the split: a gate certain to refuse on every run is broken
    // whichever copy runs it. Only the way OUT differs — `--adopt` would mint and then collide, so
    // the rendered verb is the mint alone; the declaration is not the half that is missing.
    for (const [label, config] of [['no config at all', null], ['authored but never minted', AUTHORED]]) {
      const cwd = project({ config });
      const copy = vendored(cwd);
      writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify(gateFor(copy.cmd), null, 2));
      // An ack recorded for this very claim must not convert a broken declaration into silence.
      writeFileSync(join(cwd, 'docs', 'ai', 'acks.json'), JSON.stringify({ sourceSizeCopyAck: 'abcdef0123456789' }));
      git(cwd, ['add', '-A']);
      const { item } = report(cwd);
      assert.ok(item, `${label}: a gate certain to refuse is never silenced by an acknowledgment`);
      assert.equal(item.variant, 'source-size.unminted', label);
      assert.equal(item.severity, SEVERITY_ATTENTION, label);
      assert.match(item.apply, /--write-baseline --reason "initial adoption"/, `${label}: the mint alone`);
      assert.doesNotMatch(item.apply, /--adopt/, `${label}: --adopt would mint and then collide on the declared id`);
    }
  });

  it('rec-id-squatter-gets-its-own-attention-arm with the user\'s own step, never --adopt', () => {
    const cwd = project({ gates: gateFor('true') });
    const { item } = report(cwd);
    assert.ok(item, 'the id is not the identity — the canonical invocation is');
    assert.equal(item.variant, 'source-size.id-squatter');
    assert.equal(item.severity, SEVERITY_ATTENTION, 'the id claims the practice while nothing measures size');
    assert.equal(item.lane, 'user', 'id-squatter is the user\'s own step');
    assert.equal(item.check, null);
    assert.equal(item.apply, `your own step — in docs/ai/gates.json rename the "source-size" gate to an id of its own, or repoint its cmd at node "${TOOL}" --check, then run /agent-workflow-kit recommendations`);
    assert.equal(item.detail, null);
    assert.doesNotMatch(item.apply, /--adopt/, 'the rendered remedy is never the one that exits 1 here');
  });

  it('rec-precedence-is-deterministic-over-a-MIXED declaration: canonical > tool-elsewhere > id-squatter', () => {
    // A boolean matcher had to pick arbitrarily here. The order is pinned because each answer is a
    // different sentence to the maintainer, and only one of them can be the right one.
    const canonicalCmd = `node "${TOOL}" --check`;
    const cases = [
      ['canonical beside a vendored copy', (copy) => [{ id: 'size-b', title: 'B', cmd: copy.cmd }, { id: SOURCE_SIZE_GATE_ID, title: 'A', cmd: canonicalCmd }], undefined],
      ['canonical beside an id squatter', () => [{ id: SOURCE_SIZE_GATE_ID, title: 'A', cmd: 'true' }, { id: 'size-real', title: 'B', cmd: canonicalCmd }], undefined],
      ['a vendored copy beside an id squatter', (copy) => [{ id: SOURCE_SIZE_GATE_ID, title: 'A', cmd: 'true' }, { id: 'size-b', title: 'B', cmd: copy.cmd }], 'source-size.adopted-elsewhere'],
    ];
    for (const [label, build, expected] of cases) {
      const cwd = project();
      const copy = vendored(cwd);
      writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: build(copy) }, null, 2));
      mint(cwd);
      const { item } = report(cwd);
      assert.equal(item?.variant, expected, `${label}: ${item ? item.variant : 'silent'}`);
    }
  });

  it('rec-unchanged-arms: a canonical minted gate stays silent and an undeclared project keeps the base offer', () => {
    const adopted = project();
    assert.equal(main(['--adopt', '--reason', 'initial adoption', '--cwd', adopted]).code, 0);
    git(adopted, ['add', '-A']);
    assert.equal(report(adopted).item, undefined, 'the canonical arm is byte-unchanged');
    const bare = project();
    const { item } = report(bare);
    assert.equal(item.variant, 'source-size', 'and a project with no claim at all still gets the discovery offer');
    assert.match(item.apply, /--adopt/, 'whose remedy is still the one consented verb');
  });
});

// The check stops on a minted schema-1 config whatever is declared, so its move is asked before every
// gate arm; a config the probe cannot read is never taken for schema 1 and keeps today's answers.
describe('spec:source-size/S36 — a minted schema-1 config is offered the --write-baseline move ahead of the gate arms', () => {
  const MINTED1 = { ...AUTHORED, baseline: {}, aggregate: { src: { lines: 1, reason: 'initial adoption' } } };
  const canonical = { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Source size', cmd: `node "${TOOL}" --check` }] };
  const WHAT = 'the source-size config is schema 1, which the check stops on — the writer moves it to schema 2 in one write';
  const vendor = (cwd) => {
    const abs = join(cwd, 'vendor', 'source-size-check.mjs');
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(TOOL, abs);
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Source size', cmd: `node "${abs}" --check` }] }, null, 2));
    git(cwd, ['add', '-A']);
    return cwd;
  };
  const unreadable = (gates) => {
    const cwd = project({ config: null, gates });
    writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), '{ not json');
    git(cwd, ['add', '-A']);
    return cwd;
  };

  it('schema1-arm-first: with no gate, a canonical, a tool-elsewhere or an id-squatter gate the item is the move, with no reason, until it is made', () => {
    const cases = [['no gate', project({ config: MINTED1 })], ['a canonical gate', project({ config: MINTED1, gates: canonical })], ['a tool-elsewhere gate', vendor(project({ config: MINTED1 }))],
      ['an id squatter', project({ config: MINTED1, gates: { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Mine', cmd: 'true' }] } })]];
    for (const [label, cwd] of cases) {
      for (const run of [1, 2]) {
        const { item, skip } = report(cwd);
        assert.deepEqual([item?.variant, item?.severity, item?.lane, item?.what, item?.apply, skip], ['source-size.schema-1', SEVERITY_ATTENTION, 'chat', WHAT, `node ${TOOL} --write-baseline --cwd ${cwd}`, undefined], `${label}, run ${run}`);
      }
    }
    // Non-vacuity: the rendered move, run as rendered from a foreign cwd, is what converges the item.
    const cwd = cases[1][1];
    const moved = spawnSync('node', [TOOL, '--write-baseline', '--cwd', cwd], { cwd: TMP, encoding: 'utf8' });
    assert.equal(moved.status, 0, `${moved.stdout}${moved.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8')).schema, 2);
    git(cwd, ['add', '-A']);
    assert.equal(report(cwd).item, undefined, 'a canonical gate over the moved record is silent');
  });

  it('schema1-unminted-and-unreadable: an unminted config keeps the unminted arm with its new text, and an unreadable config keeps today\'s arms', () => {
    for (const [state, config] of [['authored', AUTHORED], ['absent', null]]) {
      const { item } = report(project({ config, gates: canonical }));
      assert.equal(item?.what, `the source-size gate is declared over an unminted record (${state}) — the check refuses it, or if absent judges layout alone, no line`, state);
      assert.equal(item.variant, 'source-size.unminted', state);
      assert.match(item.apply, /--adopt --reason "initial adoption"/, state);
    }
    assert.equal(report(unreadable()).item?.variant, 'source-size', 'with no gate an unreadable config keeps the base offer');
    for (const [label, cwd] of [['a canonical gate', unreadable(canonical)], ['a tool-elsewhere gate', vendor(unreadable())]]) {
      const { item, skip } = report(cwd);
      assert.equal(item, undefined, label);
      assert.match(skip?.reason ?? '', /source-size\.json is not valid JSON/, `${label}: the probe reports the unreadable config`);
    }
  });
});

describe('spec:source-size/S41 — the source-size.layout item renders exactly on the layout setup\'s record answer', () => {
  const AUTHORED2 = { schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'] };
  const [RECORD, RECORD_LAYOUT] = [['--write-baseline', '--reason', 'initial adoption'], ['--write-baseline', '--layout', '--reason', 'initial adoption']];
  const configOf = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
  const tracked = (cwd) => (git(cwd, ['add', '-A']), cwd);
  const tool = (cwd, ...args) => { const { status } = spawnSync('node', [TOOL, ...args, '--cwd', cwd], { cwd: TMP }); tracked(cwd); return status; };
  const minted = (layout) => { const cwd = project({ config: AUTHORED2 }); for (const args of layout ? [RECORD, RECORD_LAYOUT] : [RECORD]) assert.equal(tool(cwd, ...args), 0); return cwd; };
  const piled = () => { const cwd = project({ config: null }); for (let i = 0; i < 24; i += 1) writeFileSync(join(cwd, 'src', `f${i}.mjs`), 'x\n'); return tracked(cwd); };
  const rewrite = (cwd, edit) => { writeFileSync(configOf(cwd), JSON.stringify(edit(JSON.parse(readFileSync(configOf(cwd), 'utf8'))))); return tracked(cwd); };
  const run = (cwd) => { // the layout setup asks git through deps.env, so this run's env is the fixtures' hermetic one
    const { items, skips } = buildRecommendations({ cwd, deps: { ...hermeticDeps(cwd), env: GIT_ENV } });
    return { items, arms: items.filter((i) => i.key === 'source-size').map((i) => i.variant), layout: items.find((i) => i.variant === 'source-size.layout'), skip: skips.find((s) => s.key === 'source-size.layout')?.reason };
  };
  const setup = (cwd) => core.readLayoutSetup?.(cwd);
  const lineOf = (cwd, args) => ['node', TOOL, ...args, '--cwd', cwd].map(shellQuoteArg).join(' ');

  it('record-item-exact: on record it renders first, chat and optional, with the setup\'s arguments, ahead of the base arm and the hook-checks item', () => {
    const WHAT = 'the layout record is not started — starting it records any directory already beyond the layout limits, so the commit hook can judge layout';
    for (const [label, cwd, args] of [['an absent config holding a pile', piled(), RECORD], ['a minted config without layout and no gate', minted(), RECORD_LAYOUT]]) {
      mkdirSync(join(cwd, 'scripts', 'agent-workflow', 'git-hooks'), { recursive: true });
      copyFileSync(join(HERE, '..', 'references', 'scripts', 'git-hooks', 'install-git-hooks.mjs'), join(cwd, 'scripts', 'agent-workflow', 'git-hooks', 'install-git-hooks.mjs'));
      const { items, layout, arms } = run(tracked(cwd));
      assert.deepEqual([layout?.key, layout?.severity, layout?.lane, layout?.what, layout?.check, layout?.apply], ['source-size', SEVERITY_OPTIONAL, 'chat', WHAT, null, lineOf(cwd, args)], label);
      assert.deepEqual([setup(cwd), layout.what.length <= ITEM_LINE_CAP], [{ answer: 'record', args }, true], `${label}: the setup's answer, the WHAT within the item cap`);
      for (const state of [/no size config is judged under the kit's values/, /an older config without layout is not judged on layout/, /schema 1 or unminted stops every commit on that config's own stop/]) assert.match(layout.detail, state, label);
      assert.deepEqual(arms, ['source-size.layout', 'source-size'], `${label}: its own item, the base arm rendering as before after it`);
      assert.ok(items.indexOf(layout) < items.findIndex((i) => i.key === 'hook-checks'), `${label}: ahead of the hook-checks item`);
    }
  });

  it('no-record-item: an armable or a held answer renders no record item and no layout skip, the other arms as before', () => {
    const canonical = { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Source size', cmd: `node "${TOOL}" --check` }] };
    for (const [label, cwd, answer, arms] of [['an absent config with no stop', project({ config: null }), { answer: 'armable' }, ['source-size']],
      ['a minted config carrying layout', minted(true), { answer: 'armable' }, ['source-size']],
      ['a minted schema-1 config', project({ config: { ...AUTHORED, baseline: {}, aggregate: { src: { lines: 1, reason: 'initial adoption' } } } }), { answer: 'held', reason: 'schema-1' }, ['source-size.schema-1']],
      ['an unminted config under a canonical gate', project({ config: AUTHORED2, gates: canonical }), { answer: 'held', reason: 'unminted' }, ['source-size.unminted']]]) {
      const { layout, skip, arms: rendered } = run(cwd);
      assert.deepEqual([setup(cwd), layout, skip, rendered], [answer, undefined, undefined, arms], label);
    }
  });

  it('held-skip: a store root and a declined record whose root then grew render a stated skip carrying the setup\'s reason', () => {
    const store = rewrite(minted(), (config) => ({ ...config, roots: ['src', 'docs/ai/specs/x'] }));
    const held = run(store);
    assert.deepEqual([held.layout, held.skip], [undefined, 'the source-size config declares the root "docs/ai/specs/x" at or inside the spec store docs/ai/specs — the layout record starts once that root is declared outside it']);
    assert.deepEqual(setup(store), { answer: 'held', reason: 'store-root', root: 'docs/ai/specs/x' });
    const declined = minted();
    const bytes = readFileSync(configOf(declined));
    assert.ok(run(declined).layout, 'the record is offered, and declined');
    writeFileSync(join(declined, 'src', 'b.mjs'), 'export const b = 2;\n');
    const grown = run(tracked(declined));
    assert.deepEqual([grown.layout, grown.arms, grown.skip], [undefined, ['source-size'], 'the source-size check stops on this tree, so a layout record or layout line not yet in place waits — record that growth first with the reasoned --write-baseline its stop names, then re-run']);
    assert.deepEqual(setup(declined), { answer: 'held', reason: 'stops' });
    assert.deepEqual(readFileSync(configOf(declined)), bytes, 'a declined record writes nothing');
  });

  it('record-applied: the rendered one-liner makes the setup armable and the next --check pass; a deleted layout key renders it again and a no writes nothing', () => {
    let cwd;
    for (cwd of [piled(), minted()]) {
      const applied = spawnSync(run(cwd).layout?.apply ?? 'false', { shell: true, cwd: TMP, encoding: 'utf8' });
      assert.equal(applied.status, 0, `the record item renders and its one-liner runs: ${applied.stdout}${applied.stderr}`);
      assert.deepEqual([setup(tracked(cwd)), tool(cwd, '--check'), run(cwd).layout], [{ answer: 'armable' }, 0, undefined], 'armable, the next --check passes, converged');
    }
    const bytes = readFileSync(configOf(rewrite(cwd, ({ layout, ...config }) => config)));
    assert.equal(run(cwd).layout?.apply, lineOf(cwd, RECORD_LAYOUT), 'a deleted layout key renders it again on the next run');
    assert.deepEqual(readFileSync(configOf(cwd)), bytes, 'a no leaves the config byte-unchanged');
  });
});

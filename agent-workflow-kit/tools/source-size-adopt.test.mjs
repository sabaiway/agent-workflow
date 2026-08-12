// source-size-adopt.test.mjs — arming the practice (Plan 1 Phase 4): the gates-init CANDIDATE that
// offers the gate, and the --adopt verb that mints the record and declares it in one consented line.
//
// The two are tested together because they are one contract read from two ends: the candidate exists
// only over a MINTED config, and --adopt is what produces that state — so a fixture that proves the
// candidate absent before adoption and present after it is the honest test of both.
//
// Every fixture is a real git work tree: the scope rule reads the INDEX, so a project whose files are
// merely on disk has no scope at all, and a green check over it would prove nothing.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, runAdopt } from './source-size-check.mjs';
import { SOURCE_SIZE_DEFAULTS, SOURCE_SIZE_GATE_ID, matchesSourceSizeGate, measureFile } from './source-size-core.mjs';
import { buildOffer, sourceSizeCandidate, applyFill } from './gates-init.mjs';
import { loadDeclaration, isFinalCapableDeclaration } from './run-gates.mjs';
import { EXPECTED_WORKFLOW_VERSION } from './velocity-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = join(HERE, 'source-size-check.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-adopt-'));
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
// A reviewed recipe is what makes the review-state / coverage-check candidates conditional-true, so
// the whole-offer fixtures exercise the real multi-candidate offer rather than a degenerate one.
const COUNCIL = { 'plan-execution': { review: 'council' } };

let seq = 0;
// A deployed project at the expected lineage (applyFill is stamp-gated), carrying one small tracked
// source file so the declared scope is non-empty, plus an optional config in a chosen state.
const project = ({ config = AUTHORED, scripts = { test: 'node --test' }, gates } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  writeFileSync(join(cwd, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts }, null, 2));
  writeFileSync(join(cwd, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  writeFileSync(join(cwd, 'docs', 'ai', 'orchestration.json'), JSON.stringify(COUNCIL, null, 2));
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  if (gates !== undefined) writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify(gates, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const declaredGates = (cwd) => {
  const declaration = loadDeclaration(cwd);
  return declaration.outcome === 'loaded' ? declaration.gates : [];
};
const recordOf = (cwd) => JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8'));
const adopt = (cwd, reason = 'initial adoption') => main(['--adopt', '--reason', reason, '--cwd', cwd]);

describe('source-size — the gates-init candidate (4.1.a)', () => {
  it('candidate-absent-without-config: a project that never declared the practice is offered nothing, and told nothing', () => {
    const cwd = project({ config: null });
    const { candidate, note } = sourceSizeCandidate(cwd);
    assert.equal(candidate, null, 'there is no practice to offer a gate for');
    assert.equal(note, null, 'and no note either — silence is honest when nothing is declared');
    assert.equal(buildOffer(cwd).entries.some((e) => e.id === SOURCE_SIZE_GATE_ID), false);
  });

  it('candidate-absent-on-authored-unminted: an authored config withholds the gate and says WHY by name', () => {
    const cwd = project();
    const { candidate, note } = sourceSizeCandidate(cwd);
    assert.equal(candidate, null, 'the checker refuses on an unminted config — declaring it would red the matrix');
    assert.match(note, /not yet MINTED/, `the withhold is stated: ${note}`);
    assert.match(note, /--adopt/, 'and it names the step that clears it');
    assert.ok(buildOffer(cwd).notes.some((n) => n.includes('not yet MINTED')), 'the offer carries the note too');
  });

  // The withhold note is the ONLY thing standing between a reader and the practice here, so the
  // command it names must be one that actually works. A first mint records every value for the
  // first time, and recording a value the first time is a RAISE — so the bare verb is refused, and
  // a note printing it hands out a guaranteed failure at the one moment the reader is following it.
  it('candidate-absent-on-authored-unminted: the named recovery carries the reason a first mint requires', () => {
    const cwd = project();
    const { note } = sourceSizeCandidate(cwd);
    assert.match(note, /--reason/, `the note must name a runnable command: ${note}`);
    // Non-vacuous: the command the note names, run as named, really does adopt this project.
    const run = spawnSync('node', [TOOL, '--adopt', '--reason', 'initial adoption', '--cwd', cwd], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });

  it('candidate-absent-on-authored-unminted: an INCOMPLETE machine half is withheld for the same reason', () => {
    // A file carrying one machine key without the other is a state no regenerator produces — it was
    // hand-edited into it, and it records only part of the tree.
    const cwd = project({ config: { ...AUTHORED, baseline: {} } });
    const { candidate, note } = sourceSizeCandidate(cwd);
    assert.equal(candidate, null);
    assert.match(note, /not yet MINTED \(incomplete\)/);
  });

  it('candidate-present-with-minted-config: after --adopt the candidate exists, quoted and resolved', () => {
    const cwd = project();
    assert.equal(adopt(cwd).code, 0);
    const { candidate, note } = sourceSizeCandidate(cwd);
    assert.equal(note, null);
    assert.equal(candidate.id, SOURCE_SIZE_GATE_ID);
    assert.equal(candidate.cmd, `node "${TOOL}" --check`, 'the resolved, quoted tool path and the read-only mode');
    assert.equal(matchesSourceSizeGate(candidate.cmd, cwd), true, 'the offered cmd is what the canonical matcher recognizes');
  });

  it('offer-contains-source-size: the candidate is offered BEFORE the coverage checker, which stays last', () => {
    const cwd = project();
    // Mint only (no gate yet), so the offer carries every candidate at once.
    assert.equal(main(['--write-baseline', '--reason', 'initial adoption', '--cwd', cwd]).code, 0);
    const ids = buildOffer(cwd).entries.map((e) => e.id);
    assert.ok(ids.includes(SOURCE_SIZE_GATE_ID), `the offer names it: ${ids.join(', ')}`);
    assert.ok(ids.indexOf(SOURCE_SIZE_GATE_ID) < ids.indexOf('coverage-check'), `source-size precedes the checker: ${ids.join(', ')}`);
    assert.equal(ids[ids.length - 1], 'coverage-check', 'the checker is still offered last');
  });

  it('whole-offer-apply-yields-runnable-green-declaration + whole-offer-apply-final-ready', () => {
    const cwd = project();
    assert.equal(main(['--write-baseline', '--reason', 'initial adoption', '--cwd', cwd]).code, 0);
    git(cwd, ['add', '-A']); // the mint wrote the config; the scope reads the index
    applyFill({ cwd });
    const gates = declaredGates(cwd);
    assert.equal(isFinalCapableDeclaration(gates, cwd), true, `a whole-offer apply stays final-ready: ${gates.map((g) => g.id).join(', ')}`);
    const declared = gates.find((g) => g.id === SOURCE_SIZE_GATE_ID);
    assert.ok(declared, 'the source-size gate really landed in the declaration');
    // The declared cmd carries no --cwd, so it must run green from the PROJECT ROOT — exactly how the
    // runner invokes it. A gate that only passes from somewhere else is not a gate.
    const run = spawnSync('node', [TOOL, '--check'], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, `the declared gate runs green in its own project: ${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /source-size: PASS/);
  });

  it('matcher-rejects-squatter-id: a gate merely CALLED source-size is not the practice', () => {
    const cwd = project();
    mkdirSync(join(cwd, 'fake'), { recursive: true });
    writeFileSync(join(cwd, 'fake', 'source-size-check.mjs'), 'process.exit(0);\n');
    assert.equal(matchesSourceSizeGate('node "fake/source-size-check.mjs" --check', cwd), false, 'the basename is not the identity — realpath is');
    assert.equal(matchesSourceSizeGate(`node "${TOOL}" --check || true`, cwd), false, 'a masked form is not the canonical invocation');
    assert.equal(matchesSourceSizeGate(`node "${TOOL}" --write-baseline`, cwd), false, 'a writer mode is not the gate');
    assert.equal(matchesSourceSizeGate(`node "${TOOL}" --check`, cwd), true);
  });

  it('dq-unsafe-path-withheld: a kit path that does not survive double-quoting is withheld, loudly', () => {
    const cwd = project();
    assert.equal(adopt(cwd).code, 0);
    const { candidate, note } = sourceSizeCandidate(cwd, { sourceSizeTool: '/kit/we"ird/tools/source-size-check.mjs' });
    assert.equal(candidate, null, 'a rendered gate cmd could run somewhere other than the project it names');
    assert.match(note, /do not survive double-quoting/);
    assert.match(note, /by hand/, 'the withhold names the remaining lane');
  });

  // The withheld note NAMES the offending path, so the path itself crosses the line-safety boundary
  // before it is rendered. A newline in it would otherwise split one note into several preview lines
  // — the exact structure a reader parses the preview by.
  it('dq-unsafe-path-withheld: the named path crosses the line-safety boundary before it is rendered', () => {
    const cwd = project();
    assert.equal(adopt(cwd).code, 0);
    const { candidate, note } = sourceSizeCandidate(cwd, { sourceSizeTool: '/kit/we\nird/tools/source-size-check.mjs' });
    assert.equal(candidate, null);
    assert.equal(note.includes('\n'), false, `a note is ONE line: ${JSON.stringify(note)}`);
    assert.match(note, /we\\u000aird/, 'and the byte is shown escaped rather than dropped — two different paths must never print the same');
  });
});

describe('source-size — the --adopt verb (4.1.b, D-16)', () => {
  it('adopt-declares-only-source-size: a neighbouring offerable gate is NOT added', () => {
    const cwd = project();
    const result = adopt(cwd);
    assert.equal(result.code, 0, result.stdout);
    const ids = declaredGates(cwd).map((g) => g.id);
    assert.deepEqual(ids, [SOURCE_SIZE_GATE_ID], `only the one gate: ${ids.join(', ')}`);
    // The offer for this project really did carry others — the restriction is the verb's, not luck.
    assert.ok(buildOffer(cwd).entries.length > 1, 'the offer had more to give and --adopt declined it');
    assert.match(result.stdout, /gate "source-size" declared/);
    const config = JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8'));
    assert.ok(config.baseline !== undefined && config.aggregate !== undefined, 'and the record was minted in the same run');
    assert.equal(config.aggregate.src.reason, 'initial adoption', 'the pinned reason lands verbatim in the entry it raised');
  });

  it('adopt-idempotent-when-adopted: a second run converges instead of colliding', () => {
    const cwd = project();
    assert.equal(adopt(cwd).code, 0);
    git(cwd, ['add', '-A']);
    const before = readFileSync(join(cwd, 'docs', 'ai', 'gates.json'), 'utf8');
    const again = adopt(cwd);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /already declared/, 'the second run says so rather than reporting a fresh write');
    assert.equal(readFileSync(join(cwd, 'docs', 'ai', 'gates.json'), 'utf8'), before, 'the declaration is byte-identical');
    assert.deepEqual(declaredGates(cwd).map((g) => g.id), [SOURCE_SIZE_GATE_ID], 'and no duplicate landed');
  });

  it('adopt-partial-failure-loud: a refused declaration exits nonzero and reports BOTH halves', () => {
    // An id squatter: the id is taken, the cmd is not this checker — so the matcher does not read it
    // as adopted and the fill refuses the collision by name.
    const cwd = project({ gates: { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Mine', cmd: 'true' }] } });
    const result = adopt(cwd);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /INCOMPLETE/, 'the outcome is named as partial, not as a plain failure');
    assert.match(result.stdout, /the record was minted, the gate was NOT declared/);
    assert.match(result.stdout, /collision/i, 'and the actual cause is quoted, not summarised away');
    const config = JSON.parse(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8'));
    assert.ok(config.baseline !== undefined, 'the mint really did happen — a re-run must not redo it');
    // Convergence from here: clear the squatter and re-run; the minted record is recognized.
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }, null, 2));
    git(cwd, ['add', '-A']);
    const retry = adopt(cwd);
    assert.equal(retry.code, 0, retry.stdout);
    assert.deepEqual(declaredGates(cwd).map((g) => g.id), [SOURCE_SIZE_GATE_ID]);
  });

  it('adopt-partial-failure-loud: a MALFORMED declaration is reported as a partial too, never as a bare read error', () => {
    // The read of the declaration happens AFTER the mint, so its failure class must be the same
    // partial-outcome report as a refused write — and it must stay inside this tool's exit contract
    // (0/1/2), not surface the declaration reader's own malformed code.
    const cwd = project();
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), '{ not json');
    const result = adopt(cwd);
    assert.equal(result.code, 1, `the documented refusal code, not the reader's: ${result.code}`);
    assert.match(result.stdout, /the record was minted, the gate was NOT declared/);
    assert.match(result.stdout, /malformed JSON/, 'and the real cause is quoted');
    assert.equal(result.stderr, '', 'it is a reported refusal, not an escaped throw');
  });

  it('adopt-requires-authored-config: on a path that withholds the render, the manual lane names THIS verb, not the mint', () => {
    // The withheld fallback is the reader's only remaining instruction, so it has to be the
    // instruction for what they were doing. Naming the regenerator here would leave them with a
    // minted record and no gate — half an adoption, reported as the way out.
    const cwd = join(TMP, 'dq"unsafe');
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    git(cwd, ['init', '-q', '-b', 'main']);
    const result = main(['--adopt', '--reason', 'initial adoption', '--cwd', cwd]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /no paste-ready command is printed/, 'the render is withheld on this path');
    // The verb name in the REFUSAL header proves nothing — it is the recovery sentence that must
    // name it, and it must not send the reader to the mint, which would leave the gate undeclared.
    assert.doesNotMatch(result.stdout, /--write-baseline/, `the adopt refusal must not route to the mint verb: ${result.stdout}`);
    assert.match(result.stdout, /Run source-size-check\.mjs --adopt/, `the manual lane names the verb being run: ${result.stdout}`);
  });

  it('adopt-requires-authored-config: an absent config refuses with the template, and says the step is expected', () => {
    const cwd = project({ config: null });
    const result = adopt(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /--adopt REFUSED/);
    assert.match(result.stdout, /EXPECTED, not a failure/, 'authoring the scope is the practice\'s one manual step, not an error');
    assert.match(result.stdout, /"roots": \[\n\s+"<a directory this practice covers>"/, 'the printed template is INERT — its placeholders the validator refuses');
    assert.match(result.stdout, /--adopt --cwd/, 'and the re-run command is rendered, resolved and quoted');
    assert.equal(declaredGates(cwd).length, 0, 'nothing was declared');
  });

  it('the mint half keeps its OWN self-servable refusals — --adopt does not re-word them', () => {
    const cwd = project();
    const result = main(['--adopt', '--cwd', cwd]); // a first mint raises every value, so it needs a reason
    assert.equal(result.code, 1);
    assert.match(result.stdout, /RAISES \d+ recorded value\(s\)/, 'the reason-required refusal is the mint\'s, verbatim');
    assert.equal(declaredGates(cwd).length, 0, 'and nothing was declared over a record that was never written');
  });

  // The laundering hole a re-run opens if adoption re-mints. The advisor renders this verb with a
  // PINNED reason, and the item keeps firing while the gate is undeclared — so a partial adoption
  // plus any later growth would let that fixed sentence raise the ratchet, which is precisely the
  // considered-reason requirement the ratchet exists to impose.
  it('adopt-recognizes-a-minted-record: a re-run after a partial adoption never regenerates, so growth cannot ride the adoption reason', () => {
    const cwd = project({ gates: { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Mine', cmd: 'true' }] } });
    assert.equal(adopt(cwd).code, 1, 'the squatter fails the declaration half — the record is minted, the gate is not');
    const before = recordOf(cwd).aggregate.src.lines;
    // The tree grows between the partial failure and the retry, and the squatter is cleared.
    writeFileSync(join(cwd, 'src', 'b.mjs'), 'export const b = 1;\n'.repeat(12));
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }, null, 2));
    git(cwd, ['add', '-A']);
    const retry = adopt(cwd);
    assert.equal(recordOf(cwd).aggregate.src.lines, before, 'the recorded aggregate must NOT move under the pinned adoption reason');
    assert.equal(retry.code, 1, 'and a record that no longer holds is a refusal, not a silently re-armed gate');
    assert.match(retry.stdout, /exceeds the recorded budget/, 'the ratchet speaks for itself');
    assert.match(retry.stdout, /--reason/, 'and the refusal names the reasoned lane the raise actually needs');
    assert.deepEqual(declaredGates(cwd).map((g) => g.id), [], 'no gate was declared over a record that would red the matrix');
  });

  it('adopt-recognizes-a-minted-record: an unchanged minted tree is RECOGNIZED — the run says so, and the gate still lands', () => {
    const cwd = project({ gates: { gates: [{ id: SOURCE_SIZE_GATE_ID, title: 'Mine', cmd: 'true' }] } });
    assert.equal(adopt(cwd).code, 1);
    const before = readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8');
    writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }, null, 2));
    const retry = adopt(cwd);
    assert.equal(retry.code, 0, retry.stdout);
    assert.equal(readFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), 'utf8'), before, 'the record file is byte-identical');
    // Byte-identity alone cannot tell a recognition from a regeneration that happened to rewrite the
    // same bytes — and those two differ exactly when the tree has moved. The run must SAY which it did.
    assert.match(retry.stdout, /recognized, not regenerated/, `the record was recognized: ${retry.stdout}`);
    assert.deepEqual(declaredGates(cwd).map((g) => g.id), [SOURCE_SIZE_GATE_ID]);
  });

  // Idempotence is a promise about the GATE, and it cannot be conditional on the record still
  // holding: a declared gate reports its own staleness on every run, loudly, with the reasoned lane.
  // Refusing here would tell a reader the gate was not declared when it plainly is — and re-running
  // the advisor's one-liner on a drifted tree is exactly when that happens.
  it('adopt-idempotent-when-adopted: an already-declared gate converges even when the tree outgrew the record', () => {
    const cwd = project();
    assert.equal(adopt(cwd).code, 0);
    writeFileSync(join(cwd, 'src', 'b.mjs'), 'export const b = 1;\n'.repeat(12));
    git(cwd, ['add', '-A']);
    const again = adopt(cwd);
    assert.equal(again.code, 0, `the gate is declared; nothing is left to adopt: ${again.stdout}`);
    assert.match(again.stdout, /already declared/);
    assert.doesNotMatch(again.stdout, /was NOT declared/, 'it must never report a gate it can see as missing');
    // The drift is not swallowed — the GATE is what reports it, which is the whole point.
    assert.equal(main(['--check', '--cwd', cwd]).code, 1, 'the declared gate still refuses over the stale record');
  });

  it('the no-mode usage error names every mode this tool has, --adopt included', () => {
    const result = main(['--cwd', project()]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--adopt/, `a mode missing from its own usage line is unreachable by reading: ${result.stderr}`);
  });

  it('a repeated mode is still a usage error — the exactly-ONE-mode guard counts occurrences, not kinds', () => {
    // Deduplicating before counting made the guard blind to the one shape it exists to catch, and a
    // WRITE ran under an argument list the tool had just called invalid.
    const cwd = project();
    const result = main(['--adopt', '--adopt', '--reason', 'initial adoption', '--cwd', cwd]);
    assert.equal(result.code, 2, `a repeated mode is a usage error: ${result.stderr}`);
    assert.equal(declaredGates(cwd).length, 0, 'and nothing was written under it');
  });

  it('runAdopt is reachable as a library call, with the same contract as the CLI', () => {
    const cwd = project();
    const result = runAdopt({ cwd, reason: 'initial adoption' });
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.deepEqual(declaredGates(cwd).map((g) => g.id), [SOURCE_SIZE_GATE_ID]);
  });
});

describe('source-size — the plan keeps its own rule', () => {
  it('phase4-plan-files-within-defaults: every file this plan has created through Phase 4 is within the declared defaults', () => {
    // Cumulative and EXPLICIT (never derived from git state), so an earlier phase's file growing under
    // a later phase's edits is caught here. Phase 4 added NO runtime module — only these two test
    // files — which is why the package tarball count does not move.
    const created = [
      'agent-workflow-kit/tools/source-size-core.mjs',
      'agent-workflow-kit/tools/source-size-check.mjs',
      'agent-workflow-kit/tools/source-size-check.test.mjs',
      'agent-workflow-kit/tools/source-size-core.test.mjs',
      'agent-workflow-kit/tools/source-size-config.test.mjs',
      'agent-workflow-kit/tools/source-size-ratchet.test.mjs',
      'agent-workflow-kit/tools/source-size-refusal.mjs',
      'agent-workflow-kit/tools/source-size-config.mjs',
      'agent-workflow-kit/tools/source-size-scope.mjs',
      'agent-workflow-kit/tools/source-size-gate-cmd.mjs',
      'agent-workflow-kit/tools/source-size-judge.mjs',
      'agent-workflow-kit/tools/source-size-report.mjs',
      'agent-workflow-kit/tools/source-size-aggregate.test.mjs',
      'agent-workflow-kit/tools/source-size-writer.test.mjs',
      'agent-workflow-kit/tools/source-size-practice.test.mjs',
      'agent-workflow-kit/tools/source-size-stop-rendering.test.mjs',
      'agent-workflow-kit/tools/source-size-adopt.test.mjs',
      'agent-workflow-kit/tools/recommendations-source-size.test.mjs',
    ];
    for (const rel of created) {
      const { lines: count, maxLineBytes } = measureFile(REPO_ROOT, rel);
      assert.ok(count <= SOURCE_SIZE_DEFAULTS.maxLines, `${rel}: ${count} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines}`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${rel}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });
});

// sarif-intake.test.mjs — spec-first for the OPTIONAL SARIF advisory intake (BUGFREE-3, AD-049, step
// 1.4). The dependency-free parser, the advisory-only contract (findings print to stdout; NOTHING is
// recorded on a fold run record — SARIF stays entirely out of the fold schema), the no-op branches
// (absent path / missing file), and the fail-closed-but-scoped failure (a malformed SARIF makes the
// --findings verb exit nonzero, but the fold RUN + gate never read SARIF and are unaffected).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSarif, renderSarifFindings } from './sarif.mjs';
import { main, runFoldCompleteness } from './fold-completeness-run.mjs';

const SARIF_FIXTURE = JSON.stringify({
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'demo-linter' } },
    results: [
      { ruleId: 'no-unused', level: 'warning', message: { text: 'unused var' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.mjs' }, region: { startLine: 12 } } }] },
      { ruleId: 'no-eval', level: 'error', message: { text: 'no eval' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/b.mjs' }, region: { startLine: 3 } } }] },
    ],
  }],
});

describe('parseSarif — findings extraction + loud on malformed', () => {
  it('extracts ruleId/level/message/file/line from SARIF results', () => {
    const { findings } = parseSarif(SARIF_FIXTURE);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings[0], { ruleId: 'no-unused', level: 'warning', message: 'unused var', file: 'src/a.mjs', line: 12 });
    assert.equal(findings[1].ruleId, 'no-eval');
  });
  it('a well-formed run with zero results → empty findings (a clean advisory)', () => {
    assert.deepEqual(parseSarif(JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] })).findings, []);
  });
  it('malformed JSON → THROWS (loud advisory read)', () => {
    assert.throws(() => parseSarif('{ not json'), /SARIF is not valid JSON/);
  });
  it('no runs[] array → THROWS (not a SARIF document)', () => {
    assert.throws(() => parseSarif(JSON.stringify({ version: '2.1.0' })), /no runs\[\] array/);
  });
  it('renderSarifFindings lists findings + states advisory-only; empty → a clean note', () => {
    assert.match(renderSarifFindings(parseSarif(SARIF_FIXTURE).findings), /advisory only.*never gate-blocking/);
    assert.match(renderSarifFindings([]), /no findings/);
  });
});

// ── the --findings verb over a hermetic fixture ────────────────────────────────────────────────────

const fixtureEnv = (root) => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AW_')) delete env[k];
  return { ...env, AW_REVIEW_LEDGER: join(root, '.git', 'rl.jsonl'), AW_FOLD_RESULTS: join(root, '.git', 'fc.jsonl') };
};

const makeRepo = (profile) => {
  const root = mkdtempSync(join(tmpdir(), 'sarif-'));
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'p@e.com');
  g('config', 'user.name', 'p');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(root, '.fold'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.fold/\n');
  writeFileSync(join(root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'unit-tests', title: 't', cmd: 'true' }] }));
  writeFileSync(join(root, 'docs', 'plans', 'queue.md'), '# queue\n');
  writeFileSync(join(root, 'docs', 'plans', 'active-plan.md'), '# plan\n');
  if (profile) writeFileSync(join(root, 'docs', 'ai', 'verification-profile.json'), JSON.stringify(profile));
  g('add', '-A');
  g('commit', '-qm', 'base');
  return { root };
};

describe('--findings — advisory print, never recorded, scoped failure', () => {
  const PROFILE = { schema: 1, findings: { sarifPath: '.fold/report.sarif' } };

  it('prints the SARIF findings on stdout (exit 0)', () => {
    const { root } = makeRepo(PROFILE);
    writeFileSync(join(root, '.fold', 'report.sarif'), SARIF_FIXTURE);
    const r = main(['--findings'], { cwd: root, env: fixtureEnv(root) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no-unused/);
    assert.match(r.stdout, /advisory only/);
  });

  it('the fold RUN record carries NO sarif field (SARIF stays out of the schema)', () => {
    const { root } = makeRepo(PROFILE);
    writeFileSync(join(root, '.fold', 'report.sarif'), SARIF_FIXTURE);
    // a dirty tree so the run has a surface (an untracked assessable file)
    writeFileSync(join(root, 'x.mjs'), 'export const a = 1;\n');
    const { record } = runFoldCompleteness({ cwd: root, env: fixtureEnv(root), suiteCmd: 'true' });
    rmSync(root, { recursive: true, force: true });
    assert.equal('sarif' in record, false, 'the run record has no sarif key');
    assert.equal('findings' in record, false, 'the run record has no findings key');
    assert.equal(JSON.stringify(record).includes('sarif'), false, 'nothing sarif-shaped is recorded');
  });

  it('an absent findings.sarifPath → a stated no-op (exit 0)', () => {
    const { root } = makeRepo({ schema: 1 });
    const r = main(['--findings'], { cwd: root, env: fixtureEnv(root) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no findings\.sarifPath declared/);
  });

  it('a missing SARIF file (declared but not written) → a stated no-op (exit 0)', () => {
    const { root } = makeRepo(PROFILE);
    const r = main(['--findings'], { cwd: root, env: fixtureEnv(root) });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no SARIF file at/);
  });

  it('a MALFORMED SARIF → --findings exits nonzero (loud), but the fold RUN is unaffected', () => {
    const { root } = makeRepo(PROFILE);
    writeFileSync(join(root, '.fold', 'report.sarif'), '{ not sarif');
    writeFileSync(join(root, 'x.mjs'), 'export const a = 1;\n'); // a surface for the run
    const env = fixtureEnv(root);
    const findingsResult = main(['--findings'], { cwd: root, env });
    // the fold RUN never reads SARIF → it still succeeds with the garbage file present
    const run = main([], { cwd: root, env, });
    rmSync(root, { recursive: true, force: true });
    assert.equal(findingsResult.code, 1, 'a malformed SARIF fails the advisory verb loudly');
    assert.match(findingsResult.stderr, /SARIF/);
    assert.equal(run.code, 0, 'the fold run is unaffected by the malformed SARIF (it never reads it)');
  });
});

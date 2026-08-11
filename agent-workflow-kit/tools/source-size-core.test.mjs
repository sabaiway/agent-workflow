// source-size-core.test.mjs — the core's own contracts, pinned separately from the scope/counting
// suite: what the checker PRINTS must be accepted by the validator that reads it back, every
// refusal must name the project it actually judged, the canonical matcher must refuse a command the
// shell would read differently, and the direct-run guard must survive a symlinked invocation.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import {
  validateSourceSizeConfig, matchesSourceSizeGate, measureFile, SOURCE_SIZE_DEFAULTS,
} from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-core-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const lines = (n) => 'x\n'.repeat(n);

const CONFIG = (over = {}) => ({
  _README: 'fixture',
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline: {},
  aggregate: { src: { lines: 0, reason: 'initial adoption' } },
  ...over,
});

let seq = 0;
const project = ({ files = {}, config = CONFIG() } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd, ctx = {}) => main(['--check', '--cwd', cwd], ctx);
const out = (result) => `${result.stdout}\n${result.stderr}`;

// The suggested entry is printed as a JSON fragment; parsing it back is the only honest way to
// assert that the config validator would accept the exact bytes a human is told to paste.
const suggestedEntries = (stdout) => {
  const entries = {};
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('}')) continue;
    Object.assign(entries, JSON.parse(`{${trimmed}}`));
  }
  return entries;
};

describe('source-size — what the checker prints must survive the validator that reads it back', () => {
  it('printed-baseline-entry-revalidates: the entry a refusal tells a human to paste is ACCEPTED by the config validator', () => {
    const cwd = project({ files: { 'src/wide.mjs': `${'x'.repeat(1001)}\n`, 'src/big.mjs': lines(401) } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    const baseline = suggestedEntries(result.stdout);
    assert.deepEqual(Object.keys(baseline).sort(), ['src/big.mjs', 'src/wide.mjs']);
    for (const entry of Object.values(baseline)) entry.reason = 'accepted for now';
    assert.doesNotThrow(() => validateSourceSizeConfig({ ...CONFIG(), baseline }));
  });

  it('baseline-entry-accepts-either-dimension: lines alone, maxLineBytes alone, and both are all valid records', () => {
    for (const entry of [{ lines: 401 }, { maxLineBytes: 1001 }, { lines: 401, maxLineBytes: 1001 }]) {
      assert.doesNotThrow(() => validateSourceSizeConfig({ ...CONFIG(), baseline: { 'src/a.mjs': { ...entry, reason: 'r' } } }));
    }
  });

  it('baseline-entry-needs-at-least-one-dimension: a reason alone records nothing and is refused', () => {
    assert.throws(
      () => validateSourceSizeConfig({ ...CONFIG(), baseline: { 'src/a.mjs': { reason: 'r' } } }),
      /at least one of "lines" or "maxLineBytes"/,
    );
  });

  it('aggregate-entry-still-requires-lines: the root budget has exactly one dimension', () => {
    assert.throws(
      () => validateSourceSizeConfig({ ...CONFIG(), aggregate: { src: { reason: 'r' } } }),
      /"aggregate"\."src"\.lines/,
    );
  });

  it('absent-refusal-names-no-unimplemented-verb: the printed authoring file mentions no command this build rejects', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /--write-baseline/);
    assert.doesNotMatch(result.stdout, /--adopt/);
    assert.doesNotMatch(result.stdout, /--reason/);
  });
});

describe('source-size — every refusal names the project it judged', () => {
  it('core-refusals-name-the-absolute-config-path: a fail-closed refusal under a foreign cwd points at the judged project', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) } });
    writeFileSync(join(cwd, 'src', 'bin.mjs'), Buffer.from([0x61, 0xff, 0x0a]));
    git(cwd, ['add', '-A']);
    const foreign = project({ files: { 'src/ok.mjs': lines(10) } });
    const result = check(cwd, { cwd: foreign });
    assert.equal(result.code, 1);
    assert.ok(out(result).includes(join(cwd, 'docs/ai/source-size.json')), `the judged project's config must be named:\n${out(result)}`);
    assert.doesNotMatch(out(result), /add its prefix to "exclude" in docs\/ai/);
  });

  it('empty-scope-refusal-states-the-servable-step: a zero-match scope says what to change and where', () => {
    const cwd = project({ files: { 'other/a.mjs': lines(10) } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(out(result), /matches ZERO tracked files/);
    assert.match(out(result), /"roots"/);
    assert.match(out(result), /"extensions"/);
    assert.ok(out(result).includes(join(cwd, 'docs/ai/source-size.json')), `the config to edit must be named:\n${out(result)}`);
  });
});

describe('source-size — the canonical matcher and the direct-run guard', () => {
  it('matcher-rejects-shell-metacharacter-in-bare-token: an unquoted token the shell would split is never canonical', () => {
    const dir = join(TMP, 'meta;dir');
    mkdirSync(dir, { recursive: true });
    symlinkSync(TOOL, join(dir, 'source-size-check.mjs'));
    // Bare (unquoted) — the shell would treat `;` as a command separator, so this command does not
    // run the checker at all, however cleanly realpath resolves the literal string.
    assert.equal(matchesSourceSizeGate(`node ${join(dir, 'source-size-check.mjs')} --check`, REPO_ROOT), false);
    for (const meta of ['&', '|', '*', '?', "'"]) {
      const metaDir = join(TMP, `meta${meta}dir`);
      mkdirSync(metaDir, { recursive: true });
      symlinkSync(TOOL, join(metaDir, 'source-size-check.mjs'));
      assert.equal(matchesSourceSizeGate(`node ${join(metaDir, 'source-size-check.mjs')} --check`, REPO_ROOT), false, `bare token carrying ${meta} must be refused`);
    }
  });

  it('direct-run-guard-resolves-symlinks: invoking the checker THROUGH a symlink still runs it', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) } });
    const linkDir = join(TMP, 'link-dir');
    mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, 'source-size-check.mjs');
    symlinkSync(TOOL, link);
    const run = spawnSync(process.execPath, [link, '--check', '--cwd', cwd], { encoding: 'utf8' });
    // A lexical guard silently exits 0 having printed nothing — a declared gate would read that as
    // PASS while checking nothing, which is the exact false green the gate exists to prevent.
    assert.match(`${run.stdout}${run.stderr}`, /src\/big\.mjs: lines 401/);
    assert.equal(run.status, 1);
  });
});

describe('source-size — the plan keeps its own rule', () => {
  it('phase1-plan-files-within-defaults-includes-the-core-suite: every file this phase created is within the declared defaults', () => {
    const created = [
      'agent-workflow-kit/tools/source-size-core.mjs',
      'agent-workflow-kit/tools/source-size-check.mjs',
      'agent-workflow-kit/tools/source-size-check.test.mjs',
      'agent-workflow-kit/tools/source-size-core.test.mjs',
    ];
    for (const rel of created) {
      const { lines: count, maxLineBytes } = measureFile(REPO_ROOT, rel);
      assert.ok(count <= SOURCE_SIZE_DEFAULTS.maxLines, `${rel}: ${count} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines}`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${rel}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });
});

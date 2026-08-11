// source-size-check.test.mjs — Phase 1 of the source-size practice: the declared-scope rule (D-6),
// the counting rule (D-7) and the threshold judgement (D-1). Every fixture is written into a
// per-test temp directory and staged, because scope is INDEX-visible: a loose fixture committed
// beside this file would itself enter scope and the published tarball.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './source-size-check.mjs';
import { authoringTemplate } from './source-size-report.mjs';
import {
  countBytes, measureFile, validateSourceSizeConfig, matchesSourceSizeGate, SOURCE_SIZE_DEFAULTS,
} from './source-size-core.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOOL = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

const git = (cwd, args, opts = {}) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const put = (cwd, rel, body) => {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

// A path whose NAME is not valid UTF-8, written under `dir` with the given extension.
const putBadName = (cwd, dir, ext, body = lines(3)) =>
  writeFileSync(Buffer.concat([Buffer.from(`${cwd}/${dir}/`), Buffer.from([0xff]), Buffer.from(ext)]), body);

const lines = (n) => 'x\n'.repeat(n);

// The recorded root budget a fixture carries. It is stated per fixture rather than derived, because
// a helper that re-implemented the scope rule to compute it would agree with a scope bug instead of
// catching one: every green fixture below names the line total its own in-scope files add up to.
const agg = (lines) => ({ src: { lines, reason: 'initial adoption' } });

const CONFIG = (over = {}) => ({
  _README: 'fixture',
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
  baseline: {},
  aggregate: agg(0),
  ...over,
});

let seq = 0;
// A project fixture: a real git work tree with a deployed docs/ai. Nothing is ever committed — the
// index alone is what `ls-files -s` reads, so no git identity is needed.
const project = ({ files = {}, config = CONFIG(), suffix = '', stage = true } = {}) => {
  const cwd = join(TMP, `p${seq += 1}${suffix}`);
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) put(cwd, rel, body);
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  if (stage) git(cwd, ['add', '-A']);
  return cwd;
};

const check = (cwd, ctx = {}) => main(['--check', '--cwd', cwd], ctx);
const out = (result) => `${result.stdout}\n${result.stderr}`;

describe('source-size — declared scope (D-6)', () => {
  it('scope-tracked-only: an untracked file is invisible, the same file staged is judged', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) }, stage: false });
    git(cwd, ['add', 'docs']);
    // The refusal must be the EMPTY-SCOPE one: a size violation would also exit 1, so an exit code
    // alone would stay green on a checker that wrongly judged the untracked file.
    const before = check(cwd);
    assert.equal(before.code, 1);
    assert.match(out(before), /matches ZERO tracked files/);
    assert.doesNotMatch(out(before), /src\/big\.mjs/);
    git(cwd, ['add', '-A']);
    const after = check(cwd);
    assert.equal(after.code, 1);
    assert.match(after.stdout, /src\/big\.mjs: lines 401 exceeds the declared default 400/);
  });

  it('scope-outside-roots-ignored: a file outside every declared root is never judged', () => {
    const cwd = project({ files: { 'other/big.mjs': lines(401), 'src/ok.mjs': lines(10) }, config: CONFIG({ aggregate: agg(10) }) });
    assert.equal(check(cwd).code, 0);
  });

  it('scope-excluded-prefix-ignored: a file under an excluded prefix is never judged', () => {
    const cwd = project({
      files: { 'src/vendor/big.mjs': lines(401), 'src/ok.mjs': lines(10) },
      config: CONFIG({ exclude: ['src/vendor'], aggregate: agg(10) }),
    });
    assert.equal(check(cwd).code, 0);
  });

  it('scope-extension-filter: an undeclared extension is never judged', () => {
    const cwd = project({ files: { 'src/big.txt': lines(401), 'src/ok.mjs': lines(10) }, config: CONFIG({ aggregate: agg(10) }) });
    assert.equal(check(cwd).code, 0);
  });

  it('scope-symlink-skipped: a tracked symlink carrying a declared extension is skipped BY KIND', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10), 'target.txt': lines(401) }, config: CONFIG({ aggregate: agg(10) }), stage: false });
    symlinkSync('../target.txt', join(cwd, 'src', 'link.mjs'));
    git(cwd, ['add', '-A']);
    assert.equal(git(cwd, ['ls-files', '-s', 'src/link.mjs']).slice(0, 6), '120000');
    assert.equal(check(cwd).code, 0);
  });

  it('scope-submodule-gitlink-skipped: a gitlink index entry is skipped BY KIND', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) }, config: CONFIG({ aggregate: agg(10) }) });
    const sha = git(cwd, ['hash-object', '-w', '--stdin'], { input: 'commitish' });
    git(cwd, ['update-index', '--add', '--cacheinfo', `160000,${sha},src/sub.mjs`]);
    assert.equal(git(cwd, ['ls-files', '-s', 'src/sub.mjs']).slice(0, 6), '160000');
    assert.equal(check(cwd).code, 0);
  });

  it('scope-non-utf8-fails-closed: an in-scope file whose CONTENT is not UTF-8 is exit 1 naming the exclude lane', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) }, stage: false });
    writeFileSync(join(cwd, 'src', 'bin.mjs'), Buffer.from([0x61, 0xff, 0x0a]));
    git(cwd, ['add', '-A']);
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(out(result), /src\/bin\.mjs: in-scope but not valid UTF-8/);
    assert.match(out(result), /"exclude"/);
  });

  it('scope-unreadable-file-fails-closed: an unreadable in-scope file is exit 1, never a silent skip', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10), 'src/locked.mjs': lines(10) } });
    chmodSync(join(cwd, 'src', 'locked.mjs'), 0o000);
    const result = check(cwd);
    chmodSync(join(cwd, 'src', 'locked.mjs'), 0o644);
    assert.equal(result.code, 1);
    assert.match(out(result), /src\/locked\.mjs: in-scope but unverifiable/);
  });

  it('scope-git-failure-exit-2: a failed enumeration is exit 2, never a green', () => {
    const cwd = join(TMP, `nogit${seq += 1}`);
    mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(CONFIG(), null, 2));
    const result = check(cwd);
    assert.equal(result.code, 2);
    assert.match(out(result), /the git index could not be enumerated/);
  });

  it('exclude-prefix-segment-boundary: an exclude prefix matches whole path segments only', () => {
    const cwd = project({
      files: { 'src/vendor-other/big.mjs': lines(401), 'src/vendor/skipped.mjs': lines(401) },
      config: CONFIG({ exclude: ['src/vendor'] }),
    });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/vendor-other\/big\.mjs: lines 401/);
    assert.doesNotMatch(result.stdout, /src\/vendor\/skipped\.mjs/);
  });

  it('scope-filename-special-bytes: a tracked path carrying a tab and one carrying a newline are enumerated byte-exactly', () => {
    const tabbed = 'src/a\tb.mjs';
    const newlined = 'src/c\nd.mjs';
    const cwd = project({ files: { [tabbed]: lines(401), [newlined]: lines(401) } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(tabbed), `the tab-carrying path must be named verbatim:\n${result.stdout}`);
    assert.ok(result.stdout.includes(newlined), `the newline-carrying path must be named verbatim:\n${result.stdout}`);
  });

  it('scope-unmerged-index-refuses: an ambiguous index is a loud refusal, never a judgement', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) } });
    const sha = git(cwd, ['hash-object', '-w', '--stdin'], { input: 'x' });
    const stages = [1, 2, 3].map((n) => `100644 ${sha} ${n}\tsrc/a.mjs`).join('\n');
    git(cwd, ['update-index', '--index-info'], { input: `${stages}\n` });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(out(result), /the git index is UNMERGED/);
  });

  it('scope-non-utf8-filename-fails-closed: an in-scope path whose NAME is not UTF-8 is a loud refusal', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) }, stage: false });
    putBadName(cwd, 'src', '.mjs');
    git(cwd, ['add', '-A']);
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(out(result), /NAME is not valid UTF-8/);
  });

  it('scope-exclusions-precede-decoding: a non-UTF-8 name excluded BY RULE or BY KIND is ignored, never decoded', () => {
    const cwd = project({
      files: { 'src/ok.mjs': lines(10), 'other/keep.txt': 'x\n', 'src/vendor/keep.txt': 'x\n' },
      config: CONFIG({ exclude: ['src/vendor'], aggregate: agg(10) }),
      stage: false,
    });
    putBadName(cwd, 'other', '.mjs'); // outside every declared root
    putBadName(cwd, 'src', '.txt'); // undeclared extension
    putBadName(cwd, 'src/vendor', '.mjs'); // under an excluded prefix
    // A SYMLINK whose own name is not UTF-8: excluded BY KIND, which must be decided before decoding.
    symlinkSync('ok.mjs', Buffer.concat([Buffer.from(`${cwd}/src/`), Buffer.from([0xff]), Buffer.from('-link.mjs')]));
    git(cwd, ['add', '-A']);
    assert.equal(check(cwd).code, 0, 'an out-of-scope non-UTF-8 name must never reach the decoder');
  });

  it('scope-index-worktree-divergence: the judged bytes are the WORKTREE bytes of an index-visible path', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) } });
    writeFileSync(join(cwd, 'src', 'a.mjs'), lines(401));
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/a\.mjs: lines 401/);
  });

  it('scope-empty-set-refused: a declared scope matching zero tracked files is refused, never an empty green', () => {
    const cwd = project({ files: { 'other/a.mjs': lines(10) } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(out(result), /matches ZERO tracked files/);
  });

  it('cli-cwd-foreign-directory: --check judges the named project, not the invoking directory', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) } });
    const foreign = project({ files: { 'src/ok.mjs': lines(10) } });
    const result = check(cwd, { cwd: foreign });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/big\.mjs: lines 401/);
  });

  it('cli-project-path-with-spaces: the named config path survives a project path carrying spaces', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) }, suffix: ' with spaces' });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(join(cwd, 'docs/ai/source-size.json')), `the config path must be named in full:\n${result.stdout}`);
  });

  it('cli-dq-unsafe-project-path-withheld: a project path that does not survive double-quoting still gets the FULL refusal — parameters and the servable lane', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) }, suffix: '-$dq' });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/big\.mjs: lines 401 exceeds the declared default 400/);
    assert.ok(result.stdout.includes(join(cwd, 'docs/ai/source-size.json')), `the config path must still be named:\n${result.stdout}`);
    assert.match(result.stdout, /"src\/big\.mjs": \{ "lines": 401/);
  });

  it('cli-relative-cwd-resolved-absolute: a relative --cwd is resolved before the check and before any rendering', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) }, config: null });
    const result = main(['--check', '--cwd', '.'], { cwd });
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(join(cwd, 'docs/ai/source-size.json')), `the named path must be absolute:\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /(^|[^.])\.\/docs\/ai/m);
  });
});

describe('source-size — the canonical gate matcher', () => {
  it('matcher-accepts-canonical-invocation: the plain quoted and bare forms both resolve', () => {
    assert.equal(matchesSourceSizeGate(`node "${TOOL}" --check`, REPO_ROOT), true);
    assert.equal(matchesSourceSizeGate('node agent-workflow-kit/tools/source-size-check.mjs --check', REPO_ROOT), true);
  });

  it('matcher-rejects-newline-separator: only plain spaces separate the tokens', () => {
    assert.equal(matchesSourceSizeGate(`node\n"${TOOL}" --check`, REPO_ROOT), false);
    assert.equal(matchesSourceSizeGate(`node "${TOOL}"\n--check`, REPO_ROOT), false);
  });

  it('matcher-rejects-dq-unsafe-token: a token the shell would reinterpret is never canonical', () => {
    const linked = join(TMP, 'dq$dir');
    mkdirSync(linked, { recursive: true });
    symlinkSync(TOOL, join(linked, 'source-size-check.mjs'));
    assert.equal(matchesSourceSizeGate(`node "${join(linked, 'source-size-check.mjs')}" --check`, REPO_ROOT), false);
  });
});

describe('source-size — counting (D-7)', () => {
  const measured = (bytes) => countBytes(Buffer.from(bytes));

  it('count-crlf-two-lines: CRLF terminators never count toward the line length', () => {
    assert.deepEqual(measured([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a]), { lines: 2, maxLineBytes: 1 });
  });

  it('count-no-final-newline: a last line with no terminator still counts', () => {
    assert.deepEqual(measured([0x61, 0x0a, 0x62]), { lines: 2, maxLineBytes: 1 });
  });

  it('count-utf8-multibyte-line-bytes: the line length is BYTES, not characters', () => {
    assert.deepEqual(measured([0xc3, 0xa9, 0x0a]), { lines: 1, maxLineBytes: 2 });
  });

  it('count-empty-file: an empty file is 0 lines', () => {
    assert.deepEqual(measured([]), { lines: 0, maxLineBytes: 0 });
  });

  it('count-trailing-blank-lines: trailing blank lines count; only the final terminator adds none', () => {
    assert.deepEqual(measured([0x61, 0x0a, 0x0a, 0x0a]), { lines: 3, maxLineBytes: 1 });
  });
});

describe('source-size — thresholds (D-1)', () => {
  it('threshold-new-file-over-400-fails: the refusal names file, actual and allowed', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/big\.mjs: lines 401 exceeds the declared default 400/);
  });

  it('refusal-names-only-servable-lane: the remedy is the regenerator this build implements plus the hand-authored entry — never a verb it does not have', () => {
    const cwd = project({ files: { 'src/big.mjs': lines(401) } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    // Only the VIOLATING dimension is recorded: an entry pinning a 1-byte longest line would make
    // the ratchet refuse every later line-length change for no reason anyone chose.
    assert.match(result.stdout, /"src\/big\.mjs": \{ "lines": 401, "reason": "<why this size is accepted>" \}/);
    assert.doesNotMatch(result.stdout, /"maxLineBytes"/);
    assert.match(result.stdout, /--write-baseline/);
    assert.doesNotMatch(result.stdout, /--adopt/, 'the adopt verb arrives with its own phase — a refusal never names it early');
  });

  it('the suggested entry carries maxLineBytes exactly when THAT dimension is the violation', () => {
    const cwd = project({ files: { 'src/wide.mjs': `${'x'.repeat(1001)}\n` } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"src\/wide\.mjs": \{ "maxLineBytes": 1001, "reason": "<why this size is accepted>" \}/);
  });

  it('authored-config-refusal-names-the-mint-command: the AUTHORED state names the step this build performs', () => {
    const cwd = project({ files: { 'src/ok.mjs': lines(10) }, config: CONFIG({ baseline: undefined, aggregate: undefined }) });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /AUTHORED but not yet MINTED/);
    assert.match(result.stdout, /--write-baseline --cwd .+ --reason "initial adoption"/);
    assert.doesNotMatch(result.stdout, /--adopt/);
  });

  it('baseline-entry-does-not-suppress-fail-closed: a recorded file that is unverifiable still refuses (D-6 has no baseline exception)', () => {
    const cwd = project({
      files: { 'src/ok.mjs': lines(10), 'src/big.mjs': lines(401) },
      config: CONFIG({ baseline: { 'src/big.mjs': { lines: 401, reason: 'initial adoption' } } }),
    });
    chmodSync(join(cwd, 'src', 'big.mjs'), 0o000);
    const result = check(cwd);
    chmodSync(join(cwd, 'src', 'big.mjs'), 0o644);
    assert.equal(result.code, 1);
    assert.match(out(result), /src\/big\.mjs: in-scope but unverifiable/);
  });

  it('threshold-long-line-fails: a line over 1000 UTF-8 bytes fails under the shipped defaults', () => {
    const cwd = project({ files: { 'src/wide.mjs': `${'x'.repeat(1001)}\n` } });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/wide\.mjs: maxLineBytes 1001 exceeds the declared default 1000/);
  });

  it('threshold-defaults-overridable: a project may declare its own defaults', () => {
    const files = { 'src/a.mjs': lines(6) };
    assert.equal(check(project({ files, config: CONFIG({ aggregate: agg(6) }) })).code, 0);
    const tightened = project({ files, config: CONFIG({ defaults: { maxLines: 5, maxLineBytes: 1000 }, aggregate: agg(6) }) });
    const result = check(tightened);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/a\.mjs: lines 6 exceeds the declared default 5/);
  });

  it('a file carrying a recorded baseline entry is recorded debt, not a defaults violation', () => {
    const cwd = project({
      files: { 'src/big.mjs': lines(401) },
      config: CONFIG({ baseline: { 'src/big.mjs': { lines: 401, reason: 'initial adoption' } }, aggregate: agg(401) }),
    });
    assert.equal(check(cwd).code, 0);
  });

  it('the printed authoring template is INERT — its placeholders are refused until replaced', () => {
    const cwd = project({ files: { 'src/a.mjs': lines(10) }, config: null });
    const result = check(cwd);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /is absent, so the scope of this practice is undeclared/);
    assert.throws(() => validateSourceSizeConfig(JSON.parse(authoringTemplate())), /authoring placeholder/);
  });

  it('phase1-plan-files-within-defaults: every file this plan has created is within the declared defaults', () => {
    const created = [
      'agent-workflow-kit/tools/source-size-core.mjs',
      'agent-workflow-kit/tools/source-size-check.mjs',
      'agent-workflow-kit/tools/source-size-check.test.mjs',
    ];
    for (const rel of created) {
      const { lines: count, maxLineBytes } = measureFile(REPO_ROOT, rel);
      assert.ok(count <= SOURCE_SIZE_DEFAULTS.maxLines, `${rel}: ${count} lines exceeds ${SOURCE_SIZE_DEFAULTS.maxLines}`);
      assert.ok(maxLineBytes <= SOURCE_SIZE_DEFAULTS.maxLineBytes, `${rel}: longest line ${maxLineBytes} bytes exceeds ${SOURCE_SIZE_DEFAULTS.maxLineBytes}`);
    }
  });
});

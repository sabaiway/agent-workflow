// layout-check.test.mjs — layout at the check and the writer, through the CLI on git fixtures: entries
// per directory, depth and files per root judged with their bands, a stop exactly where the
// regeneration would raise, the --layout start, the spec store as one more root, the absent config.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { main } from '../source-size-check.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-layout-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const NL = String.fromCharCode(10);
const R = 'recorded by hand';
const WARN = 'source-size: WARNING — ';
const FAIL = 'source-size: FAIL — ';
const STORE_ROOT_STOP = 'at or inside the spec store docs/ai/specs — where layout is judged the store is a root of its own, so declare a root outside it';

const runGit = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const makeLines = (n) => `x${NL}`.repeat(n);
const makeMany = (dir, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/f${i}.txt`, 'x']));
const writeTree = (cwd, files) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
};

// `store` is written AFTER the index is staged, so the spec store stays untracked, as a hidden one is.
const createProject = ({ files = {}, config = null, store = {} } = {}) => {
  const cwd = mkdtempSync(join(TMP, 'p'));
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  runGit(cwd, ['init', '-q', '-b', 'main']);
  writeTree(cwd, files);
  if (config !== null) writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), JSON.stringify(config, null, 2));
  runGit(cwd, ['add', '-A']);
  writeTree(cwd, store);
  return cwd;
};

const configPath = (cwd) => join(cwd, 'docs', 'ai', 'source-size.json');
const readBytes = (cwd) => (existsSync(configPath(cwd)) ? readFileSync(configPath(cwd)) : null);
const readConfig = (cwd) => JSON.parse(readFileSync(configPath(cwd), 'utf8'));
const listDocsAi = (cwd) => readdirSync(join(cwd, 'docs', 'ai')).sort();
const runCli = (cwd, ...args) => main([...args, '--cwd', cwd]);
const showRun = (result) => `${result.stdout}${NL}${result.stderr}`;
const collectWarnings = (result) => result.stdout.split(NL).filter((line) => line.startsWith(WARN)).map((line) => line.slice(WARN.length));
const collectFindings = (result) => {
  const all = result.stdout.split(NL);
  const at = all.findIndex((line) => line.startsWith(FAIL));
  if (at === -1) return [];
  const rest = all.slice(at + 1);
  const end = rest.findIndex((line) => !line.startsWith('  '));
  return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.slice(2)).sort();
};
const collectRaises = (result) => result.stdout.split(NL).filter((line) => line.endsWith(' (raise)')).map((line) => line.trim()).sort();
const assertHas = (result, text) => assert.ok(result.stdout.includes(text), `expected «${text}»:${NL}${showRun(result)}`);

const AUTH = { _README: 'fixture', schema: 2, roots: ['src'], exclude: [], extensions: ['.mjs'] };
const ONE = { 'src/a.mjs': makeLines(1) };
const MINTED = (over = {}) => ({ ...AUTH, baseline: {}, aggregate: { src: { lines: 1, reason: R } }, ...over });
const rootsOf = (counts) => Object.fromEntries(Object.entries(counts).map(([root, files]) => [root, { files, reason: R }]));
const WITH_LAYOUT = (roots, directories = {}, over = {}) => MINTED({ layout: { roots: rootsOf(roots), directories }, ...over });
const dirRecord = (facts) => ({ ...facts, reason: R });
const SIXTH = 'src/a/b/c/d/e/g';
const overEntries = (dir, n) => `${dir}: entries ${n} exceeds the limit 20 beyond its band (up to 22)`;
const overDepth = (dir) => `${dir}: depth 6 exceeds the limit 5 beyond its band (up to 5)`;
const unrecordedRoot = (root, n) => `${root}: judged root carries NO recorded files count (${n} files measured) — the layout record must mirror the judged roots exactly`;
const NOT_JUDGED = (cwd) => `source-size: NOTE — ${configPath(cwd)} records no "layout", so entries per directory, depth and files per root are not judged; --write-baseline --layout --reason "<text>" starts it`;
const ABSENT_NOTE = (cwd) => `source-size: NOTE — ${configPath(cwd)} is absent, so the kit's values judge layout alone and no file is judged on lines or bytes`;

describe('spec:source-size/S27 on a present config a finding stops exactly when the regeneration would raise, and every other finding warns', () => {
  it('a value beyond its band with no record, a record that grew and an unrecorded root each stop, exit 1 — the very raises the regeneration names', () => {
    const cwd = createProject({
      files: { ...ONE, 'src/big.mjs': makeLines(441), ...makeMany('src/wider', 24), 'lib/b.mjs': makeLines(1) },
      config: WITH_LAYOUT({ src: 26 }, { 'src/wider': dirRecord({ entries: 23 }) }, {
        roots: ['src', 'lib'],
        aggregate: { src: { lines: 442, reason: R }, lib: { lines: 1, reason: R } },
      }),
    });
    const check = runCli(cwd, '--check');
    assert.equal(check.code, 1, showRun(check));
    assert.deepEqual(collectFindings(check), [
      unrecordedRoot('lib', 1),
      'src/big.mjs: lines 441 exceeds the declared default 400 beyond its band (up to 440)',
      'src/wider: entries 24 exceeds its recorded 23 — recorded debt is not permission to grow',
    ]);
    const before = readBytes(cwd);
    const write = runCli(cwd, '--write-baseline');
    assert.equal(write.code, 1, showRun(write));
    assert.deepEqual(collectRaises(write), ['lib: files none → 1 (raise)', 'src/big.mjs: lines none → 441 (raise)', 'src/wider: entries 23 → 24 (raise)']);
    assert.deepEqual(readBytes(cwd), before, 'a refused regeneration writes nothing');
  });

  it('within a band, a record above the tree and a record gone each warn on every run, and a run of warnings alone exits 0 with nothing to raise', () => {
    const cwd = createProject({
      files: { ...ONE, 'src/near.mjs': makeLines(440), 'src/c.mjs': makeLines(445), ...makeMany('src/wide', 22), ...makeMany('src/wider', 23) },
      config: WITH_LAYOUT({ src: 46 }, { 'src/wider': dirRecord({ entries: 25 }), 'src/gone': dirRecord({ entries: 30 }) }, {
        baseline: { 'src/c.mjs': { lines: 450, reason: R }, 'src/gone.mjs': { lines: 500, reason: R } },
        aggregate: { src: { lines: 900, reason: R } },
      }),
    });
    const first = runCli(cwd, '--check');
    assert.equal(first.code, 0, showRun(first));
    assert.deepEqual(collectFindings(first), []);
    for (const text of [
      'src/near.mjs: lines 440 is over the limit 400 but within its band (up to 440) — no record is kept; past 440 it stops',
      'src/c.mjs: lines 445 is under the recorded 450 — the regeneration lowers it',
      'src: aggregate lines 886 is under the recorded budget 900 — the regeneration lowers it',
      'src: files 48 is over its recorded 46 but within its band (up to 51) — past 51 it stops',
      'src/wide: entries 22 is over the limit 20 but within its band (up to 22) — past 22 it stops',
      'src/wider: entries 23 is under the recorded 25 — the regeneration lowers it',
      'src/gone: recorded in "layout"."directories" but no directory the run judges — the regeneration removes it',
    ]) assert.ok(collectWarnings(first).includes(text), `expected the warning «${text}»:${NL}${first.stdout}`);
    assert.ok(collectWarnings(first).some((line) => line.startsWith('src/gone.mjs: recorded in "baseline" but no longer in scope')), first.stdout);
    assert.match(first.stdout, /^source-size: PASS with \d+ warning\(s\)/m);
    assert.equal(runCli(cwd, '--check').stdout, first.stdout, 'every warning repeats on the next run');
    const write = runCli(cwd, '--write-baseline');
    assert.equal(write.code, 0, `a warning is never a raise, so the regeneration needs no reason:${NL}${showRun(write)}`);
  });
});

describe('spec:source-size/S32 at the check the layout record ratchets, directories and depth ride their bands, and the hidden store is judged', () => {
  it('20 entries are clean, 22 warn and 23 stop; depth 5 is clean and a sixth level stops', () => {
    const files = { ...ONE, ...makeMany('src/twenty', 20), ...makeMany('src/wide', 22), ...makeMany('src/wider', 23) };
    const cwd = createProject({ files: { ...files, 'src/a/b/c/d/e/f.txt': 'x', [`${SIXTH}/h.txt`]: 'x' }, config: WITH_LAYOUT({ src: 68 }) });
    const result = runCli(cwd, '--check');
    assert.equal(result.code, 1, showRun(result));
    assert.deepEqual(collectFindings(result), [overDepth(SIXTH), overEntries('src/wider', 23)]);
    assert.deepEqual(collectWarnings(result), ['src/wide: entries 22 is over the limit 20 but within its band (up to 22) — past 22 it stops']);
    assert.doesNotMatch(result.stdout, /src\/twenty/);
  });

  it('a layout record that grew stops: entries, depth and a root past its files band', () => {
    const cwd = createProject({
      files: { ...ONE, ...makeMany('src/wider', 24), [`${SIXTH}/i/j.txt`]: 'x' },
      config: WITH_LAYOUT({ src: 20 }, { 'src/wider': dirRecord({ entries: 23 }), [SIXTH]: dirRecord({ depth: 6 }) }),
    });
    const result = runCli(cwd, '--check');
    assert.equal(result.code, 1, showRun(result));
    assert.deepEqual(collectFindings(result), [
      'src/a/b/c/d/e/g: depth 7 exceeds its recorded 6 — recorded debt is not permission to grow',
      'src/wider: entries 24 exceeds its recorded 23 — recorded debt is not permission to grow',
      'src: files 26 exceeds its recorded 20 beyond its band (up to 22)',
    ]);
  });

  it('a record the tree lowered or no longer needs, and one whose directory or root is gone, each warn, exit 0', () => {
    const cwd = createProject({
      files: { ...ONE, ...makeMany('src/wide', 22), ...makeMany('src/wider', 23), [`${SIXTH}/h.txt`]: 'x' },
      config: WITH_LAYOUT({ src: 50, lib: 3 }, {
        'src/wide': dirRecord({ entries: 22 }),
        'src/wider': dirRecord({ entries: 25 }),
        [SIXTH]: dirRecord({ depth: 7 }),
        'src/gone': dirRecord({ entries: 30 }),
      }),
    });
    const result = runCli(cwd, '--check');
    assert.equal(result.code, 0, showRun(result));
    const warnings = collectWarnings(result);
    for (const text of [
      'src: files 47 is under the recorded 50 — the regeneration lowers it',
      'lib: recorded in "layout"."roots" but no longer a judged root — the regeneration removes it',
      'src/wide: entries 22 is within its band (up to 22), so its record is obsolete — the regeneration removes it',
      'src/wider: entries 23 is under the recorded 25 — the regeneration lowers it',
      'src/a/b/c/d/e/g: depth 6 is under the recorded 7 — the regeneration lowers it',
      'src/gone: recorded in "layout"."directories" but no directory the run judges — the regeneration removes it',
    ]) assert.ok(warnings.includes(text), `expected the warning «${text}»:${NL}${result.stdout}`);
    const write = runCli(cwd, '--write-baseline');
    assert.ok(collectWarnings(write).includes('src/wide: entries 22 is over the limit 20 but within its band (up to 22) — past 22 it stops'), showRun(write));
  });

  it('a depth record off its holder never calls a depth beyond the band within it', () => {
    const cwd = createProject({ files: { ...ONE, [`${SIXTH}/h.txt`]: 'x' }, config: WITH_LAYOUT({ src: 2 }, { 'src/a/b/c/d': dirRecord({ depth: 6 }) }) });
    const result = runCli(cwd, '--check');
    assert.ok(collectWarnings(result).includes('src/a/b/c/d: its depth record 6 no longer sits on the shallowest directory beyond the depth band — the regeneration removes it'), result.stdout);
    assert.doesNotMatch(result.stdout, /depth 6 is within its band/);
  });

  it('an unrecorded judged root stops, the spec store walked from disk being one', () => {
    const cwd = createProject({ files: ONE, config: WITH_LAYOUT({}), store: { 'docs/ai/specs/index.md': 'x' } });
    const result = runCli(cwd, '--check');
    assert.equal(result.code, 1, showRun(result));
    assert.deepEqual(collectFindings(result), [unrecordedRoot('docs/ai/specs', 1), unrecordedRoot('src', 1)]);
  });

  it('a hidden spec directory beyond its band is caught though git tracks none of it', () => {
    const cwd = createProject({ files: ONE, config: WITH_LAYOUT({ src: 1, 'docs/ai/specs': 23 }), store: makeMany('docs/ai/specs/kit', 23) });
    const result = runCli(cwd, '--check');
    assert.equal(result.code, 1, showRun(result));
    assert.deepEqual(collectFindings(result), [overEntries('docs/ai/specs/kit', 23)]);
  });

  it('a record exempts only its own dimension: an entries record leaves depth judged, a depth record leaves entries judged', () => {
    const files = { ...ONE, ...makeMany(SIXTH, 23) };
    const entries = createProject({ files, config: WITH_LAYOUT({ src: 24 }, { [SIXTH]: dirRecord({ entries: 23 }) }) });
    const byEntries = runCli(entries, '--check');
    assert.equal(byEntries.code, 1, showRun(byEntries));
    assert.deepEqual(collectFindings(byEntries), [overDepth(SIXTH)]);
    const depth = createProject({ files, config: WITH_LAYOUT({ src: 24 }, { [SIXTH]: dirRecord({ depth: 6 }) }) });
    const byDepth = runCli(depth, '--check');
    assert.equal(byDepth.code, 1, showRun(byDepth));
    assert.deepEqual(collectFindings(byDepth), [overEntries(SIXTH, 23)]);
  });
});

describe('spec:source-size/S33 layout is judged where the config is absent or records it, and --write-baseline --layout is the one way to start it', () => {
  const WIDER = { ...ONE, ...makeMany('src/wider', 23) };

  it('a present config without layout is not judged on layout and every run says so in one line, while a recorded or absent one is', () => {
    const plain = createProject({ files: WIDER, config: MINTED() });
    for (const mode of ['--check', '--write-baseline']) {
      const result = runCli(plain, mode);
      assert.deepEqual(result.stdout.split(NL).filter((line) => line.includes('records no "layout"')), [NOT_JUDGED(plain)], `${mode}:${NL}${showRun(result)}`);
      assert.equal(result.code, 0, showRun(result));
      assert.doesNotMatch(result.stdout, /src\/wider/);
    }
    for (const cwd of [createProject({ files: WIDER, config: WITH_LAYOUT({ src: 24 }) }), createProject({ files: WIDER })]) {
      const result = runCli(cwd, '--check');
      assert.equal(result.code, 1, showRun(result));
      assert.ok(collectFindings(result).includes(overEntries('src/wider', 23)), result.stdout);
      assert.doesNotMatch(result.stdout, /records no "layout"/);
    }
  });

  it('--write-baseline --layout starts the record, its raises taking --reason; a plain --write-baseline then regenerates it', () => {
    const cwd = createProject({ files: WIDER, config: MINTED() });
    const before = readBytes(cwd);
    const refused = runCli(cwd, '--write-baseline', '--layout');
    assert.equal(refused.code, 1, showRun(refused));
    assertHas(refused, `--write-baseline --layout --cwd "${cwd}" --reason`);
    assert.deepEqual(readBytes(cwd), before, 'a refused start writes nothing');
    const started = runCli(cwd, '--write-baseline', '--layout', '--reason', 'layout starts');
    assert.equal(started.code, 0, showRun(started));
    const written = readConfig(cwd);
    assert.deepEqual(Object.keys(written).slice(-3), ['baseline', 'aggregate', 'layout']);
    assert.deepEqual(written.layout, {
      roots: { src: { files: 24, reason: 'layout starts' } },
      directories: { 'src/wider': { entries: 23, reason: 'layout starts' } },
    });
    rmSync(join(cwd, 'src', 'wider', 'f0.txt'));
    runGit(cwd, ['add', '-A']);
    const lowered = runCli(cwd, '--write-baseline');
    assert.equal(lowered.code, 0, `a lower needs no reason:${NL}${showRun(lowered)}`);
    assert.deepEqual(readConfig(cwd).layout, { roots: { src: { files: 23, reason: 'layout starts' } }, directories: {} });
  });

  it('--layout on --check, --adopt or --override is a usage error, exit 2, writing nothing', () => {
    const cwd = createProject({ files: WIDER, config: MINTED() });
    const before = readBytes(cwd);
    for (const args of [['--check'], ['--adopt'], ['--override', 'depth', '--value', '7', '--reason', 'r']]) {
      const result = runCli(cwd, ...args, '--layout');
      assert.ok(result.stderr.includes('--layout belongs to --write-baseline — it starts the layout record'), `${args[0]}:${NL}${showRun(result)}`);
      assert.equal(result.code, 2, args[0]);
      assert.equal(result.stdout, '', args[0]);
      assert.deepEqual(readBytes(cwd), before, `${args[0]} --layout writes nothing`);
    }
  });

  it('--layout on a config that records layout or is absent changes nothing the plain --write-baseline would not', () => {
    const recorded = () => createProject({ files: WIDER, config: WITH_LAYOUT({ src: 20 }, { 'src/wider': dirRecord({ entries: 23 }) }) });
    for (const make of [recorded, () => createProject({ files: WIDER })]) {
      const plain = make();
      const flagged = make();
      const plainRun = runCli(plain, '--write-baseline', '--reason', 'r');
      const flaggedRun = runCli(flagged, '--write-baseline', '--layout', '--reason', 'r');
      assert.equal(flaggedRun.code, plainRun.code, showRun(flaggedRun));
      assert.equal(flaggedRun.code, 0, showRun(flaggedRun));
      assert.deepEqual(readBytes(flagged), readBytes(plain));
      assert.equal(flaggedRun.stdout.replaceAll(flagged, '<cwd>'), plainRun.stdout.replaceAll(plain, '<cwd>'));
    }
  });

  it('a root at or inside the spec store is a config stop with layout, exit 2 naming the store, and keeps its lines judged without', () => {
    const store = { ...AUTH, roots: ['docs/ai/specs'], baseline: {}, aggregate: { 'docs/ai/specs': { lines: 441, reason: R } } };
    const cwd = createProject({ files: { 'docs/ai/specs/a.mjs': makeLines(441) }, config: store });
    const before = readBytes(cwd);
    const started = runCli(cwd, '--write-baseline', '--layout', '--reason', 'r');
    assert.ok(started.stderr.includes(`"roots" declares "docs/ai/specs", ${STORE_ROOT_STOP}`), showRun(started));
    assert.equal(started.code, 2);
    assert.deepEqual(readBytes(cwd), before);
    const inside = createProject({
      files: { 'docs/ai/specs/kit/a.mjs': makeLines(1) },
      config: { ...store, roots: ['docs/ai/specs/kit'], aggregate: { 'docs/ai/specs/kit': { lines: 1, reason: R } }, layout: { roots: {}, directories: {} } },
    });
    const recorded = runCli(inside, '--check');
    assert.ok(recorded.stderr.includes(`"roots" declares "docs/ai/specs/kit", ${STORE_ROOT_STOP}`), showRun(recorded));
    assert.equal(recorded.code, 2);
    const lines = runCli(cwd, '--check');
    assert.equal(lines.code, 1, showRun(lines));
    assert.deepEqual(collectFindings(lines), ['docs/ai/specs/a.mjs: lines 441 exceeds the declared default 400 beyond its band (up to 440)']);
  });
});

describe('spec:source-size/S34 an absent config is judged under the kit values on layout alone, and its first write records schema 2 whole', () => {
  it('--check judges layout over . and the store, says so once, states files-per-root none recorded, and a warning alone exits 0', () => {
    const cwd = createProject({ files: { 'src/big.mjs': makeLines(441), ...makeMany('wide', 22) }, store: { 'docs/ai/specs/index.md': 'x' } });
    const listed = listDocsAi(cwd);
    const result = runCli(cwd, '--check');
    assert.deepEqual(result.stdout.split(NL).filter((line) => line.startsWith('source-size: NOTE')), [ABSENT_NOTE(cwd)], showRun(result));
    assertHas(result, 'source-size: limit files-per-root none recorded, tolerance 10% — from kit');
    assert.equal(result.code, 0, showRun(result));
    assert.deepEqual(collectWarnings(result), ['wide: entries 22 is over the limit 20 but within its band (up to 22) — past 22 it stops']);
    assert.doesNotMatch(result.stdout, /big\.mjs|aggregate|files \d|judged root/);
    assert.equal(existsSync(configPath(cwd)), false, 'a check writes nothing: the config stays absent');
    assert.deepEqual(listDocsAi(cwd), listed);
  });

  it('a directory beyond its entries or depth band is the only stop, exit 1, and the config stays absent', () => {
    const cwd = createProject({
      files: { 'src/big.mjs': makeLines(441), ...makeMany('wider', 23), 'a/b/c/d/e/g/h.txt': 'x' },
      store: makeMany('docs/ai/specs/kit', 23),
    });
    const result = runCli(cwd, '--check');
    assertHas(result, `${FAIL}3 finding(s) under the kit's values (${configPath(cwd)} is absent):`);
    assert.equal(result.code, 1, showRun(result));
    assert.deepEqual(collectFindings(result), [overDepth('a/b/c/d/e/g'), overEntries('docs/ai/specs/kit', 23), overEntries('wider', 23)]);
    assert.equal(existsSync(configPath(cwd)), false);
  });

  it('--write-baseline without --reason refuses its raises and leaves it absent; with one it writes _README, schema 2, baseline, aggregate and layout in one write', () => {
    const cwd = createProject({ files: { 'src/big.mjs': makeLines(441), ...makeMany('wider', 23) }, store: { 'docs/ai/specs/index.md': 'x' } });
    const listed = listDocsAi(cwd);
    const refused = runCli(cwd, '--write-baseline');
    assertHas(refused, 'source-size: REFUSED — this regeneration RAISES');
    assert.equal(refused.code, 1, showRun(refused));
    assert.equal(existsSync(configPath(cwd)), false, 'a refused write leaves the config absent');
    assert.deepEqual(listDocsAi(cwd), listed);
    const written = runCli(cwd, '--write-baseline', '--reason', 'first record');
    assert.equal(written.code, 0, showRun(written));
    const config = readConfig(cwd);
    assert.deepEqual(Object.keys(config), ['_README', 'schema', 'baseline', 'aggregate', 'layout']);
    assert.ok(config._README.includes('Machine keys: baseline, aggregate, layout'), config._README);
    assert.equal(config.schema, 2);
    assert.deepEqual(config.baseline, {});
    assert.deepEqual(config.aggregate, { '.': { lines: 0, reason: 'first record' } });
    assert.deepEqual(config.layout, {
      roots: { '.': { files: 24, reason: 'first record' }, 'docs/ai/specs': { files: 1, reason: 'first record' } },
      directories: { wider: { entries: 23, reason: 'first record' } },
    });
    assert.equal(runCli(cwd, '--check').code, 0, 'the first write leaves a record the check holds');
  });
});

describe('the spec store that is not a directory is refused, never walked through', () => {
  it('a symlinked docs/ai/specs is a scope refusal, exit 1, naming the path, on an absent config and on one recording layout', () => {
    for (const config of [null, WITH_LAYOUT({ src: 1 })]) {
      const cwd = createProject({ files: { ...ONE, 'elsewhere/specs/index.md': 'x' }, config });
      symlinkSync(join(cwd, 'elsewhere', 'specs'), join(cwd, 'docs', 'ai', 'specs'));
      const before = readBytes(cwd);
      const result = runCli(cwd, '--check');
      assert.ok(result.stderr.includes(`${join(cwd, 'docs', 'ai', 'specs')}: the spec store docs/ai/specs could not be walked (present but not a directory)`), showRun(result));
      assert.equal(result.code, 1);
      assert.deepEqual(readBytes(cwd), before, 'a refusal writes nothing');
    }
  });
});

describe('what a declared root counts, and what MINTED means beside the layout record', () => {
  it('an excluded prefix and the tracked spec store are counted by nothing in the declared root, their own names included', () => {
    const config = { _README: 'fixture', schema: 2, roots: ['.'], exclude: ['gen'], extensions: ['.mjs'] };
    const cwd = createProject({ files: { 'src/a.mjs': makeLines(1), ...makeMany('gen', 30), ...makeMany('docs/ai/specs', 25) }, config });
    const written = runCli(cwd, '--write-baseline', '--layout', '--reason', R);
    assert.equal(written.code, 0, showRun(written));
    const { layout } = readConfig(cwd);
    assert.deepEqual(Object.fromEntries(Object.entries(layout.roots).map(([root, { files }]) => [root, files])), { '.': 2, 'docs/ai/specs': 25 });
    assert.deepEqual(layout.directories, { 'docs/ai/specs': { entries: 25, reason: R } }, 'gen (30 entries) is excluded, and docs/ai counts no "specs" entry');
    assert.equal(runCli(cwd, '--check').code, 0);
  });

  it('a directory name that is not valid UTF-8 is counted and never refused, until a record would have to carry it', () => {
    const cwd = createProject({ files: ONE, config: WITH_LAYOUT({ src: 2 }) });
    const odd = Buffer.concat([Buffer.from(`${join(cwd, 'src')}/o`), Buffer.from([0xff])]);
    const fill = (from, to) => { for (let i = from; i < to; i += 1) writeFileSync(Buffer.concat([odd, Buffer.from(`/f${i}.txt`)]), 'x'); runGit(cwd, ['add', '-A']); };
    mkdirSync(odd);
    fill(0, 1);
    assert.equal(runCli(cwd, '--check').code, 0, 'one entry under the name: counted, clean');
    fill(1, 23);
    const result = runCli(cwd, '--check');
    assert.ok(result.stderr.includes('is not valid UTF-8 (bytes 7372632f6fff) and it is beyond its band'), showRun(result));
    assert.equal(result.code, 1);
  });

  it('a layout record without baseline and aggregate is not minted, and baseline and aggregate without layout are', () => {
    const unminted = createProject({ files: ONE, config: { ...AUTH, layout: { roots: rootsOf({ src: 1 }), directories: {} } } });
    const refused = runCli(unminted, '--check');
    assert.equal(refused.code, 1, showRun(refused));
    assertHas(refused, 'is AUTHORED but not yet MINTED');
    const minted = runCli(createProject({ files: ONE, config: MINTED() }), '--check');
    assert.equal(minted.code, 0, showRun(minted));
    assertHas(minted, 'records no "layout"');
  });
});

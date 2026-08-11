// source-size-stop-rendering.test.mjs — every line this practice renders about a project-controlled
// value is ONE line, and the escaping that makes it one is LOSSLESS.
//
// Both halves matter. A path, a root or a config directory is chosen by the project, and a JSON key
// by whoever authored the config: interpolating any of them raw lets its author write lines of their
// own into someone else's output — the checker's report and the plan-time advisor's block alike. And
// an escape that merely REPLACES the offending bytes makes two different names print identically,
// which defeats the one thing the line exists for: naming the file the reader must go fix.
//
// Every expectation here is computed by an INDEPENDENT oracle written from the rule, never by the
// functions under test: an expectation built from the implementation agrees with its bugs.
//
// Covers both entry points, because the two surfaces inherit the same rule from the same leaf.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as checkMain } from './source-size-check.mjs';
import { main as proceduresMain } from './procedures.mjs';
import { SOURCE_SIZE_CONFIG_REL, SOURCE_SIZE_DEFAULTS } from './source-size-core.mjs';

// The boundary's own exports are pulled in DYNAMICALLY: a static import of a name the fix introduces
// makes the whole file unloadable before that fix, and a test that cannot load is not a red test —
// it is no test at all, which is exactly what a red-proof must never accept.
const boundary = () => import('./source-size-core.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-stops-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// fileURLToPath, not URL.pathname: a checkout path carrying a space arrives percent-encoded from
// pathname, and this suite already runs beside fixtures whose directories carry spaces.
const ENGINE_DIR = join(fileURLToPath(new URL('../../', import.meta.url)), 'agent-workflow-engine');
const LF = '\u000a';
const LINE_SEPARATOR = '\u2028';

// Built from CODE POINTS so this file never carries the bytes it is about, and GENERATED rather than
// listed: a hand-picked sample is how a range ends up with a hole in the middle that every test still
// passes over. NUL cannot appear in a filename, so the path fixtures plant every member except it,
// while the config-key and reason fixtures plant it too.
const CH = (code) => String.fromCodePoint(code);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const LINE_UNSAFE_CODES = [...range(0x00, 0x1f), ...range(0x7f, 0x9f), 0x2028, 0x2029];
const IN_A_FILENAME = LINE_UNSAFE_CODES.filter((code) => code !== 0x00);
// The marker answers ONE question line-splitting cannot: did an injected terminator put text at the
// START of a line of its own? It follows every member that could TERMINATE a line — one marker at
// the end would miss a leak of a single early member, whose forged line would then begin with the
// escaped (and therefore line-safe) text of the others. A member that cannot break a line needs no
// marker: it can never start one, and the per-line check below catches it. Marking all 66 would also
// push the fixture past the filesystem's 255-byte name limit, which is a fact, not a preference.
const FORGED = 'FORGED';
const LINE_BREAKERS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);
const plant = (codes) => codes.map((code) => `${CH(code)}${LINE_BREAKERS.has(code) ? FORGED : ''}`).join('');

// ── independent oracles (written from the RULE, not from the implementation) ────────
const isUnsafeCode = (code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
const asEscape = (code) => `\\u${code.toString(16).padStart(4, '0')}`;
// Iterating by CODE UNIT (not by code point) is deliberate: a lone surrogate must be visible to the
// oracle as itself, while a valid pair stays one character and is left alone.
const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const isLoneSurrogate = (codes, i) => {
  const code = codes[i];
  if (code >= 0xd800 && code <= 0xdbff) return !(codes[i + 1] >= 0xdc00 && codes[i + 1] <= 0xdfff);
  if (code >= 0xdc00 && code <= 0xdfff) return !(codes[i - 1] >= 0xd800 && codes[i - 1] <= 0xdbff);
  return false;
};
const oracleUnsafe = (text) => {
  const codes = units(text);
  return codes.some((code, i) => isUnsafeCode(code) || isLoneSurrogate(codes, i));
};
// Prose: the backslash doubles (that is what keeps the mapping injective), every member escapes.
const oracleEscape = (text) => {
  const codes = units(text);
  return codes.map((code, i) => {
    if (code === 0x5c) return '\\\\';
    return isUnsafeCode(code) || isLoneSurrogate(codes, i) ? asEscape(code) : String.fromCharCode(code);
  }).join('');
};
// JSON: stringify first (it escapes C0, the backslash and lone surrogates), then escape the rest.
const oracleJson = (value) => {
  const codes = units(JSON.stringify(value));
  return codes.map((code) => (isUnsafeCode(code) ? asEscape(code) : String.fromCharCode(code))).join('');
};

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};

const lines = (n) => 'x\n'.repeat(n);

const AUTHORED = {
  _README: 'fixture',
  schema: 1,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['src'],
  exclude: [],
  extensions: ['.mjs'],
};

let seq = 0;
// `suffix` names the project DIRECTORY: some rows below need a cwd that is itself hostile — shell-
// unsafe, line-unsafe while quoting perfectly, or both at once.
const project = ({ files = {}, config = AUTHORED } = {}, suffix = '') => {
  const cwd = join(TMP, `p${seq += 1}${suffix}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(cwd, rel), body);
  if (config !== null) {
    writeFileSync(join(cwd, SOURCE_SIZE_CONFIG_REL), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  }
  git(cwd, ['add', '-A']);
  return cwd;
};

const minted = (over = {}) => ({ ...AUTHORED, baseline: {}, aggregate: { src: { lines: 0, reason: 'initial adoption' } }, ...over });
const render = (cwd) => proceduresMain(['plan-execution'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: () => [] });
const declaredPractice = (cwd) =>
  JSON.parse(proceduresMain(['plan-execution', '--json'], { cwd, env: { AGENT_WORKFLOW_ENGINE_DIR: ENGINE_DIR }, detect: () => [] }).stdout).declaredPractice;

describe('source-size — a stop renders as ONE line whatever the project put in it', () => {
  it('config-stop-escapes-unicode-line-separators: U+2028 cannot forge a line the advisor never wrote', () => {
    // U+2028 and U+2029 ARE line terminators to a great many readers of this text; a promise of one
    // loud line that holds only for C0 is not the promise.
    const forged = `evil${LINE_SEPARATOR}Declared source-size practice: caps 9999 lines`;
    const cwd = project({ files: { 'src/a.mjs': lines(3) }, config: JSON.stringify({ ...minted(), [forged]: 1 }) });
    const block = declaredPractice(cwd);
    assert.equal(block.length, 1, `the unreadable state renders exactly one line, got:\n${block.join('\n')}`);
    assert.ok(!block[0].includes(LINE_SEPARATOR), 'the separator itself never survives into the line');
    assert.match(block[0], /\\u2028/, 'it survives as its escape, so the key is still readable');
    assert.equal(render(cwd).code, 0, 'the render still completes');
  });

  it('scope-stop-escapes-a-newline-bearing-path: a thrown exit-1 refusal is one line too', () => {
    const bad = `src/a${LF}b.mjs`;
    const cwd = project({ files: { 'src/ok.mjs': lines(3), [bad]: lines(3) }, config: minted({ aggregate: { src: { lines: 6, reason: 'r' } } }) });
    chmodSync(join(cwd, bad), 0o000);
    const result = checkMain(['--check', '--cwd', cwd]);
    chmodSync(join(cwd, bad), 0o644);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.split('\n').length, 1, `the stop is ONE line, got:\n${result.stderr}`);
    assert.match(result.stderr, /src\/a\\u000ab\.mjs: in-scope but unverifiable/);
  });

  it('report-line-escapes-a-newline-bearing-path: the checker report cannot be forged either', () => {
    const bad = `src/a${LF}source-size: PASS — nothing to see here.mjs`;
    const cwd = project({ files: { [bad]: lines(401) }, config: minted({ aggregate: { src: { lines: 401, reason: 'r' } } }) });
    const result = checkMain(['--check', '--cwd', cwd]);
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.split('\n').some((line) => line.startsWith('source-size: PASS')), `no forged line reaches the report:\n${result.stdout}`);
    assert.match(result.stdout, /src\/a\\u000asource-size: PASS — nothing to see here\.mjs: lines 401/);
  });

  it('escape-round-trips-the-whole-set: both serializers agree with the rule over EVERY member', async () => {
    // Character by character against the oracle, so a serializer that silently DROPS members — which
    // any "no line-unsafe character present" assertion would happily accept — goes red here.
    const { escapeForLine, jsonForLine, isLineUnsafe } = await boundary();
    const planted = `a${LINE_UNSAFE_CODES.map(CH).join('')}b\\c`;
    const prose = escapeForLine(planted);
    assert.equal(prose, oracleEscape(planted), 'prose escaping matches the rule, member for member');
    assert.ok(!isLineUnsafe(prose), 'and carries nothing line-unsafe');
    for (const code of LINE_UNSAFE_CODES) assert.ok(prose.includes(asEscape(code)), `every member survives as its escape (missing ${asEscape(code)})`);
    assert.ok(prose.includes('\\\\'), 'the backslash doubles, which is what keeps the mapping injective');

    const serialized = jsonForLine(planted);
    assert.equal(serialized, oracleJson(planted), 'JSON escaping matches the rule');
    assert.ok(!isLineUnsafe(serialized), 'and carries nothing line-unsafe');
    assert.equal(JSON.parse(serialized), planted, 'and parses back to the exact original');
  });

  it('json-suggestion-round-trips: the pasteable entry is line-safe AND parses back to the exact name', async () => {
    const { isLineUnsafe, jsonForLine } = await boundary();
    // JSON.stringify alone leaves DEL, C1 and the two Unicode separators RAW, so the one surface that
    // must stay pasteable needed its own line-safe serializer. It may only escape what SURVIVES
    // stringification, and the proof that it does is the round trip: the bytes a human copies back
    // must still name the same file.
    const name = `src/a${CH(0x7f)}b${CH(0x85)}c${CH(0x2028)}d${CH(0x2029)}e${CH(0x009f)}f.mjs`;
    const serialized = jsonForLine(name);
    assert.ok(!isLineUnsafe(serialized), `the serialized form carries nothing line-unsafe: ${JSON.stringify(serialized)}`);
    assert.equal(JSON.parse(serialized), name, 'and it parses back to the exact original');
    assert.equal(JSON.parse(jsonForLine('plain/path.mjs')), 'plain/path.mjs', 'an ordinary name is untouched');
    assert.equal(JSON.parse(jsonForLine('a\\u2028b')), 'a\\u2028b', 'a name that literally spells an escape survives too');
  });

  it('line-boundary: NO rendered surface emits a line-unsafe character, whatever the project planted', async () => {
    const { isLineUnsafe } = await boundary();
    // The declaration that makes this a boundary rather than a fourth patch. Every surface is invoked
    // over fixtures planting the whole dangerous set into a tracked path, a declared root, a config
    // key and the project directory itself, and each surface proves FIVE things: the exit code it
    // still returns, that nothing began a line of its own, that no line carries a member of the set,
    // that the FULL expected escaped value — computed by the oracle, not by the code under test —
    // actually reached it, and which command lane it took.
    const plantedName = `planted${plant(IN_A_FILENAME)}`;
    const overCap = `src/${plantedName}.mjs`;
    const emptyRoot = `root${plant([0x2029])}`;
    const roots = ['src', emptyRoot];
    const aggregate = { src: { lines: 401, reason: 'initial adoption' }, [emptyRoot]: { lines: 0, reason: 'initial adoption' } };
    const plantedKey = `k${plant([0x00, 0x2028])}`;

    const withRoots = (over = {}) => ({ ...AUTHORED, roots, ...over });
    const plantedProject = (config, suffix = '') => {
      const cwd = project({ files: { [overCap]: lines(401) }, config }, suffix);
      mkdirSync(join(cwd, emptyRoot), { recursive: true });
      return cwd;
    };

    const minting = plantedProject(withRoots());
    const violating = plantedProject(withRoots({ baseline: {}, aggregate }));
    // Line-unsafe yet shell-SAFE (U+2028 is nothing the shell acts on): the ONLY fixture that reaches
    // the withholding branch through the line ground rather than through double-quote safety.
    const unsafeCwd = plantedProject(withRoots({ baseline: {}, aggregate }), `${LINE_SEPARATOR}dir`);
    const absent = project({ files: { 'src/a.mjs': lines(3) }, config: null }, `${LINE_SEPARATOR}absent`);
    const unreadable = project({ files: { 'src/a.mjs': lines(3) }, config: JSON.stringify({ ...minted(), [plantedKey]: 1 }) });

    const escapedPath = oracleEscape(`src/${plantedName}.mjs`);
    const escapedKey = oracleEscape(plantedKey);
    const jsonPath = oracleJson(`src/${plantedName}.mjs`);
    const absentConfigPath = oracleEscape(join(absent, 'docs', 'ai', 'source-size.json'));

    // `command` is a THREE-state, and every state is ASSERTED — a surface with no command lane must
    // prove the lane is absent, not merely be excused from proving it is present.
    const surfaces = [
      { label: 'authored config, not yet minted', result: checkMain(['--check', '--cwd', minting]), code: 1, expect: ['AUTHORED but not yet MINTED'], command: 'rendered' },
      { label: 'write-baseline refused for a missing reason', result: checkMain(['--write-baseline', '--cwd', minting]), code: 1, expect: [escapedPath], command: 'rendered' },
      { label: 'write-baseline written', result: checkMain(['--write-baseline', '--cwd', minting, '--reason', 'initial adoption']), code: 0, expect: [escapedPath], command: 'none' },
      { label: 'check green over the minted record', result: checkMain(['--check', '--cwd', minting]), code: 0, expect: ['source-size: PASS'], command: 'none' },
      { label: 'check FAIL with the command rendered', result: checkMain(['--check', '--cwd', violating]), code: 1, expect: [escapedPath, jsonPath], command: 'rendered' },
      { label: 'check FAIL on a line-unsafe cwd (withheld)', result: checkMain(['--check', '--cwd', unsafeCwd]), code: 1, expect: [escapedPath, jsonPath], command: 'withheld' },
      { label: 'absent config', result: checkMain(['--check', '--cwd', absent]), code: 1, expect: [absentConfigPath], command: 'none' },
      { label: 'the advisor block over an unreadable declaration', result: render(unreadable), code: 0, expect: [escapedKey], command: 'none' },
      { label: 'the checker over the same declaration', result: checkMain(['--check', '--cwd', unreadable]), code: 2, expect: [escapedKey], command: 'none' },
    ];

    const WITHHELD_LANE = 'Run the regenerator yourself with the working directory set to this project';
    const DIAGNOSES = ['does not survive double-quoting', 'cannot appear in a rendered line'];

    for (const { label, result, code, expect, command } of surfaces) {
      const whole = `${result.stdout}\n${result.stderr}`;
      // Split on EVERY terminator, not just LF: a marker planted after CR, VT, FF, NEL or a Unicode
      // separator only reaches `startsWith` position if the split knows those break lines too — and
      // the regex is built from the test's own code list, never from the production boundary.
      const rendered = whole.split(new RegExp(`[${[...LINE_BREAKERS].map((code) => asEscape(code)).join('')}]`));
      assert.equal(result.code, code, `${label}: exit code moved — the surface may no longer be the one this row judges`);
      assert.deepEqual(rendered.filter((line) => line.startsWith(FORGED)), [], `${label}: planted text began a line of its own — a terminator got through`);
      assert.deepEqual(rendered.filter((line) => isLineUnsafe(line)).map((line) => JSON.stringify(line)), [], `${label}: a rendered line carries a line-unsafe character`);
      for (const value of expect) {
        assert.ok(whole.includes(value), `${label}: the FULL expected value never reached this surface, so it proves nothing:\n  wanted: ${JSON.stringify(value)}\n  got:\n${whole}`);
      }
      // The command lane, asserted for ALL THREE states.
      const hasCommand = /--write-baseline --cwd/.test(whole);
      assert.equal(hasCommand, command === 'rendered', `${label}: expected the command lane to be ${command}`);
      const diagnoses = DIAGNOSES.filter((text) => whole.includes(text));
      if (command === 'withheld') {
        assert.equal(diagnoses.length, 1, `${label}: a withheld command names EXACTLY ONE ground, got ${diagnoses.length}`);
        assert.ok(whole.includes(WITHHELD_LANE), `${label}: a withheld command still owes the manual lane`);
      } else {
        assert.deepEqual(diagnoses, [], `${label}: nothing was withheld, so no withholding ground may be stated`);
        if (command === 'none') assert.ok(!whole.includes(WITHHELD_LANE), `${label}: a surface with no command lane must not print the manual one`);
      }
    }
  });

  it('withheld-reason-names-the-ground-that-fired: the grounds are disjoint, and the stricter one wins', async () => {
    // Two independent grounds withhold the command, and each must say which one fired: telling a
    // reader their path "does not survive double-quoting" when it quotes perfectly, and the real
    // problem is a character that cannot be rendered on a line, sends them to fix the wrong thing.
    // At the INTERSECTION (a newline is both) the line ground wins: a path that cannot be printed at
    // all is not a quoting question, and both grounds lead to the same recovery anyway.
    const config = { ...AUTHORED, baseline: {}, aggregate: { src: { lines: 401, reason: 'r' } } };
    const make = (suffix) => project({ files: { 'src/big.mjs': lines(401) }, config }, suffix);
    const cases = [
      ['shell-unsafe only', make('dq$unsafe'), /does not survive double-quoting/, /cannot appear in a rendered line/],
      ['line-unsafe only', make(`${LINE_SEPARATOR}dir`), /cannot appear in a rendered line/, /does not survive double-quoting/],
      ['BOTH at once (a newline)', make(`${LF}dir`), /cannot appear in a rendered line/, /does not survive double-quoting/],
    ];
    for (const [label, cwd, expected, forbidden] of cases) {
      const result = checkMain(['--check', '--cwd', cwd]);
      assert.equal(result.code, 1, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, expected, label);
      assert.doesNotMatch(result.stdout, forbidden, `${label}: only the ground that fired may be named`);
      assert.match(result.stdout, /Run the regenerator yourself with the working directory set to this project/, `${label}: the recovery lane is the same for both`);
    }
  });

  it('reason-refuses-the-whole-line-unsafe-set: the one value no escaper can rescue is refused instead', () => {
    // A reason is copied VERBATIM into the JSON entry, the commit message and the CHANGELOG, so it
    // cannot be escaped on the way out — the three destinations would each carry different bytes. The
    // boundary holds it at the door instead, and the door must know the whole set.
    const cwd = project({ files: { 'src/big.mjs': lines(401) }, config: { ...AUTHORED } });
    for (const code of LINE_UNSAFE_CODES) {
      const result = checkMain(['--write-baseline', '--cwd', cwd, '--reason', `why${CH(code)}forged`]);
      assert.equal(result.code, 2, `U+${code.toString(16).padStart(4, '0')} must be refused as a reason`);
      assert.match(result.stderr, /must be ONE line/);
    }
  });

  it('every-finding-kind-names-its-own-escaped-target: all nine branches, each with its own hostile name', async () => {
    // Nine branches render nine different sentences about a project-controlled target. Giving each
    // kind its OWN hostile target is what makes the check per-branch: a shared name would let one
    // branch's correct line satisfy the assertion for a branch that dropped its target entirely.
    const { checkReportLines } = await import('./source-size-report.mjs');
    const KINDS = [
      ['over-default', 'rel', { dimension: 'lines', actual: 401, allowed: 400 }],
      ['grew', 'rel', { dimension: 'lines', actual: 402, recorded: 401 }],
      ['stale', 'rel', { dimension: 'lines', actual: 300, recorded: 401 }],
      ['record-obsolete', 'rel', { dimension: 'lines', actual: 10, allowed: 400, recorded: 401 }],
      ['entry-gone', 'rel', { recorded: { lines: 401 } }],
      ['aggregate-grew', 'root', { actual: 10, recorded: 5 }],
      ['aggregate-stale', 'root', { actual: 3, recorded: 5 }],
      ['aggregate-unrecorded', 'root', { actual: 7 }],
      ['aggregate-root-gone', 'root', { recorded: 5 }],
    ];
    const targetFor = (kind) => `${kind}${plant([0x0a, 0x2028])}${CH(0xd800)}`;
    const findings = KINDS.map(([kind, field, extra]) => ({ kind, [field]: targetFor(kind), ...extra }));
    const config = { ...AUTHORED, baseline: {}, aggregate: {} };
    // The pasteable suggestion reads the projection for every rel it names, so the synthetic verdict
    // carries one — a fixture missing it would fail on its own shape rather than on the rule.
    const projected = new Map(KINDS.filter(([, field]) => field === 'rel').map(([kind]) => [targetFor(kind), { lines: 401 }]));
    const verdict = { findings, scope: { files: [], emptyRoots: [] }, projected };

    const lines = checkReportLines({ cwd: join(TMP, 'synthetic'), config, verdict });
    for (const [kind] of KINDS) {
      const expected = oracleEscape(targetFor(kind));
      const own = lines.filter((line) => line.trim().startsWith(`${expected}:`));
      assert.equal(own.length, 1, `${kind}: exactly one line must OPEN with this kind's own escaped target, got ${own.length}:\n${lines.join('\n')}`);
    }
    assert.deepEqual(lines.filter((line) => oracleUnsafe(line)), [], 'and no rendered line carries anything unsafe');
  });

  it('lone-surrogate-cannot-collide-at-the-BYTE-boundary: identity, not line breaking', async () => {
    // A lone surrogate breaks no line — it breaks IDENTITY. Written as UTF-8 it becomes the
    // replacement character, byte for byte identical to a name that really contains one, so two
    // different names would print the same. Asserted as BYTES, because that is where they collide.
    const { escapeForLine, isLineUnsafe } = await boundary();
    const lone = `a${CH(0xd800)}b`;
    const replacement = `a${CH(0xfffd)}b`;
    assert.ok(Buffer.from(lone, 'utf8').equals(Buffer.from(replacement, 'utf8')), 'premise: the two collide as raw UTF-8 bytes');
    const renderedLone = Buffer.from(escapeForLine(lone), 'utf8');
    const renderedReplacement = Buffer.from(escapeForLine(replacement), 'utf8');
    assert.ok(!renderedLone.equals(renderedReplacement), 'rendered, they must differ as BYTES, not merely as JS strings');
    assert.equal(escapeForLine(lone), oracleEscape(lone), 'and the escaping matches the independent oracle');
    assert.ok(isLineUnsafe(lone), 'a lone surrogate is unsafe, so a reason carrying one is refused at the door');
    // A VALID pair is an ordinary character and must survive untouched.
    const pair = 'a😀b';
    assert.equal(escapeForLine(pair), pair, 'a valid surrogate pair is a real character, not a defect');
    assert.ok(!isLineUnsafe(pair), 'and it is perfectly safe');
    const refused = checkMain(['--write-baseline', '--cwd', join(TMP, 'nowhere'), '--reason', `why${CH(0xdc00)}forged`]);
    assert.equal(refused.code, 2, 'a non-well-formed reason cannot land VERBATIM in three files, so it is refused');
  });

  it('escape-is-lossless-no-collision: two DIFFERENT names never render as the same string', () => {
    // The whole point of naming the file is that the reader can go find it. An escape that maps a
    // real newline onto the literal characters a backslash-u-000a already prints as would leave two
    // real, different paths indistinguishable — so the backslash is escaped too.
    const withNewline = `src/a${LF}b.mjs`;
    const withLiteral = 'src/a\\u000ab.mjs';
    const cwd = project({
      files: { [withNewline]: lines(401), [withLiteral]: lines(402) },
      config: minted({ aggregate: { src: { lines: 803, reason: 'r' } } }),
    });
    const result = checkMain(['--check', '--cwd', cwd]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/a\\u000ab\.mjs: lines 401/, 'the real newline renders as its escape');
    assert.match(result.stdout, /src\/a\\\\u000ab\.mjs: lines 402/, 'the literal backslash renders doubled, so the two can never collide');
  });
});

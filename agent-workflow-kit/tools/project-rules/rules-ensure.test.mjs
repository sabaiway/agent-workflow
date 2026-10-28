// The upgrade op rules: its place among the ensures, the kit file's four classes, the survey stops, the
// copy and the merge report, the failed writes, the token per run and the two spawned commands.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENSURE_OPS, ENSURE_TOKENS, FAILURE_CAUSES } from '../ensure-vocabulary.mjs';
import { ENSURE_IMPLEMENTATIONS, main } from '../ensure-configs.mjs';
import { readFileBytesNoFollow } from '../fs-read-nofollow.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { ALARM_WORDS, INTERNAL_NAMES, hits } from '../../../scripts/testing/composed-lines-scan.mjs';
import { EFFECTIVE, KIT, KIT_TEXT, LOCAL, LOCAL_TEXT, MERGED_TEXT, ONE_THEME, RECORD, THEME_NAMES, entryOf, load, makeEngine, makeProject, need, recordText, removeProject, sha, snapshot } from './rules-harness.test.mjs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const THEME = 'project-layout';
const EDITED = `${KIT_TEXT}My own rule.${NL}`;
const NO_FRONTMATTER = [['plain text', `# Project layout${NL}${NL}My own layout.${NL}`], ['a CRLF fence', ['---', 'type: rules', '---', '', '# Project layout', ''].join(`${CR}${NL}`)], ['an unclosed fence', ['---', 'type: rules', '', '# Project layout', ''].join(NL)]];
const PRIOR = ['---', 'type: rules', '---', '', '# Project layout', '', 'The body an earlier release shipped.', ''].join(NL);
const PRIORS = Object.freeze([Object.freeze({ theme: THEME, release: '14.0.0', sha256: sha(PRIOR) })]);
const NOT_JSON = `{ not json${NL}`;
const OTHER = `someone else${NL}`;
const MACHINE_TOKENS = [...new Set([...ENSURE_TOKENS, ...FAILURE_CAUSES])].filter((token) => token.includes('-'));

const roots = [];
const track = (root) => {
  roots.push(root);
  return root;
};
after(() => roots.forEach(removeProject));

const parentOf = (root, rel) => mkdirSync(dirname(join(root, rel)), { recursive: true });
const place = (root, rel, body) => {
  parentOf(root, rel);
  writeFileSync(join(root, rel), body);
};
const dirAt = (rel) => (root) => mkdirSync(join(root, rel), { recursive: true });
const linkAt = (target, rel) => (root) => {
  parentOf(root, rel);
  symlinkSync(join(root, target), join(root, rel));
};
const makeTree = (prefix, files) => {
  const root = track(mkdtempSync(join(tmpdir(), prefix)));
  for (const [rel, body] of Object.entries(files)) place(root, rel, body);
  return root;
};
const makeKit = () => makeTree('rules kit ', { 'references/rules/project-layout.md': KIT_TEXT });

const recordOf = (entry) => recordText({ [THEME]: entry });
const COPY_ENTRY = entryOf({ kit: KIT_TEXT, effective: KIT_TEXT });
const MERGE_ENTRY = entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT });
const copyOf = (text) => ({ [KIT]: text, [EFFECTIVE]: text, [RECORD]: recordOf(entryOf({ kit: text, effective: text })) });
const MERGED = { [KIT]: KIT_TEXT, [LOCAL]: LOCAL_TEXT, [EFFECTIVE]: MERGED_TEXT, [RECORD]: recordOf(MERGE_ENTRY) };
const UNRECORDED = { [LOCAL]: LOCAL_TEXT, [EFFECTIVE]: MERGED_TEXT };
const withPriors = () => ({ priors: PRIORS });

const outcomes = [];
const movedPaths = (before, after) => [...new Set([...before.filter((line) => !after.includes(line)), ...after.filter((line) => !before.includes(line))].map((line) => line.split(TAB)[0]))].sort();
// runEnsure({ files?, prep?, cwd?, kitRoot?, dryRun?, deps? }) → the outcome, its tree, a reader, the moved paths and a no-change assert.
const runEnsure = async ({ files = {}, prep, cwd, kitRoot = makeKit(), dryRun = false, deps = () => ({}) } = {}) => {
  const ensureRules = need(await load('./rules-ensure.mjs'), 'ensureRules');
  const root = cwd ?? makeTree('rules project ', { 'docs/ai/.keep': '', ...files });
  if (prep) prep(root);
  const before = snapshot(root);
  const outcome = ensureRules({ cwd: root, kitRoot, dryRun, deps: { themes: ONE_THEME, ...deps(root) } });
  outcomes.push(outcome);
  const text = (rel) => readFileSync(join(root, rel), 'utf8');
  const changed = () => movedPaths(before, snapshot(root));
  return { ...outcome, root, kitRoot, text, changed, unchanged: () => assert.deepEqual(snapshot(root), before) };
};
const isAbsent = (run, rel) => assert.equal(existsSync(join(run.root, rel)), false, rel);
const assertFailed = (run, first) => {
  assert.equal(run.lines[0], first);
  assert.equal(run.failed, true);
  assert.equal(run.token, 'failed');
};

const KIT_EQUAL = `${KIT}: already the bundled template — nothing written`;
const REPLACED = `${KIT}: differs from every body this kit knows it shipped — replaced by the bundled template; a rule meant to last goes in ${LOCAL}, where it wins`;
const WOULD_REPLACE = `${KIT}: differs from every body this kit knows it shipped — would be replaced by the bundled template; a rule meant to last goes in ${LOCAL}, where it wins`;
const NEVER_SAID = ['carries your edit', 'your edit', 'kept byte for byte', 'preserved', 'withheld', 'kept aside', "the user's yes"];
const EFFECTIVE_EQUAL = `${EFFECTIVE}: already the copy of ${KIT} — nothing written`;
const RECORD_CURRENT = `${RECORD}: already records what ${EFFECTIVE} was built from — nothing written`;
const REBUILT = `${EFFECTIVE}: rebuilt from ${KIT}`;
const DROPPED = `${EFFECTIVE}: rebuilt as a copy of ${KIT}, dropping an edit made to it; edits belong in ${LOCAL}`;

const ENSURE_CLI = fileURLToPath(new URL('../ensure-configs.mjs', import.meta.url));
const fold = (text) => text.replace(/\s+/g, ' ').trim();
const headerRow = () => {
  const lines = readFileSync(ENSURE_CLI, 'utf8').split(NL);
  const start = lines.findIndex((line) => line.startsWith('//   rules '));
  const end = lines.findIndex((line, index) => index > start && /^\/\/ {3}\S/.test(line));
  return fold(lines.slice(start, end).map((line) => line.slice(lines[start].search(/(?<=<theme>\.md +)\S/))).join(' '));
};
const helpClause = () => fold(main(['--help']).stdout).match(/project rules kit file[^;]*/)?.[0] ?? '';

describe('spec:project-rules/S16 rules sits in ENSURE_OPS after specs and before index, the ensure command runs it through the project-rules index, and the header row and the --help clause say any other body is replaced with no question and no copy kept', () => {
  it('nine ops with rules between specs and index, and the op table holds the index ensureRules', async () => {
    assert.equal(ENSURE_OPS.length, 9);
    assert.deepEqual(ENSURE_OPS.slice(6), ['specs', 'rules', 'index']);
    assert.equal(ENSURE_IMPLEMENTATIONS.rules, need(await load('./index.mjs'), 'ensureRules'));
  });
  it('the header row of the op and the --help clause naming the project rules kit file say any other body is replaced with no question and no copy kept, never that an edited one is kept', () => {
    for (const text of [headerRow(), helpClause()]) {
      assert.match(text, /any other (?:kit-file )?body[^;]*replaced/, text);
      assert.ok(text.includes('no question and no copy kept'), text);
      assert.doesNotMatch(text, /edited one is kept|carries your edit|preserved/, text);
    }
  });
});

const KIT_CLASSES = [
  ['absent: seeded with the template bytes', {}, `${KIT}: created from the bundled template`, 'seeded', KIT_TEXT],
  ['equal to the template: kept, nothing written', { files: copyOf(KIT_TEXT) }, KIT_EQUAL, 'already-current', KIT_TEXT],
  ['a prior of the injected catalog: refreshed to the template', { files: copyOf(PRIOR), deps: withPriors }, `${KIT}: held the body an earlier release shipped — refreshed to the bundled template`, 'refreshed', KIT_TEXT],
  ['a prior body outside the given catalog: replaced by the template', { files: copyOf(PRIOR) }, REPLACED, 'refreshed', KIT_TEXT],
  ['an edit on a converged tree: replaced by the template', { files: copyOf(EDITED) }, REPLACED, 'refreshed', KIT_TEXT],
  ['a body with no frontmatter: replaced by the template', { files: { [KIT]: NO_FRONTMATTER[0][1] } }, REPLACED, 'refreshed', KIT_TEXT],
  ['a dry run over an edit: the bytes left, the would be replaced line', { files: copyOf(EDITED), dryRun: true }, WOULD_REPLACE, 'would-refresh', EDITED],
];

describe('spec:project-rules/S17 the kit file absent is seeded, equal is kept, a prior of an injected catalog is refreshed, and other bytes end as the template, token refreshed, with no copy and no line about an edit kept', () => {
  for (const [label, opts, line, token, kitAfter] of KIT_CLASSES) {
    it(label, async () => {
      const run = await runEnsure(opts);
      assert.deepEqual(NEVER_SAID.filter((said) => run.lines.some((one) => one.toLowerCase().includes(said))), [], run.lines.join(NL));
      assert.equal(run.lines[0], line);
      assert.equal(run.token, token);
      assert.equal(run.text(KIT), kitAfter);
      if (token === 'already-current' || opts.dryRun) run.unchanged();
    });
  }
  it('replacing an edited kit file on a converged tree with no local file changes only the kit, effective and record files', async () => {
    const run = await runEnsure({ files: copyOf(EDITED) });
    assert.deepEqual(run.lines, [REPLACED, REBUILT, `${RECORD}: records what ${EFFECTIVE} was built from`]);
    assert.deepEqual(run.changed(), [KIT, EFFECTIVE, RECORD].sort());
  });
});

const wrongKind = (rel, reason) => `wrong-node-kind — ${rel}: ${reason} — nothing was read or written; resolve it by hand, then re-run`;
const DIR = 'it is a directory, not a regular file';
const FOREIGN = [
  ['the kit path is a directory', {}, dirAt(KIT), wrongKind(KIT, DIR)],
  ['the local path is a symlink leaf', { [KIT]: KIT_TEXT, 'elsewhere.md': LOCAL_TEXT }, linkAt('elsewhere.md', LOCAL), wrongKind(LOCAL, 'it is a symlink, not a regular file')],
  ['the effective path is a directory', { [KIT]: KIT_TEXT }, dirAt(EFFECTIVE), wrongKind(EFFECTIVE, DIR)],
  ['the record path is a directory', { [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT }, dirAt(RECORD), wrongKind(RECORD, DIR)],
  ['docs/ai/rules is a symlink', { 'real-rules/project-layout.md': KIT_TEXT }, linkAt('real-rules', 'docs/ai/rules'), wrongKind(KIT, 'docs/ai/rules is a symlink or not a directory')],
  ['docs/ai/rules/effective is a symlink', { [KIT]: KIT_TEXT, 'real-effective/project-layout.md': KIT_TEXT }, linkAt('real-effective', 'docs/ai/rules/effective'), wrongKind(EFFECTIVE, 'docs/ai/rules/effective is a symlink or not a directory')],
];

describe('spec:project-rules/S18 an unreadable template, a foreign read on a path and an error read each fail with their cause, writing nothing', () => {
  it('template-unreadable: a kit root without the template', async () => {
    const run = await runEnsure({ kitRoot: makeTree('rules empty kit ', {}) });
    assert.ok(run.lines[0].startsWith(`template-unreadable — ${KIT}: the bundled template references/rules/project-layout.md could not be read, so nothing was written — reinstall the kit. `), run.lines[0]);
    assert.match(run.lines[0], /ENOENT/);
    assert.equal(run.failed, true);
    run.unchanged();
  });
  for (const [label, files, prep, first] of FOREIGN) {
    it(`wrong-node-kind: ${label}`, async () => {
      const run = await runEnsure({ files, prep });
      assertFailed(run, first);
      run.unchanged();
    });
  }
  it('unexpected-error: a read that answers error', async () => {
    const run = await runEnsure({ files: copyOf(KIT_TEXT), deps: () => ({ read: () => ({ outcome: 'error', code: 'EIO' }) }) });
    assertFailed(run, `unexpected-error — ${KIT}: could not be read (EIO) — nothing was written`);
    run.unchanged();
  });
});

const REBUILDS = [
  ['absent: created as the copy, the entry written with the local absent', { [KIT]: KIT_TEXT }, {}, `${EFFECTIVE}: created as a copy of ${KIT}`],
  ['a readable entry and an edited effective file: the dropped edit', { ...copyOf(KIT_TEXT), [EFFECTIVE]: EDITED }, {}, DROPPED],
  ['no record and a differing effective file: rebuilt from the kit file', { [KIT]: KIT_TEXT, [EFFECTIVE]: EDITED }, {}, REBUILT],
  ['an unreadable record and a differing effective file: rebuilt from the kit file', { [KIT]: KIT_TEXT, [EFFECTIVE]: EDITED, [RECORD]: NOT_JSON }, {}, REBUILT],
  ['a kit file refreshed from a prior, the entry matching the old effective: rebuilt from the kit file', copyOf(PRIOR), { deps: withPriors }, REBUILT],
  ['an unreadable record beside an equal effective file: replaced, its line naming the reason', { ...copyOf(KIT_TEXT), [RECORD]: NOT_JSON }, {}, EFFECTIVE_EQUAL],
  ...NO_FRONTMATTER.map(([kind, body]) => [`a kit file with no frontmatter (${kind}): replaced, its copy created and its entry written`, { [KIT]: body }, {}, `${EFFECTIVE}: created as a copy of ${KIT}`]),
];

describe('spec:project-rules/S19 with no local file the effective file becomes the kit file copy and its entry is recorded, a kit file with no frontmatter replaced rather than skipped', () => {
  for (const [label, files, opts, line] of REBUILDS) {
    it(label, async () => {
      const run = await runEnsure({ files, ...opts });
      assert.deepEqual(run.lines.slice(1), [line, `${RECORD}: ${files[RECORD] === NOT_JSON ? 'was unreadable (not JSON) — replaced by a record of what' : 'records what'} ${EFFECTIVE} was built from`]);
      assert.equal(run.text(KIT), KIT_TEXT);
      assert.equal(run.text(EFFECTIVE), KIT_TEXT);
      assert.equal(run.text(RECORD), recordOf(COPY_ENTRY));
    });
  }
  it('equal bytes and a matching entry: nothing written', async () => {
    const run = await runEnsure({ files: copyOf(KIT_TEXT) });
    assert.deepEqual([run.lines, run.token], [[KIT_EQUAL, EFFECTIVE_EQUAL, RECORD_CURRENT], 'already-current']);
    run.unchanged();
  });
});

const HOLDS = ` — this command holds once the real run has written ${KIT}`;
const mergeLine = (run, kitText, tail) => `merge needed — merge ${KIT} and ${LOCAL} into ${EFFECTIVE}: by meaning, the local file wins a conflict, each rule appears once, only the final meaning is written, with no mark of where a rule came from, the frontmatter is kept, and the user is shown what changed; then record it: node ${shellQuoteArg(join(run.kitRoot, 'tools', 'project-rules', 'rules-cli.mjs'))} --record --theme ${THEME} --kit ${sha(kitText)} --local ${sha(LOCAL_TEXT)} --effective <the sha256 of the merged file> --cwd ${shellQuoteArg(run.root)}${tail}`;
const withEntry = (change) => ({ ...MERGED, [RECORD]: recordOf({ ...MERGE_ENTRY, ...change }) });
const EDITED_UNDER_ITS_DIGEST = { ...withEntry({ kit: sha(EDITED) }), [KIT]: EDITED };
const RECORDED_MERGE = `${EFFECTIVE}: already the recorded merge of ${KIT} and ${LOCAL} — nothing written`;
const PENDING = [
  ['no record', { [KIT]: KIT_TEXT, ...UNRECORDED }, {}, KIT_TEXT, ''],
  ['an unreadable record', { ...MERGED, [RECORD]: NOT_JSON }, {}, KIT_TEXT, ''],
  ['an entry with a moved kit digest', withEntry({ kit: sha('another kit') }), {}, KIT_TEXT, ''],
  ['an entry with a moved local digest', withEntry({ local: sha('another local') }), {}, KIT_TEXT, ''],
  ['an entry with a moved effective digest', withEntry({ effective: sha('another effective') }), {}, KIT_TEXT, ''],
  ['the effective file absent under a matching entry', { [KIT]: KIT_TEXT, [LOCAL]: LOCAL_TEXT, [RECORD]: recordOf(MERGE_ENTRY) }, {}, KIT_TEXT, ''],
  ['an edited kit file under an entry recording the edited digest: the template digest', EDITED_UNDER_ITS_DIGEST, {}, KIT_TEXT, ''],
  ['a dry run that would replace an edited kit file: the template digest and the holds tail', EDITED_UNDER_ITS_DIGEST, { dryRun: true }, KIT_TEXT, HOLDS],
  ['the kit file absent, seeded this run: the template digest', UNRECORDED, {}, KIT_TEXT, ''],
  ['a dry run that would seed the kit file: the template digest and the holds tail', UNRECORDED, { dryRun: true }, KIT_TEXT, HOLDS],
  ['a prior kit file refreshed this run: the template digest', { [KIT]: PRIOR, ...UNRECORDED }, { deps: withPriors }, KIT_TEXT, ''],
  ['a dry run that would refresh the kit file: the template digest and the holds tail', { [KIT]: PRIOR, ...UNRECORDED }, { dryRun: true, deps: withPriors }, KIT_TEXT, HOLDS],
];

describe('spec:project-rules/S20 with a local file a recorded merge, judged against the kit file as the run leaves it, writes no more than the kit file, and every other state is pending with one merge-needed line and the exact record command', () => {
  for (const [label, files, first, token, moved] of [
    ['a matching entry and a present effective file: nothing written', MERGED, KIT_EQUAL, 'already-current', []],
    ['an edited kit file under an entry recording the template digest is the recorded merge: only the kit file written, token refreshed', { ...MERGED, [KIT]: EDITED }, REPLACED, 'refreshed', [KIT]],
  ]) {
    it(label, async () => {
      const run = await runEnsure({ files });
      assert.deepEqual([run.lines, run.token, run.text(KIT), run.changed()], [[first, RECORDED_MERGE], token, KIT_TEXT, moved]);
    });
  }
  for (const [label, files, opts, kitText, tail] of PENDING) {
    it(`pending: ${label}`, async () => {
      const run = await runEnsure({ files, ...opts });
      assert.equal(run.token, 'pending');
      assert.deepEqual(run.lines.filter((line) => line.startsWith('merge needed — ')), [mergeLine(run, kitText, tail)]);
      assert.equal(run.lines.length, 2);
      assert.ok(shellQuoteArg(run.root).startsWith("'") && shellQuoteArg(run.kitRoot).startsWith("'"));
      if (opts.dryRun) run.unchanged();
      else assert.ok(run.text(KIT) === KIT_TEXT && run.changed().every((path) => path === KIT), run.changed().join(', '));
      assert.equal(run.lines.some((line) => line.includes('/agent-workflow-kit rules')), false);
    });
  }
});

const throwOn = (part) => () => ({ writeFile: (path, ...rest) => (path.includes(part) ? assert.fail('disk full') : writeFileSync(path, ...rest)) });
const loseSeed = (rel) => (root) => ({ link: (from, to) => { if (to === join(root, rel)) writeFileSync(to, OTHER); return linkSync(from, to); } });
const moveKitDuringEffective = (root) => ({ writeFile: (path, ...rest) => { writeFileSync(path, ...rest); if (path.includes('effective/project-layout.md')) writeFileSync(join(root, KIT), OTHER); } });
const moveKitOnSecondRead = (root) => {
  const kitReads = [];
  return { read: (path) => (path === join(root, KIT) && kitReads.push(path) === 2 ? { outcome: 'ok', bytes: Buffer.from(OTHER) } : readFileBytesNoFollow(path)) };
};
const VOUCH = `race-unresolved — ${RECORD}: the record could not vouch for the files (kit-moved: `;
const VOUCH_TAIL = '), so they changed underneath this run; nothing further written, re-run when the tree is settled — ';
const RACE = 'appeared while this run was creating it and does not hold the bytes this run carried — something is writing there underneath this run; nothing further written, re-run when the tree is settled';
const NOTHING = 'nothing was written before it';
const landed = (...paths) => `already written by this run and not rolled back: ${paths.join(', ')}`;
const assertVouch = (run, note) => {
  assert.ok(run.lines[0].startsWith(VOUCH) && run.lines[0].endsWith(`${VOUCH_TAIL}${note}`), run.lines[0]);
  assert.equal(run.token, 'failed');
  isAbsent(run, RECORD);
};

describe('spec:project-rules/S21 a refused write and a record refusal fail write-refused or race-unresolved, naming the files already written, and a seed that lost its race fails race-unresolved', () => {
  it('write-refused: the door throws on the effective write after the kit seed', async () => {
    const run = await runEnsure({ deps: throwOn('effective') });
    assertFailed(run, `write-refused — ${EFFECTIVE}: disk full — ${landed(KIT)}`);
    assert.equal(run.text(KIT), KIT_TEXT);
    isAbsent(run, EFFECTIVE);
  });
  it('write-refused: the record writer refuses with its condition write', async () => {
    const run = await runEnsure({ deps: () => ({ write: () => assert.fail('disk full') }) });
    assertFailed(run, `write-refused — ${RECORD}: disk full — ${landed(KIT, EFFECTIVE)}`);
    isAbsent(run, RECORD);
  });
  it('race-unresolved: the kit file moved during the effective write, after both seeds', async () => {
    assertVouch(await runEnsure({ deps: moveKitDuringEffective }), landed(KIT, EFFECTIVE));
  });
  it('race-unresolved: the record writer reads other kit bytes, nothing written before it', async () => {
    const run = await runEnsure({ files: { [KIT]: KIT_TEXT, [EFFECTIVE]: KIT_TEXT }, deps: moveKitOnSecondRead });
    assertVouch(run, NOTHING);
    run.unchanged();
  });
  it('race-unresolved: a kit seed that met other bytes', async () => {
    const run = await runEnsure({ deps: loseSeed(KIT) });
    assertFailed(run, `race-unresolved — ${KIT}: ${RACE} — ${NOTHING}`);
    assert.equal(run.text(KIT), OTHER);
    isAbsent(run, EFFECTIVE);
  });
  it('race-unresolved: an effective seed that met other bytes', async () => {
    const run = await runEnsure({ files: { [KIT]: KIT_TEXT }, deps: loseSeed(EFFECTIVE) });
    assertFailed(run, `race-unresolved — ${EFFECTIVE}: ${RACE} — ${NOTHING}`);
    assert.equal(run.text(EFFECTIVE), OTHER);
    isAbsent(run, RECORD);
  });
});

const TOKENS = [
  ['pending outranks a kit seed', { files: { [LOCAL]: LOCAL_TEXT } }, 'pending'],
  ['seeded', {}, 'seeded'],
  ['refreshed', { files: copyOf(PRIOR), deps: withPriors }, 'refreshed'],
  ['regenerated for an effective and record write', { files: { [KIT]: KIT_TEXT } }, 'regenerated'],
  ['regenerated for a record write only', { files: { ...copyOf(KIT_TEXT), [RECORD]: recordText({}) } }, 'regenerated'],
  ['refreshed on a converged edited kit file', { files: copyOf(EDITED) }, 'refreshed'],
  ['refreshed outranks regenerated when an edited kit file is replaced beside an absent copy', { files: { [KIT]: EDITED } }, 'refreshed'],
  ['a dry run over a converged edited kit file answers would-refresh, nothing written', { files: copyOf(EDITED), dryRun: true }, 'would-refresh'],
  ['already-current', { files: copyOf(KIT_TEXT) }, 'already-current'],
  ['a dry run answers would-seed, nothing written', { dryRun: true }, 'would-seed'],
  ['a dry run answers would-refresh, nothing written', { files: copyOf(PRIOR), deps: withPriors, dryRun: true }, 'would-refresh'],
  ['a dry run answers would-regenerate, nothing written', { files: { [KIT]: KIT_TEXT }, dryRun: true }, 'would-regenerate'],
];
const alarmsIn = (line) => ALARM_WORDS.filter((word) => line.toLowerCase().split(/[^a-z]+/).includes(word.toLowerCase()));

describe('spec:project-rules/S22 one token per run by the precedence, an edited kit file refreshed and no run customized-preserved, a dry run writing nothing with the would- counterpart, a second converged run writing nothing, and every composed line user-grade', () => {
  for (const [label, opts, token] of TOKENS) {
    it(`token: ${label}`, async () => {
      const run = await runEnsure(opts);
      assert.equal(run.token, token);
      assert.equal(run.failed, false);
      if (opts.dryRun) run.unchanged();
    });
  }
  it('a dry run on a bare tree says what a run would write', async () => {
    assert.deepEqual((await runEnsure({ dryRun: true })).lines, [
      `${KIT}: absent — would be created from the bundled template`,
      `${EFFECTIVE}: absent — would be created as a copy of ${KIT}`,
      `${RECORD}: would record what ${EFFECTIVE} is built from`,
    ]);
  });
  it('a second run over a converged tree writes nothing', async () => {
    const second = await runEnsure({ cwd: (await runEnsure()).root });
    assert.equal(second.token, 'already-current');
    second.unchanged();
  });
  it('every composed line of the cells above passes the composed-lines scanner', async () => {
    need(await load('./rules-ensure.mjs'), 'ensureRules');
    assert.ok(outcomes.length > 50, `${outcomes.length} outcomes collected`);
    assert.equal(outcomes.filter(({ token }) => token === 'customized-preserved').length, 0, 'no run answers customized-preserved');
    for (const { failed, lines } of outcomes) {
      for (const [index, raw] of lines.entries()) {
        const cause = raw.split(' — ')[0];
        if (failed && index === 0) assert.ok(FAILURE_CAUSES.includes(cause), raw);
        const line = failed && index === 0 ? raw.slice(cause.length + ' — '.length) : raw;
        assert.deepEqual(hits(line, MACHINE_TOKENS), [], raw);
        assert.deepEqual(hits(line, INTERNAL_NAMES), [], raw);
        if (!failed) assert.deepEqual(alarmsIn(line), [], raw);
      }
    }
  });
});

const RULES_CLI = fileURLToPath(new URL('./rules-cli.mjs', import.meta.url));
const spawnNode = (env, ...args) => spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ...env } });

describe('spec:project-rules/S23 the ensure command spawned on a fixture deployment with an engine fixture lays every theme, and --check spawned after it answers current for every theme with exit 0', () => {
  it('ensure-configs --only rules seeds, then rules-cli --check is current for every theme', () => {
    const root = track(makeProject());
    const engine = makeEngine();
    [engine.dir, engine.home].forEach(track);
    const env = { ...engine.env, HOME: engine.home };
    const laid = spawnNode(env, ENSURE_CLI, '--reconcile', '--only', 'rules', '--cwd', root);
    assert.equal(laid.status, 0, `${laid.stdout}${laid.stderr}`);
    assert.ok(laid.stdout.split(NL).includes('  rules: seeded'), laid.stdout);
    const checked = spawnNode(env, RULES_CLI, '--check', '--cwd', root);
    assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
    assert.deepEqual(checked.stdout.split(NL).filter(Boolean), THEME_NAMES.map((name) => `${name}: current`));
  });
});

const BOOTSTRAP = fileURLToPath(new URL('../../references/modes/bootstrap.md', import.meta.url));
const RULES_RUN = 'node ${CLAUDE_SKILL_DIR}/tools/ensure-configs.mjs --reconcile --only rules --cwd <project>';
const stepOf = (lines, n) => {
  const start = lines.findIndex((line) => line.startsWith(`${n}. **`));
  const end = lines.findIndex((line, index) => index > start && /^[0-9]+[.] [*][*]/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join(NL);
};

describe('spec:project-rules/S25 bootstrap.md step 10 carries the --only rules run, stated for both paths, before its navigator re-run, and step 7 does not', () => {
  it('step 10 runs the rules op in both paths before the navigator re-run; step 7 has no rules run', () => {
    const lines = readFileSync(BOOTSTRAP, 'utf8').split(NL);
    const [step10, step7] = [stepOf(lines, 10), stepOf(lines, 7)];
    assert.ok(step10.includes(RULES_RUN), step10);
    assert.ok(step10.startsWith('10. **Stamp the deployment lineage.**'), step10);
    assert.ok(step10.includes('In both paths, delegated and fallback'), step10);
    const rerun = step10.indexOf('re-run the step-7 navigator finalizer');
    assert.ok(rerun !== -1 && step10.indexOf(RULES_RUN) < rerun, step10);
    assert.ok(step7.startsWith('7. **Fill templates**'), step7);
    assert.equal(step7.includes('--only rules'), false);
  });
});

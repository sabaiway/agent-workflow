import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRUST_CHAIN_DISCLOSURE } from './gates-init.mjs';
import { failAt, makeProject, runVerb } from './checker-gates.test/harness.test.mjs';

const loaded = await import('./checker-gates.mjs').catch(() => ({}));
const reader = await import('./checker-gates-read.mjs').catch(() => ({}));
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, '..');
const TOOL = join(HERE, 'checker-gates.mjs');
const GATES = 'docs/ai/gates.json';
const IDS = ['control-bytes', 'plan-shape', 'spec-check', 'spec-coverage'];
const PROBED = { git: { kind: 'directory' }, storeRoot: '# Specs\n', scope: '{}\n', gates: [] };
const CANDIDATE_LINE_RE = /^(control-bytes|plan-shape|spec-check|spec-coverage): (offered|declared|id-taken|not-applicable|probe-unreadable|withheld|applied)(?: — .+)?$/;
const PLACEHOLDER_RE = /<kit>|<project>|undefined|null|\[object |\$\{/;
const lines = () => {
  assert.ok(loaded.OUTCOME_LINES, 'checker-gates.mjs OUTCOME_LINES is absent');
  return loaded.OUTCOME_LINES;
};
const bytesOf = (root) => readFileSync(join(root, GATES));
const idsOf = (root) => JSON.parse(bytesOf(root)).gates.map(({ id }) => id);
// The entry line the one derivation composes for an offered candidate, read back from the read leaf.
const entryOf = (root, id) => {
  const judge = reader.judgeCheckerGates ?? (() => { throw new Error('checker-gates-read.mjs judgeCheckerGates is absent'); });
  return `  entry: ${judge(root, {}).candidates.find((candidate) => candidate.id === id).entry}`;
};
const offeredLines = (root, id) => [`${id}: offered`, entryOf(root, id)];
const THROWING = Object.fromEntries(['lstatSync', 'lstat', 'open', 'readFileSync'].map((name) => [name, () => {
  throw new Error(`a usage run called ${name}`);
}]));

describe('spec:checker-gates/S2 the preview is the default and writes zero bytes', () => {
  it('prints the disclosure once, then one line per candidate in table order, each offered one followed by its entry line', async () => {
    const { root } = makeProject(PROBED);
    const before = bytesOf(root);
    const run = await runVerb(root);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.deepEqual(run.lines, [TRUST_CHAIN_DISCLOSURE, ...IDS.flatMap((id) => offeredLines(root, id))]);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(bytesOf(root), before);
  });

  it('prints no disclosure when no candidate is offered', async () => {
    const { root } = makeProject({ gates: [] });
    assert.equal((await runVerb(root, ['--apply'])).code, 0);
    const run = await runVerb(root);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.lines.map((line) => line.split(':')[0]), IDS);
    assert.equal(run.lines[1], 'plan-shape: declared');
    assert.ok(!run.lines.includes(TRUST_CHAIN_DISCLOSURE));
  });

  it('prints the disclosure once when an --apply run applies, offered or not', async () => {
    const { root } = makeProject(PROBED);
    const run = await runVerb(root, ['--apply', '--only', 'plan-shape']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.lines, [TRUST_CHAIN_DISCLOSURE, ...offeredLines(root, 'control-bytes'), 'plan-shape: applied',
      ...offeredLines(root, 'spec-check'), ...offeredLines(root, 'spec-coverage')]);
    const { root: whole } = makeProject(PROBED);
    const applied = await runVerb(whole, ['--apply']);
    assert.deepEqual(applied.lines, [TRUST_CHAIN_DISCLOSURE, ...IDS.map((id) => `${id}: applied`)]);
  });

  it('carries exactly one closed state word on every candidate line', async () => {
    const { root } = makeProject({ git: { kind: 'symlink' }, scope: '{}\n', gates: [{ id: 'spec-check', title: 't', cmd: 'echo x' }] });
    const run = await runVerb(root);
    const candidates = run.lines.filter((line) => !line.startsWith('  entry: ') && line !== TRUST_CHAIN_DISCLOSURE);
    assert.equal(candidates.length, IDS.length);
    for (const line of candidates) assert.match(line, CANDIDATE_LINE_RE);
  });
});

describe('spec:checker-gates/S8 --only accumulates and names offered candidates only', () => {
  it('writes two distinct offered ids and only them, the others keeping their offered and entry lines', async () => {
    const { root } = makeProject(PROBED);
    const run = await runVerb(root, ['--apply', '--only', 'spec-check', '--only', 'control-bytes']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(idsOf(root), ['control-bytes', 'spec-check']);
    assert.deepEqual(run.lines, [TRUST_CHAIN_DISCLOSURE, 'control-bytes: applied', ...offeredLines(root, 'plan-shape'),
      'spec-check: applied', ...offeredLines(root, 'spec-coverage')]);
  });

  it('selects an id given twice once', async () => {
    const { root } = makeProject(PROBED);
    const run = await runVerb(root, ['--apply', '--only', 'plan-shape', '--only', 'plan-shape']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(idsOf(root), ['plan-shape']);
    assert.equal(run.writes.filter(([name]) => name === 'writeFile').length, 1);
  });

  for (const args of [
    ['--only', 'control-bytes'], ['--apply', '--only', 'control-bytes'],
    ['--only', 'nope'], ['--apply', '--only', 'plan-shape', '--only', 'nope'],
  ]) {
    it(`refuses ${args.join(' ')} as usage when the id is not offered this run, nothing written`, async () => {
      const { root } = makeProject({ ...PROBED, git: undefined });
      const before = bytesOf(root);
      const run = await runVerb(root, args);
      assert.equal(run.code, 2, run.stdout);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^usage: /);
      assert.match(run.stderr, new RegExp(`\\b${args.at(-1)}\\b`));
      assert.match(run.stderr, /\bplan-shape\b/, 'the usage names the offered ids');
      assert.deepEqual(run.writes, []);
      assert.deepEqual(bytesOf(root), before);
    });
  }
});

describe('spec:checker-gates/S11 usage is judged before any read, and main never exits', () => {
  for (const argv of [
    ['--cwd', '/project', '--bogus'], ['--cwd', '/project', '--cwd', '/project'], ['--cwd', '/project', '--apply', '--apply'],
    ['--apply'], [], ['--cwd', '/project', '--only'], ['--cwd', '/project', '--only', '--apply'], ['--cwd'],
  ]) {
    it(`exits 2 before any read for ${JSON.stringify(argv)}`, async () => {
      const run = await runVerb(null, argv, THROWING);
      assert.equal(run.code, 2, run.stderr);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^usage: /);
      assert.deepEqual(run.writes, []);
    });
  }

  it('prints the help for --help or -h alone and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const run = await runVerb(null, [flag], THROWING);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stdout, lines().help());
    }
  });

  it('reaches the filesystem through deps: an injected lstat failure is the probe the verb prints', async () => {
    const { root } = makeProject(PROBED);
    const run = await runVerb(root, [], failAt(root, 'lstatSync', '.git', 'EACCES'));
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.lines[1], /^control-bytes: probe-unreadable — .*\bEACCES\b/);
  });

  it('never exits and never reads from the terminal', () => {
    assert.doesNotMatch(readFileSync(TOOL, 'utf8'), /process\.exit\(|process\.stdin|node:readline/);
  });
});

describe('spec:checker-gates/S15 every printed line comes from the one OUTCOME_LINES table', () => {
  it('exports one frozen table of composers, the disclosure its imported constant', () => {
    const table = lines();
    assert.ok(Object.isFrozen(table));
    for (const [key, compose] of Object.entries(table)) assert.equal(typeof compose, 'function', key);
    assert.equal(table.disclosure(), TRUST_CHAIN_DISCLOSURE);
  });

  it('composes the preview, a state detail and a refusal from the table', async () => {
    const table = lines();
    const { root } = makeProject({ ...PROBED, gates: [{ id: 'control-bytes', title: 't', cmd: 'npm run bytes' }] });
    const run = await runVerb(root);
    assert.deepEqual(run.lines, [table.disclosure(), table.candidate('control-bytes', 'id-taken', 'npm run bytes'),
      ...['plan-shape', 'spec-check', 'spec-coverage'].flatMap((id) => [table.candidate(id, 'offered'), table.entry(entryOf(root, id).slice(9))])]);
    const { root: bare } = makeProject();
    assert.equal((await runVerb(bare)).stderr, table.refusal('declaration-absent'));
  });

  it('prints no placeholder and no unrendered argument on any outcome', async () => {
    const { root, base } = makeProject(PROBED);
    const runs = [
      await runVerb(root), await runVerb(root, [], { kitToolsDir: join(base, 'kit"tools') }),
      await runVerb(makeProject().root), await runVerb(null, ['--bogus']), await runVerb(root, ['--apply']),
    ];
    for (const run of runs) {
      for (const line of [...run.lines, run.stderr]) assert.doesNotMatch(line, PLACEHOLDER_RE, line);
    }
  });
});

describe('spec:checker-gates/S17 the documents name the verb and drop the hand-declare sentences', () => {
  const read = (rel) => readFileSync(join(KIT, rel), 'utf8');
  const flat = (text) => text.replace(/\n(?:\s*\/\/)?\s*/g, ' ');

  it('gates.md carries the candidate paragraph with its undo, and its upgrade-writer sentence names the verb', () => {
    const gates = read('references/modes/gates.md');
    const paragraph = gates.split('\n\n').find((block) => block.includes('tools/checker-gates.mjs --cwd <project>'));
    assert.ok(paragraph, 'gates.md carries the candidate paragraph');
    for (const id of [...IDS, 'epic-shape', 'queue-audit', 'doc-parity']) assert.ok(paragraph.includes(`\`${id}\``), id);
    assert.match(paragraph, /removed by hand/);
    assert.match(paragraph, /\btier\b/);
    assert.doesNotMatch(paragraph, /--apply|gates-init|\b(?:four|4)\b/);
    assert.doesNotMatch(gates, /the only gates\.json writer is the consented legacy migration/);
    assert.ok(gates.includes('At upgrade'), 'gates.md states who writes gates.json at upgrade');
    const sentence = gates.slice(gates.indexOf('At upgrade')).split(/\.\s/)[0];
    for (const part of ['legacy migration', '`tier`', '`tools/checker-gates.mjs`']) assert.ok(sentence.includes(part), sentence);
  });

  it('upgrade.md names the verb beside the legacy migration and relays the checker preview in the tier block', () => {
    const upgrade = read('references/modes/upgrade.md');
    assert.doesNotMatch(upgrade, /ONLY gates\.json writer at upgrade/);
    const migration = upgrade.split('\n\n').find((block) => block.includes('`gates-migration` — legacy gates.json migration'));
    assert.ok(migration?.includes('`tools/checker-gates.mjs`'), 'the migration paragraph names the verb');
    const tier = upgrade.slice(upgrade.indexOf('**`tier` — the full-flow offer.**'));
    const block = tier.slice(0, tier.indexOf('\n\n'));
    for (const part of ['`checker-gates-declared`', 'preview line', 'disclosure', '`entry:`', 'before the ask']) assert.ok(flat(block).includes(part), part);
  });

  it('the gates-init header comment names the verb as a step-3 writer', () => {
    const source = read('tools/gates-init.mjs');
    const header = flat(source.slice(0, source.indexOf('\nimport ')));
    assert.match(header, /checker-gates\.mjs/);
    assert.doesNotMatch(header, /only gates\.json writer is the consented legacy migration/);
  });

  it('control-bytes.md step 3 names the verb with --only control-bytes', () => {
    const doc = flat(read('references/modes/control-bytes.md'));
    assert.match(doc, /tools\/checker-gates\.mjs --cwd <project> --only control-bytes/);
    assert.doesNotMatch(doc, /`gates-init` does not offer this entry|Wire it as a gate by hand/);
  });

  it('the three doc-parity declare-by-hand sentences are gone', () => {
    assert.doesNotMatch(read('references/modes/doc-parity.md'), /Declare it as a project gate by hand/);
    assert.doesNotMatch(flat(read('tools/doc-parity.mjs')), /declare it in docs\/ai\/gates\.json by hand/);
    assert.doesNotMatch(read('README.md'), /`--check` is a gate exit code for `docs\/ai\/gates\.json`/);
  });
});

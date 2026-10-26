import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCli, OUTCOME_LINES, COMMS_PRIORS, parseLensPriors, renderComms, renderStory, renderLens,
  extractCommsRegion, extractStoryRegion, normalizeCommsBody, normalizeStoryBody,
  reconcileCommsText, reconcileStoryText, reconcileLensText,
} from '../lens-region.mjs';
import { RULES_REGIONS, exceedsCap } from '../rules-regions.mjs';

// Revision 9's reconcile cells: a kit section of a deployed rules file is a kit file, written
// current with no question and no copy kept. The 506-line suite gains no line, so they live here.
const lens = await import('../lens-region.mjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', '..', '..', 'agent-workflow-engine');
const TEMPLATE_PATH = join(HERE, '..', '..', 'references', 'templates', 'agent_rules.md');
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const EM_DASH = String.fromCharCode(8212);
const EXIT_OK = 0;
const WIDE_CAP = 150;
const REGION_ROUTE = "text of your own goes under a ### heading of its own, titled unlike the kit's sections";
const RETIRED_WORD_RE = /(^|[^a-z])(custom|edited|preserved|kept)([^a-z]|$)/i;
// A lone continuation byte: valid in cp1251 or latin-1, never valid UTF-8.
const INVALID_UTF8 = Buffer.from([0xA0]);

const TEMPLATE_TEXT = await fs.readFile(TEMPLATE_PATH, 'utf8');
const FRAGMENT = await fs.readFile(join(ENGINE_DIR, 'references', 'agent-rules-lens.md'), 'utf8');
const LENS_PRIORS = parseLensPriors(await fs.readFile(join(ENGINE_DIR, 'references', 'agent-rules-lens-priors.md'), 'utf8'));
const REGIONS = [
  {
    id: 'communication', prefix: 'comms', section: 'Communication section', number: '4',
    title: 'Communication (user-facing messages)', canon: normalizeCommsBody(extractCommsRegion(TEMPLATE_TEXT).body),
    render: renderComms, reconcile: reconcileCommsText, priors: COMMS_PRIORS,
  },
  {
    id: 'story-sessions', prefix: 'story', section: 'Story sessions section', number: '9',
    title: 'Story sessions', canon: normalizeStoryBody(extractStoryRegion(TEMPLATE_TEXT).body),
    render: renderStory, reconcile: reconcileStoryText, priors: RULES_REGIONS[1].priors,
  },
  {
    id: 'lens', prefix: 'lens', section: 'planning/review lens section', number: '6',
    title: 'Planning, review & process-fidelity invariants', canon: FRAGMENT,
    render: renderLens, reconcile: reconcileLensText, priors: LENS_PRIORS,
  },
];
const EOLS = [['LF', LF], ['CRLF', CRLF]];

const currentBlocks = () => Object.fromEntries(REGIONS.map((row) => [row.id, row.render(row.canon, row.number)]));
// Two blank lines after every region: a write keeps the region's own trailing blank lines.
const createDocument = (blocks, cap = WIDE_CAP) => [
  '---', 'maxLines: ' + cap, '---', '# Rules', '', '## 2. Rules', '',
  ...REGIONS.flatMap((row) => [blocks[row.id], '', '']),
  '---', '', '## 3. Tail', 'Keep tail.', '',
].join(LF);
// A body of the user's own, a deeper heading inside it: that heading is the section's, not a boundary.
const differingBody = (row, title = row.title) => [
  '### 2.' + row.number + '. ' + title, 'My own wording.', '', '#### A heading of my own', 'My own rule.',
].join(LF);
const withRegion = (row, region) => ({ ...currentBlocks(), [row.id]: region });

const composeOne = (name, ...args) => {
  assert.equal(typeof OUTCOME_LINES[name], 'function', name + ' must exist');
  const line = OUTCOME_LINES[name](...args);
  assert.equal(typeof line, 'string', name + ' composes one line');
  assert.ok(!line.includes(LF), name + ' composes one line');
  return line;
};
const writtenLine = (row) => composeOne(row.prefix + 'Written');
const currentLine = (row) => composeOne(row.prefix + 'Current');

const createFixture = async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'differing-body-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, target: join(root, 'agent_rules.md') };
};

const reconcile = async (target, { engine = ENGINE_DIR } = {}) => {
  const logs = [];
  const errors = [];
  const writes = [];
  const record = (name) => async (...args) => {
    writes.push(name);
    return fs[name](...args);
  };
  const code = await runCli(['reconcile', target], {
    fs: { ...fs, writeFile: record('writeFile'), rename: record('rename') },
    env: { AGENT_WORKFLOW_ENGINE_DIR: engine },
    home: dirname(target),
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });
  return { code, logs, errors, writes };
};

describe('the differing body is written current spec:rules-regions/S22', () => {
  it('names the route in one module constant', () => {
    assert.equal(lens.REGION_ROUTE, REGION_ROUTE);
  });

  for (const row of REGIONS) {
    it('the ' + row.id + ' written line names the route and none of custom, edited, preserved or kept', () => {
      const line = writtenLine(row);
      assert.ok(line.startsWith('[lens-region] '), line);
      assert.ok(line.includes(row.section), 'the line names the ' + row.section);
      assert.ok(line.includes(REGION_ROUTE), 'the line names the route');
      assert.ok(!RETIRED_WORD_RE.test(line), 'the line says no retired word: ' + line);
    });

    for (const [eolName, eol] of EOLS) {
      it('writes a differing ' + row.id + ' body with the canon at the file own number, ' + eolName + ' kept', async (context) => {
        const fixture = await createFixture(context);
        await fs.writeFile(fixture.target, createDocument(withRegion(row, differingBody(row))).split(LF).join(eol));
        const result = await reconcile(fixture.target);
        assert.equal(result.code, EXIT_OK, result.errors.join(LF));
        assert.equal(await fs.readFile(fixture.target, 'utf8'), createDocument(currentBlocks()).split(LF).join(eol));
        assert.deepEqual(result.errors, []);
        assert.deepEqual(result.logs, REGIONS.map((other) => (other === row ? writtenLine(other) : currentLine(other))));
      });
    }

    it('writes a ' + row.id + ' heading that opens with its title words and goes on with the user own text', async (context) => {
      const fixture = await createFixture(context);
      const region = differingBody(row, row.title + ': my additions');
      await fs.writeFile(fixture.target, createDocument(withRegion(row, region)));
      const result = await reconcile(fixture.target);
      assert.equal(result.code, EXIT_OK, result.errors.join(LF));
      assert.equal(await fs.readFile(fixture.target, 'utf8'), createDocument(currentBlocks()));
      assert.ok(result.logs.includes(writtenLine(row)), result.logs.join(LF));
    });

    it('refuses the ' + row.id + ' write over the file own cap, writing nothing', async (context) => {
      const fixture = await createFixture(context);
      const { count } = exceedsCap(createDocument(currentBlocks()), null);
      const cap = count - 1;
      await fs.writeFile(fixture.target, createDocument(withRegion(row, differingBody(row)), cap));
      const before = await fs.readFile(fixture.target);
      const result = await reconcile(fixture.target);
      assert.equal(result.code, EXIT_OK, result.errors.join(LF));
      assert.deepEqual(await fs.readFile(fixture.target), before);
      assert.deepEqual(result.writes, []);
      const refused = composeOne(row.prefix + 'CapRefused', fixture.target, count, cap);
      assert.ok(refused.includes('writing the current ' + row.section + ' would push'), refused);
      assert.ok(result.logs.includes(refused), result.logs.join(LF));
    });
  }

  it('prints one line for a target that is not valid UTF-8, judges no region and reads no engine', async (context) => {
    const fixture = await createFixture(context);
    const text = createDocument(withRegion(REGIONS[2], differingBody(REGIONS[2])));
    await fs.writeFile(fixture.target, Buffer.concat([Buffer.from(text, 'utf8'), INVALID_UTF8]));
    const before = await fs.readFile(fixture.target);
    const result = await reconcile(fixture.target, { engine: join(fixture.root, 'absent-engine') });
    assert.equal(result.code, EXIT_OK, result.errors.join(LF));
    assert.deepEqual(await fs.readFile(fixture.target), before);
    assert.deepEqual(result.writes, []);
    assert.deepEqual(result.errors, []);
    const line = '[lens-region] ' + fixture.target + ' is not valid UTF-8 ' + EM_DASH + ' nothing written; fix its encoding and re-run.';
    assert.deepEqual(result.logs, [line]);
    assert.equal(composeOne('targetUndecodable', fixture.target), line);
  });

  const NOT_REGULAR = [
    ['a symlink to a rules file', async ({ root, target }) => {
      await fs.writeFile(join(root, 'real.md'), createDocument(withRegion(REGIONS[2], differingBody(REGIONS[2]))));
      await fs.symlink('real.md', target);
    }],
    ['a dangling symlink', async ({ target }) => fs.symlink('missing.md', target)],
    ['a directory', async ({ target }) => fs.mkdir(target)],
  ];
  const snapshot = async (root) => {
    const entries = await fs.readdir(root);
    return Promise.all(entries.sort().map(async (name) => {
      const path = join(root, name);
      const stat = await fs.lstat(path);
      if (stat.isSymbolicLink()) return [name, 'link', await fs.readlink(path)];
      if (stat.isDirectory()) return [name, 'directory'];
      return [name, 'file', await fs.readFile(path)];
    }));
  };
  for (const [name, plant] of NOT_REGULAR) {
    it('prints one line for ' + name + ', nothing written and nothing followed', async (context) => {
      const fixture = await createFixture(context);
      await plant(fixture);
      const before = await snapshot(fixture.root);
      const result = await reconcile(fixture.target, { engine: join(fixture.root, 'absent-engine') });
      assert.equal(result.code, EXIT_OK, result.errors.join(LF));
      assert.deepEqual(await snapshot(fixture.root), before);
      assert.deepEqual(result.writes, []);
      assert.deepEqual(result.errors, []);
      const line = '[lens-region] ' + fixture.target + ' is a link or not a regular file ' + EM_DASH + ' left as it stands; nothing written.';
      assert.deepEqual(result.logs, [line]);
      assert.equal(composeOne('targetNotRegular', fixture.target), line);
    });
  }

  it('keeps the absent line for an absent target', async (context) => {
    const fixture = await createFixture(context);
    const result = await reconcile(fixture.target, { engine: join(fixture.root, 'absent-engine') });
    assert.equal(result.code, EXIT_OK);
    assert.deepEqual(result.logs, [composeOne('targetAbsent', fixture.target)]);
    assert.deepEqual(result.writes, []);
  });

  it('rejects on an lstat error other than ENOENT, printing and writing nothing', async (context) => {
    const fixture = await createFixture(context);
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const seen = [];
    const record = async (...args) => seen.push(args[0]);
    await assert.rejects(runCli(['reconcile', fixture.target], {
      fs: { ...fs, lstat: async () => Promise.reject(denied), writeFile: record, rename: record },
      env: { AGENT_WORKFLOW_ENGINE_DIR: join(fixture.root, 'absent-engine') },
      home: fixture.root, log: record, logError: record,
    }), denied);
    assert.deepEqual(seen, []);
  });

  for (const row of REGIONS) {
    it('the pure ' + row.id + ' judgement answers custom with the written text and doubled with the text unchanged', () => {
      const differing = createDocument(withRegion(row, differingBody(row)));
      assert.deepEqual(row.reconcile(differing, row.canon, row.priors), { status: 'custom', text: createDocument(currentBlocks()) });
      const blocks = currentBlocks();
      const doubled = createDocument(withRegion(row, blocks[row.id] + LF + LF + differingBody(row)));
      assert.deepEqual(row.reconcile(doubled, row.canon, row.priors), { status: 'doubled', text: doubled });
    });
  }

  for (const row of REGIONS.slice(0, 2)) {
    it('every ' + row.id + ' prior answers refreshed with the canon', () => {
      assert.ok(row.priors.length > 0, row.id + ' carries its priors');
      for (const [index, prior] of row.priors.entries()) {
        const text = createDocument(withRegion(row, row.render(prior, row.number)));
        const expected = { status: 'refreshed', text: createDocument(currentBlocks()) };
        assert.deepEqual(row.reconcile(text, row.canon, row.priors), expected, row.id + ' prior ' + index);
      }
    });
  }
});

// The pile offer over temp trees: the record's piles, each pile's id and row, the queue as read, the Later
// bucket and its splice, the queue's own declared checks, the readback and the writer by spawn.
// Contract: docs/ai/specs/kit/source-size/index.md and its part piles.md. Red first: piles.mjs is
// imported inside each cell.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileBytesNoFollowCapped } from '../fs-read-nofollow.mjs';
import { loadDeclaration } from '../gates-declaration.mjs';
import { auditQueue } from '../queue-audit.mjs';
import { loadSourceSizeConfig } from '../source-size-config.mjs';
import * as core from '../source-size-core.mjs';
import { isLineUnsafe, jsonForLine } from '../source-size-refusal.mjs';
import { resolveLimits } from './limits.mjs';

const loadPiles = () => import('./piles.mjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, '..', '..');
const CLI = join(HERE, 'piles-cli.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-piles-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const R = 'fixture';
const CAP = 8388608;
const hex8 = (key) => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8).toUpperCase();
const SRC_ROW = [
  `- Plan the cleanup of the directory \`src\`, whose 23 entries the size check records over the limit of 20, so its files are laid out by meaning — id PILE-SRC-${hex8('src')}`,
  '  - recorded in docs/ai/source-size.json under "layout"."directories"; a regeneration lowers the record as the directory shrinks',
].join('\n');
const QUEUE = '# Q\n\n### Later\n';
const CLI_CMD = 'node agent-workflow-kit/tools/queue-audit-cli.mjs';
const QUEUE_HELD = (cause) => `docs/plans/queue.md cannot take the pile rows, so none is written: ${cause}`;
const CHECK_HELD = (cause) => `the queue's own check in docs/ai/gates.json cannot judge the pile rows, so none is written: ${cause}`;
const BUCKET_HELD = (k) => `the pile rows go to the end of the one heading reading Later or opening with Later after its # run, and docs/plans/queue.md holds ${k}`;
const REFUSED = (k, problem) => `the queue's own check would refuse the queue with the ${k} pile row(s) added, so none is written: ${problem}`;
const CAP_PROBLEM = (n, cap) => `docs/plans/queue.md: ${n} rows carry work, over the ${cap}-row cap — a backlog nobody can read is a dump. Close, delete or fold rows before filing another.`;

// The read core's reads, handed in by hand; NO_QUEUE throws on any queue read.
const READS = { loadSourceSizeConfig, readQueue: (path) => readFileBytesNoFollowCapped(path, CAP), realpath: realpathSync, lstat: lstatSync, isLineUnsafe, jsonForLine };
const unread = () => { throw new Error('the queue was read'); };
const NO_QUEUE = { ...READS, readQueue: unread, lstat: unread, realpath: unread };
const declarationOf = (root) => {
  try { return loadDeclaration(root); } catch (err) { return { outcome: 'error', message: err.message }; }
};

const minted = (directories, over = {}) => ({
  schema: 2, roots: ['src'], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 1, reason: R } },
  layout: { roots: { src: { files: 1, reason: R } }, directories }, ...over,
});
const PILE = { src: { entries: 23, reason: R } };
const loadedOf = (directories) => ({ state: 'minted', config: { schema: 2, limits: resolveLimits().limits, layout: { roots: {}, directories } } });
let seq = 0;
const project = ({ config = minted(PILE), queue = QUEUE, gates } = {}) => {
  const root = join(TMP, `p${seq += 1}`);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  if (config !== null) writeFileSync(join(root, 'docs', 'ai', 'source-size.json'), typeof config === 'string' ? config : JSON.stringify(config));
  if (queue !== null) {
    mkdirSync(join(root, 'docs', 'plans'));
    writeFileSync(join(root, 'docs', 'plans', 'queue.md'), queue);
  }
  if (gates !== undefined) writeFileSync(join(root, 'docs', 'ai', 'gates.json'), typeof gates === 'string' ? gates : JSON.stringify({ gates }));
  return root;
};
const queueOf = (root) => join(root, 'docs', 'plans', 'queue.md');
const gate = (cmd, id = 'queue') => ({ id, title: 'Queue', cmd });
const offer = async (root, reads = READS) => (await loadPiles()).pileOfferOf(root, reads, declarationOf(root));
const heldOf = async (root) => { const { answer, reason, text } = await offer(root); return [answer, reason, text]; };

describe('spec:source-size/S44 pilesOf answers the record\'s piles beyond the entries band, in its key order, with no tree walked', () => {
  it('a minted schema-2 layout record alone holds piles, judged against the resolved value and its band', async () => {
    const { pilesOf } = await loadPiles();
    const of = (config) => pilesOf(loadSourceSizeConfig(project({ config, queue: null })));
    const dirs = { a: { entries: 23, reason: R }, b: { entries: 22, reason: R }, c: { depth: 6, reason: R }, d: { entries: 30, depth: 6, reason: R } };
    assert.deepEqual(of(minted(dirs)), [{ key: 'a', entries: 23, value: 20 }, { key: 'd', entries: 30, value: 20 }], '23 is a pile, 22 within the band, a depth-only record none');
    assert.deepEqual(of(minted({ z: { entries: 40, reason: R }, a: { entries: 40, reason: R } })).map(({ key }) => key), ['z', 'a'], 'the record\'s key order');
    const override = { 'entries-per-directory': { value: 10, tolerance: 0, reason: R } };
    assert.deepEqual(of(minted(dirs, { limits: override })).map(({ key, value }) => [key, value]), [['a', 10], ['b', 10], ['d', 10]], 'an override moves the value');
    const { layout, ...noLayout } = minted(dirs);
    const { baseline, aggregate, ...authored } = minted(dirs);
    const { aggregate: half, ...incomplete } = minted(dirs);
    const schema1 = { schema: 1, defaults: { maxLines: 400, maxLineBytes: 1000 }, roots: ['src'], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 1, reason: R } } };
    for (const [label, config] of [['no layout', noLayout], ['authored', authored], ['incomplete', incomplete], ['schema 1', schema1], ['absent', null]]) {
      assert.deepEqual(of(config), [], label);
    }
  });
});

describe('spec:source-size/S45 pileIdOf, pileRowOf and the key a row cannot carry', () => {
  it('the id is the key\'s slug and the first 8 hex digits of its sha256, the row exactly two lines, an unsafe key holding the offer', async () => {
    const { pileIdOf, pileOfferOf, pileRowOf } = await loadPiles();
    assert.deepEqual(['.', 'agent-workflow-kit/tools', 'a-b', 'a/b', '__x__'].map(pileIdOf), [`PILE-${hex8('.')}`,
      `PILE-AGENT-WORKFLOW-KIT-TOOLS-${hex8('agent-workflow-kit/tools')}`, `PILE-A-B-${hex8('a-b')}`, `PILE-A-B-${hex8('a/b')}`, `PILE-X-${hex8('__x__')}`]);
    assert.notEqual(pileIdOf('a-b'), pileIdOf('a/b'));
    assert.equal(pileRowOf({ key: 'src', entries: 23, value: 20 }), SRC_ROW);
    for (const key of ['a`b', `a${String.fromCharCode(0x2028)}b`]) {
      const reads = { ...NO_QUEUE, loadSourceSizeConfig: () => loadedOf({ ok: { entries: 30, reason: R }, [key]: { entries: 30, reason: R } }) };
      assert.deepEqual(pileOfferOf(TMP, reads, { outcome: 'missing' }), { answer: 'held', reason: 'key',
        text: `a recorded pile's directory key holds a backtick or a byte a queue row cannot carry, so no pile row is offered: ${jsonForLine(key)}` });
    }
  });
});

describe('spec:source-size/S46 the queue as read, and the piles a row already names', () => {
  it('no pile answers none unread; each queue the rows cannot go to holds queue, naming its cause', async () => {
    const { pileOfferOf } = await loadPiles();
    const noPile = project({ config: minted({ a: { entries: 22, reason: R } }), queue: null });
    assert.deepEqual(pileOfferOf(noPile, NO_QUEUE, { outcome: 'missing' }), { answer: 'none' });
    const absent = await heldOf(project({ queue: null }));
    assert.deepEqual(absent, ['held', 'queue', QUEUE_HELD('it is absent')]);
    assert.doesNotMatch(absent[2], /source-size\./, 'the absent text names no item id');
    const leaf = project({ queue: null });
    mkdirSync(join(leaf, 'docs', 'plans'));
    writeFileSync(join(leaf, 'docs', 'plans', 'real.md'), QUEUE);
    symlinkSync('real.md', queueOf(leaf));
    const dir = project({ queue: null });
    mkdirSync(join(dir, 'docs', 'elsewhere'));
    writeFileSync(join(dir, 'docs', 'elsewhere', 'queue.md'), QUEUE);
    symlinkSync('elsewhere', join(dir, 'docs', 'plans'));
    const linkedRoot = join(TMP, `link${seq += 1}`);
    symlinkSync(project(), linkedRoot);
    const directory = project({ queue: null });
    mkdirSync(queueOf(directory), { recursive: true });
    const cases = [[leaf, 'docs/plans/queue.md is a symlink'], [dir, 'docs/plans is a symlink'], [linkedRoot, '. is a symlink'], [directory, 'not a regular file'],
      [project({ queue: Buffer.from([0x23, 0x20, 0xff, 0x0a]) }), 'invalid UTF-8'], [project({ queue: `### Later${String.fromCharCode(13)}\n` }), 'carries CR line endings'],
      [project({ queue: Buffer.alloc(CAP + 1, 0x78) }), `over ${CAP} bytes`]];
    for (const [root, cause] of cases) assert.deepEqual(await heldOf(root), ['held', 'queue', QUEUE_HELD(cause)], cause);
    const refused = await heldOf(project({ queue: '* a star item\n\n### Later\n' }));
    assert.deepEqual(refused.slice(0, 2), ['held', 'queue']);
    assert.match(refused[2], /: line 1 opens a list item this audit does not read/, 'the audit\'s refusal');
    const filler = `${'x'.repeat(99)}\n`.repeat(Math.floor((CAP - 64) / 100));
    const near = `# Q\n\n${filler}${' '.repeat(CAP - 64 - filler.length)}\n\n### Later\n`;
    assert.ok(Buffer.byteLength(near) <= CAP);
    assert.deepEqual(await heldOf(project({ queue: near })), ['held', 'queue', QUEUE_HELD(`over ${CAP} bytes once the rows are added`)]);
  });

  it('a BOM is kept and written back; a row of any class carrying a pile\'s id names it, and every pile named answers none', async () => {
    const bom = String.fromCharCode(0xfeff);
    const kept = await offer(project({ queue: `${bom}${QUEUE}` }));
    assert.deepEqual([kept.answer, kept.text], ['write', `${bom}${QUEUE}\n${SRC_ROW}\n`]);
    const two = minted({ a: { entries: 30, reason: R }, b: { entries: 30, reason: R } });
    const done = `# Q\n\n## Done\n\n- DONE the cleanup of the directory a — id PILE-A-${hex8('a')}\n\n${QUEUE.slice(4)}`;
    assert.notEqual(auditQueue(done).rows[0].klass, 'live', 'the naming row is not a live one');
    const named = await offer(project({ config: two, queue: done }));
    assert.deepEqual([named.answer, named.piles.map(({ key, id }) => [key, id])], ['write', [['b', `PILE-B-${hex8('b')}`]]]);
    const both = `${done}\n- the cleanup of the directory b — id PILE-B-${hex8('b')}\n`;
    assert.deepEqual(await offer(project({ config: two, queue: both })), { answer: 'none' });
  });
});

describe('spec:source-size/S47 the one Later bucket and the splice at its end', () => {
  it('none or several Later headings hold bucket, a fenced line is none, and the splice moves no other byte', async () => {
    const { spliceLater } = await loadPiles();
    for (const [queue, k] of [['# Q\n\n### Laterally\n', 0], ['```\n### Later\n```\n', 0], ['### Later\n\n## Later — real, ranked\n', 2]]) {
      assert.deepEqual(await heldOf(project({ queue })), ['held', 'bucket', BUCKET_HELD(k)], queue);
    }
    for (const queue of ['   ### Later ###\n', '# Later — real, ranked\n```\n### Later\n```\n']) assert.equal((await offer(project({ queue }))).answer, 'write', queue);
    const front = '---\nk: v\n---\n# Q\n\n### Later\n\n- one row of work — id ONE\n\n\n## Done\n';
    const spliced = (rows) => `---\nk: v\n---\n# Q\n\n### Later\n\n- one row of work — id ONE\n\n${rows}\n\n## Done\n`;
    assert.equal(spliceLater(front, 6, ['- r1\n  - c1', '- r2']), spliced('- r1\n  - c1\n\n- r2'));
    assert.equal((await offer(project({ queue: front }))).text, spliced(SRC_ROW), 'the bucket line counts the frontmatter');
    assert.equal(spliceLater('# Q\n\n### Later\n- x — id X\n\n\n', 3, ['- r1']), '# Q\n\n### Later\n- x — id X\n\n- r1\n');
    assert.equal(spliceLater('### Later', 1, ['- r1']), '### Later\n\n- r1\n');
    const seed = readFileSync(join(KIT, 'references', 'authoring', 'QUEUE_TEMPLATE.md'), 'utf8');
    const seeded = await offer(project({ queue: seed }));
    assert.deepEqual([seeded.answer, seeded.text], ['write', seed.replace('### Later\n\n### Frozen', `### Later\n\n${SRC_ROW}\n\n### Frozen`)]);
  });
});

describe('spec:source-size/S48 the queue\'s own declared checks and the readback', () => {
  it('queueChecksOf reads each queue-audit gate by the sh subset and the audit\'s own parseArgv', async () => {
    const { queueChecksOf } = await loadPiles();
    const loaded = (...cmds) => ({ outcome: 'loaded', gates: cmds.map((cmd, i) => gate(cmd, `g${i}`)) });
    assert.deepEqual(queueChecksOf({ outcome: 'missing' }, '/r'), { checks: [] });
    assert.deepEqual(queueChecksOf({ outcome: 'error', message: 'docs/ai/gates.json: malformed JSON (x)' }, '/r'), { cause: 'docs/ai/gates.json: malformed JSON (x)' });
    const cmds = ['true', `${CLI_CMD} --check docs/plans/queue.md --section '## Pending / backlog' --max-rows 5 --require-names`, `${CLI_CMD} --report docs/plans/queue.md`,
      'node "a b/queue-audit-cli.mjs"  --check "q x.md"'];
    assert.deepEqual(queueChecksOf(loaded(...cmds), '/r'), { checks: [
      { id: 'g1', path: '/r/docs/plans/queue.md', options: { mode: 'check', path: 'docs/plans/queue.md', section: '## Pending / backlog', requireNames: true, maxRows: 5 } },
      { id: 'g3', path: '/r/q x.md', options: { mode: 'check', path: 'q x.md', section: null, requireNames: false } }] });
    for (const cmd of [`${CLI_CMD} --check $Q`, `cd x && ${CLI_CMD} --check q`, `node 'a'b/queue-audit-cli.mjs --check q`, 'node x.mjs queue-audit-cli.mjs --check q',
      `${CLI_CMD}${String.fromCharCode(9)}--check q`, `${CLI_CMD} --check q # note`]) {
      assert.deepEqual(queueChecksOf(loaded(cmd), '/r'), { cause: 'gate g0 is outside the sh form the advisor reads' }, cmd);
    }
    assert.deepEqual(queueChecksOf(loaded(`${CLI_CMD} --check q --bogus`), '/r'), { cause: 'gate g0: unknown argument "--bogus" — run with --help' });
  });

  it('a check on the queue\'s realpath judges the rows, another path is ignored, and each failure holds by its step', async () => {
    const one = '# Q\n\n- one live row in the queue — id ONE\n\n### Later\n';
    const linked = (cap) => {
      const root = project({ queue: one, gates: [gate(`${CLI_CMD} --check docs/plans/other.md --max-rows 1`, 'other'), gate(`${CLI_CMD} --check docs/plans/link.md --max-rows ${cap}`)] });
      writeFileSync(join(root, 'docs', 'plans', 'other.md'), QUEUE);
      symlinkSync('queue.md', join(root, 'docs', 'plans', 'link.md'));
      return root;
    };
    assert.deepEqual(await heldOf(linked(1)), ['held', 'refused', REFUSED(1, CAP_PROBLEM(2, 1))], 'a symlink to the queue is its check');
    assert.equal((await offer(linked(2))).answer, 'write', 'a gate on another file is ignored');
    const rowCap = await heldOf(project({ gates: [gate(`${CLI_CMD} --check docs/plans/queue.md --max-row-lines 1`)] }));
    assert.deepEqual(rowCap.slice(0, 2), ['held', 'refused']);
    assert.ok(rowCap[2].startsWith(REFUSED(1, 'docs/plans/queue.md:5: the row is 3 lines, over the 1-line cap')), rowCap[2]);
    const two = `${one}\n- a second live row in the queue — id TWO\n`;
    assert.deepEqual(await heldOf(project({ queue: two, gates: [gate(`${CLI_CMD} --check docs/plans/queue.md --max-rows 1`)] })),
      ['held', 'queue', QUEUE_HELD(`it already fails its own check: ${CAP_PROBLEM(2, 1)}`)]);
    assert.deepEqual(await heldOf(project({ gates: [gate(`${CLI_CMD} --check docs/plans/queue.md --section '## Nope'`)] })),
      ['held', 'check', CHECK_HELD('gate queue: no section heading "## Nope" in the queue — the audit refuses to guess its domain.')]);
    assert.deepEqual(await heldOf(project({ gates: [gate(`${CLI_CMD} --check $Q`)] })), ['held', 'check', CHECK_HELD('gate queue is outside the sh form the advisor reads')]);
    const broken = await heldOf(project({ gates: '{ nope' }));
    assert.deepEqual(broken.slice(0, 2), ['held', 'check']);
    assert.ok(broken[2].startsWith(CHECK_HELD('docs/ai/gates.json: malformed JSON')), broken[2]);
    const stray = await heldOf(project({ config: minted({ 'x**y**z': { entries: 30, reason: R } }) }));
    assert.deepEqual(stray.slice(0, 2), ['held', 'queue']);
    assert.ok(stray[2].startsWith(QUEUE_HELD('the rows would not read back in the Later bucket: ')), stray[2]);
    const SWALLOWED = '# Q\n\n### Later\n\n  ### Next\n';
    const SWALLOW_PROBLEM = 'line 8 is a heading this document and its row scan read differently';
    const swallowed = await heldOf(project({ queue: SWALLOWED }));
    assert.deepEqual(swallowed.slice(0, 2), ['held', 'queue']);
    assert.ok(swallowed[2].startsWith(QUEUE_HELD(`the rows would not read back in the Later bucket: ${SWALLOW_PROBLEM}`)), swallowed[2]);
    const thrown = await heldOf(project({ queue: SWALLOWED, gates: [gate(`${CLI_CMD} --check docs/plans/queue.md`)] }));
    assert.deepEqual(thrown.slice(0, 2), ['held', 'check']);
    assert.ok(thrown[2].startsWith(CHECK_HELD(`gate queue: ${SWALLOW_PROBLEM}`)), thrown[2]);
    const { pileOfferOf, spliceLater } = await loadPiles();
    const root = project();
    const moved = pileOfferOf(root, READS, declarationOf(root), { spliceLater: (...args) => spliceLater(...args).replace('# Q', '# R') });
    assert.deepEqual([moved.answer, moved.reason, moved.text], ['held', 'queue', QUEUE_HELD('the rows would not read back in the Later bucket: a byte outside the bucket\'s end would move')]);
  });
});

describe('spec:source-size/S49 piles-cli.mjs writes the composed queue, and readPileOffer binds the core\'s reads', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: TMP, encoding: 'utf8' });

  it('--write writes and prints its rows, none and held write nothing, usage and config errors exit 2', async () => {
    const { pileOfferOf } = await loadPiles();
    const root = project();
    const planned = pileOfferOf(root, READS, declarationOf(root));
    const wrote = run('--write', '--cwd', root);
    assert.deepEqual([wrote.status, wrote.stdout, readFileSync(queueOf(root), 'utf8')],
      [0, `queued: PILE-SRC-${hex8('src')} — src\nwrote 1 row(s) to docs/plans/queue.md\n`, planned.text]);
    const again = run('--write', '--cwd', root);
    assert.deepEqual([again.status, again.stdout, readFileSync(queueOf(root), 'utf8')], [0, 'every recorded pile has its queue row — nothing to write\n', planned.text]);
    const held = project({ queue: '# Q\n' });
    const refused = run('--write', '--cwd', held);
    assert.deepEqual([refused.status, refused.stderr, readFileSync(queueOf(held), 'utf8')], [1, `${BUCKET_HELD(0)}\n`, '# Q\n']);
    const broken = project({ config: '{ nope' });
    assert.deepEqual([run('--write', '--cwd', broken).status, readFileSync(queueOf(broken), 'utf8')], [2, QUEUE]);
    for (const args of [[], ['--write', '--bogus'], ['--help', '--write'], ['--write', '--write'], ['--write', '--cwd']]) assert.equal(run(...args).status, 2, args.join(' '));
    const help = run('--help');
    assert.deepEqual([help.status, help.stdout.includes('--write [--cwd <dir>]')], [0, true]);
  });

  it('a refused atomic write exits 1 writing nothing, and readPileOffer answers what pileOfferOf answers', async () => {
    const { pileOfferOf } = await loadPiles();
    const { main } = await import('./piles-cli.mjs');
    const root = project();
    const rename = () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); };
    const refused = main(['--write', '--cwd', root], { deps: { rename } });
    assert.deepEqual([refused.code, readFileSync(queueOf(root), 'utf8'), readdirSync(join(root, 'docs', 'plans'))], [1, QUEUE, ['queue.md']]);
    assert.match(refused.stderr, /read-only file system/);
    const linkedPlans = project({ queue: null });
    mkdirSync(join(linkedPlans, 'docs', 'elsewhere'));
    writeFileSync(join(linkedPlans, 'docs', 'elsewhere', 'queue.md'), QUEUE);
    symlinkSync('elsewhere', join(linkedPlans, 'docs', 'plans'));
    const linkedRoot = join(TMP, `link${seq += 1}`);
    symlinkSync(project(), linkedRoot);
    const linkedGate = project({ queue: '# Q\n\n- one live row in the queue — id ONE\n\n### Later\n', gates: [gate(`${CLI_CMD} --check docs/plans/link.md --max-rows 1`)] });
    symlinkSync('queue.md', join(linkedGate, 'docs', 'plans', 'link.md'));
    const fixtures = [root, project({ queue: '# Q\n' }), project({ config: minted({}) }), project({ gates: '{ nope' }),
      linkedPlans, linkedRoot, project({ queue: Buffer.alloc(CAP + 1, 0x78) }), linkedGate];
    for (const fixture of fixtures) assert.deepEqual(core.readPileOffer(fixture, declarationOf(fixture)), pileOfferOf(fixture, READS, declarationOf(fixture)), fixture);
    assert.deepEqual(core.readPileOffer(root, { outcome: 'error', message: 'm' }), { answer: 'held', reason: 'check', text: CHECK_HELD('m') });
    const thrown = run('--write', '--cwd', fixtures[3]);
    assert.equal(thrown.status, 1);
    assert.ok(thrown.stderr.startsWith(CHECK_HELD('docs/ai/gates.json: malformed JSON')), thrown.stderr);
  });
});

// The advisor's source-size.piles item over temp git projects: it renders on the pile offer's write answer,
// its held answer and its own throw are stated skips, and its one-liner converges it.
// Contract: docs/ai/specs/kit/source-size/index.md and its part piles.md. Red first: every cell asks the
// advisor for an item or a skip HEAD does not render.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hermeticGitEnv } from '../git-env.mjs';
import { ITEM_LINE_CAP, SEVERITY_OPTIONAL, buildRecommendations } from '../recommendations.mjs';
import { shellQuoteArg } from '../repo-lex.mjs';
import { EXPECTED_WORKFLOW_VERSION } from '../velocity-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PILES_CLI = join(HERE, 'piles-cli.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'aw-source-size-piles-item-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
// The fixtures' own env for every spawn and the in-process advisor: no inherited GIT_* or host git config.
const GIT_ENV = hermeticGitEnv(process.env, TMP);
for (const key of Object.keys(process.env)) if (!Object.hasOwn(GIT_ENV, key)) delete process.env[key];
Object.assign(process.env, GIT_ENV);

const R = 'fixture';
const QUEUE = '# Q\n\n### Later\n';
const WHAT = '1 recorded pile(s) have no queue row planning their cleanup — one row each goes to the end of the queue\'s Later bucket';
const ABSENT = 'docs/plans/queue.md cannot take the pile rows, so none is written: it is absent';
const CHECK_HELD = 'the queue\'s own check in docs/ai/gates.json cannot judge the pile rows, so none is written: docs/ai/gates.json: malformed JSON';
const minted = (directories) => ({
  schema: 2, roots: ['src'], extensions: ['.mjs'], baseline: {}, aggregate: { src: { lines: 1, reason: R } },
  layout: { roots: { src: { files: 1, reason: R } }, directories },
});
const PILE = { src: { entries: 23, reason: R } };

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
};
let seq = 0;
const project = ({ config = minted(PILE), queue = QUEUE, gates } = {}) => {
  const cwd = join(TMP, `p${seq += 1}`);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs', 'ai'), { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  writeFileSync(join(cwd, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }, null, 2));
  writeFileSync(join(cwd, 'docs', 'ai', '.workflow-version'), `${EXPECTED_WORKFLOW_VERSION}\n`);
  writeFileSync(join(cwd, 'docs', 'ai', 'source-size.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  if (queue !== null) {
    mkdirSync(join(cwd, 'docs', 'plans'));
    writeFileSync(join(cwd, 'docs', 'plans', 'queue.md'), queue);
  }
  if (gates !== undefined) writeFileSync(join(cwd, 'docs', 'ai', 'gates.json'), gates);
  git(cwd, ['add', '-A']);
  return cwd;
};
const queueOf = (cwd) => join(cwd, 'docs', 'plans', 'queue.md');
// The source-size arms in order, the piles item and the two stated skips this suite reads.
const run = (cwd) => {
  const deps = { findWrapper: () => false, env: GIT_ENV, getenv: { PATH: '/nonexistent-path-for-tests' }, home: cwd };
  const { items, skips } = buildRecommendations({ cwd, deps });
  return {
    arms: items.filter((item) => item.key === 'source-size').map((item) => item.variant),
    piles: items.find((item) => item.variant === 'source-size.piles'),
    skip: skips.find((entry) => entry.key === 'source-size.piles')?.reason,
    base: skips.find((entry) => entry.key === 'source-size')?.reason,
  };
};

describe('spec:source-size/S50 the advisor\'s source-size.piles item renders on write, states its held answer and its throw, and converges', () => {
  it('on write it renders chat and optional after the layout arm, its WHAT within the cap, its one-liner and its recipe line', () => {
    const cwd = project();
    const { piles, arms, skip } = run(cwd);
    const apply = ['node', PILES_CLI, '--write', '--cwd', cwd].map(shellQuoteArg).join(' ');
    assert.deepEqual([piles?.key, piles?.severity, piles?.lane, piles?.what, piles?.check, piles?.apply, piles?.detail, skip],
      ['source-size', SEVERITY_OPTIONAL, 'chat', WHAT, null, apply, 'piles without a row: src', undefined]);
    assert.ok(piles.what.length <= ITEM_LINE_CAP, 'the WHAT within the item cap');
    assert.deepEqual(arms, ['source-size.piles', 'source-size'], 'its own item, the base arm rendering as before after it');
  });

  it('held renders the stated skip with its text, none renders nothing, and its own throw is a skip with the later arms running', () => {
    const said = ({ piles, skip }) => [piles, skip];
    assert.deepEqual(said(run(project({ queue: null }))), [undefined, ABSENT], 'held: the stated skip carries the held text');
    assert.deepEqual(said(run(project({ config: minted({ src: { entries: 22, reason: R } }) }))), [undefined, undefined], 'none: nothing');
    const malformed = run(project({ config: '{ not json' }));
    assert.match(malformed.skip ?? '', /source-size\.json is not valid JSON/, 'a throw of its own is the stated skip source-size.piles');
    assert.ok(malformed.arms.includes('source-size'), 'a malformed size config with no gate still renders the base source-size item');
    const gates = run(project({ gates: '{ nope' }));
    assert.ok((gates.skip ?? '').startsWith(CHECK_HELD), gates.skip);
    assert.match(gates.base ?? '', /docs\/ai\/gates\.json: malformed JSON/, 'the later arms rethrow the declaration\'s error, their skip today\'s');
  });

  it('a no leaves the queue byte-unchanged and the item renders again; its one-liner writes the rows and the next run renders neither item nor skip', () => {
    const cwd = project();
    const bytes = readFileSync(queueOf(cwd));
    const first = run(cwd).piles;
    assert.ok(first, 'the item renders');
    assert.deepEqual([readFileSync(queueOf(cwd)), run(cwd).piles?.apply], [bytes, first.apply], 'a no writes nothing and the item returns');
    const applied = spawnSync(first.apply, { shell: true, cwd: TMP, encoding: 'utf8' });
    assert.equal(applied.status, 0, `${applied.stdout}${applied.stderr}`);
    assert.match(readFileSync(queueOf(cwd), 'utf8'), /^### Later\n\n- Plan the cleanup of the directory `src`, .* — id PILE-SRC-[0-9A-F]{8}\n {2}- recorded in /m);
    const { piles, skip } = run(cwd);
    assert.deepEqual([piles, skip], [undefined, undefined], 'converged: neither item nor skip');
  });
});

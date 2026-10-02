import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACKS_FILE, factFingerprint } from '../ack-store.mjs';
import { buildRecommendations, formatRecommendations, main, SEVERITY_OPTIONAL } from '../recommendations.mjs';
import { shellQuoteArg as q } from '../review-state.mjs';

// The probe and the facts leaf are loaded dynamically, so the suite loads on a tree without them and each cell fails at its first call.
const loaded = await import('../recommendations.mjs');
const probeJevConnect = loaded.probeJevConnect ?? (() => { throw new Error('probeJevConnect is absent'); });
const connectLine = (await import('../jev-facts.mjs').catch(() => ({}))).connectLine ?? (() => { throw new Error('connectLine is absent'); });
const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'TYPESAFE_API_KEY';
const LANE = 'jev-connect';
const DECLINE = factFingerprint('jev-connect:declined');
const OTHER = factFingerprint('jev-connect:another-fact');
const WHAT = "Jev (TypeSafe) is not connected: TYPESAFE_API_KEY is not in the environment the agent's commands run in";
const BENEFIT = "decisions — a typed choice with a confidence in under a second for your code and the agent's scripts, once for every project here";
const CANARIES = ['tsk-G7h8', 'Vs6_a-longer-canary-value-for-the-advisor.k'];
const KEYS = { set: { [KEY]: CANARIES[0] }, absent: {}, empty: { [KEY]: '' }, 'whitespace-only': { [KEY]: ' \t ' } };
const ACKS = { absent: null, declined: DECLINE, 'another fingerprint': OTHER, unreadable: null };

const made = [];
after(() => {
  for (const root of made) rmSync(root, { recursive: true, force: true });
});
const projectOf = (ack = null) => {
  const root = mkdtempSync(join(tmpdir(), 'jev-offer-'));
  made.push(root);
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  if (ack !== null) writeFileSync(join(root, ACKS_FILE), `${JSON.stringify({ jevConnectAck: ack })}\n`);
  return root;
};
// Every path deps.lstat is given is recorded; the unreadable ack throws EACCES at the root's docs/ai/acks.json.
const recordingLstat = (root, unreadable, seen) => (path) => {
  seen.push(path);
  if (unreadable && path === join(root, ACKS_FILE)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
  return lstatSync(path);
};
const alone = (root, deps = {}) => buildRecommendations({ cwd: root, deps: { probes: [probeJevConnect], ...deps } });
const withKey = (value, fn) => {
  const saved = Object.hasOwn(process.env, KEY) ? process.env[KEY] : undefined;
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
};
const advisorRun = (root, argv = []) => {
  const result = main(['--cwd', root, ...argv]);
  assert.equal(result.code, 0, result.stderr);
  return result;
};
const offersIn = (result) => JSON.parse(result.stdout).items.filter(({ key }) => key === LANE);
// The probe span: from the comment block directly above export const probeJevConnect to its closing `};`.
const probeSpan = (source) => {
  const lines = source.split('\n');
  const at = lines.findIndex((line) => line.startsWith('export const probeJevConnect = '));
  assert.ok(at > 0, 'export const probeJevConnect');
  const first = at - [...lines.slice(0, at)].reverse().findIndex((line) => !line.startsWith('//'));
  return lines.slice(first, lines.findIndex((line, index) => index > at && line === '};') + 1).join('\n');
};

describe('spec:jev-guide/S17 the state table: key × ack, one conjunction admits the item', () => {
  for (const [keyName, env] of Object.entries(KEYS)) {
    for (const [ackName, ack] of Object.entries(ACKS)) {
      it(`key ${keyName} × ack ${ackName}`, () => {
        const root = projectOf(ack);
        const seen = [];
        const { items, skips } = alone(root, { getenv: env, lstat: recordingLstat(root, ackName === 'unreadable', seen) });
        const notSet = keyName !== 'set';
        const offered = notSet && ['absent', 'another fingerprint'].includes(ackName);
        const skipped = notSet && ackName === 'unreadable';
        assert.deepEqual(items.map(({ key }) => key), offered ? [LANE] : []);
        assert.deepEqual(skips.map(({ key }) => key), skipped ? [LANE] : []);
        if (!notSet) assert.ok(!seen.includes(join(root, ACKS_FILE)), 'the key-set row never reads the ack');
      });
    }
  }
});

describe('spec:jev-guide/S18 the item and the decline round trip', () => {
  it('renders one optional jev-connect item: the WHAT and BENEFIT literals, the HAND-APPLY connect apply and the decline recipe line', () => {
    const root = projectOf();
    const { items, skips } = alone(root, { getenv: {} });
    assert.equal(skips.length, 0);
    assert.deepEqual(items, [{ key: LANE, variant: LANE, severity: SEVERITY_OPTIONAL, what: WHAT, benefit: BENEFIT,
      apply: `HAND-APPLY: ${connectLine(TOOLS)}`,
      detail: `HAND-APPLY alternative (instead of the apply, never after it): decline the offer by recording it — node ${q(join(TOOLS, 'ack-write.mjs'))} --lane ${LANE} --fingerprint ${DECLINE} --cwd ${q(root)}` }]);
    assert.ok(formatRecommendations({ items, skips }).includes(WHAT));
  });

  it('opens the recipe line with the place under deps.jevHost { container: true }, the apply still the bare connect line', () => {
    const root = projectOf();
    const [plain] = alone(root, { getenv: {} }).items;
    const { items, skips } = alone(root, { getenv: {}, jevHost: { container: true } });
    assert.equal(skips.length, 0);
    assert.deepEqual(items.map(({ apply }) => apply), [`HAND-APPLY: ${connectLine(TOOLS, undefined)}`]);
    assert.equal(items[0].detail, `run the apply in a terminal inside this container; ${plain.detail}`);
    assert.ok(plain.detail.startsWith('HAND-APPLY alternative'), plain.detail);
  });

  it('the recipe line run with --apply records the decline at jevConnectAck and the next run renders no item', () => {
    const root = projectOf();
    const [item] = alone(root, { getenv: {} }).items;
    const command = item.detail.slice(item.detail.indexOf('— ') + '— '.length);
    const written = spawnSync('sh', ['-c', `${command} --apply`], { encoding: 'utf8' });
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ACKS_FILE), 'utf8')), { jevConnectAck: DECLINE });
    assert.deepEqual(alone(root, { getenv: {} }), { root, items: [], skips: [] });
  });
});

describe('spec:jev-guide/S20 the hermetic seam and the canary', () => {
  it('buildRecommendations with deps lacking getenv renders the item under a canary key in process.env', () => {
    withKey(CANARIES[0], () => assert.deepEqual(alone(projectOf()).items.map(({ key }) => key), [LANE]));
  });

  it('main with no ctx.deps renders no item under either canary and the item with the variable absent', () => {
    const root = projectOf();
    for (const canary of CANARIES) withKey(canary, () => assert.deepEqual(offersIn(advisorRun(root, ['--json'])), [], canary));
    withKey(undefined, () => assert.equal(offersIn(advisorRun(root, ['--json'])).length, 1));
  });

  it('under both canaries no plain or --json output of the advisor carries either value', () => {
    const root = projectOf();
    for (const canary of CANARIES) {
      withKey(canary, () => {
        for (const result of [advisorRun(root), advisorRun(root, ['--json'])]) {
          for (const value of CANARIES) assert.ok(!result.stdout.includes(value) && !result.stderr.includes(value), `${canary}: ${value}`);
        }
      });
    }
  });
});

describe('spec:jev-guide/S21 one key rule, one leaf: the facts leaf exports it, the probe and the guide import it', () => {
  it('the probe span calls keySet( and connectLine( and carries no .trim( and no key name; the advisor imports both from ./jev-facts.mjs and nothing from the guide', () => {
    const source = readFileSync(join(TOOLS, 'recommendations.mjs'), 'utf8');
    const span = probeSpan(source);
    assert.ok(span.includes('keySet(') && span.includes('connectLine('), span);
    assert.ok(!span.includes('.trim(') && !span.includes(KEY), span);
    const line = source.split('\n').find((item) => /^import \{[^}]*\} from '\.\/jev-facts\.mjs';$/.test(item));
    assert.ok(line && /\bkeySet\b/.test(line) && /\bconnectLine\b/.test(line), line);
    assert.doesNotMatch(source, /from '\.\/jev-guide\.mjs'/);
  });

  it('the guide imports keySet and connectLine from ./jev-facts.mjs; the facts leaf imports only join from node:path', () => {
    const guide = readFileSync(join(TOOLS, 'jev-guide.mjs'), 'utf8');
    const line = guide.split('\n').find((item) => /^import \{[^}]*\} from '\.\/jev-facts\.mjs';$/.test(item));
    assert.ok(line && /\bkeySet\b/.test(line) && /\bconnectLine\b/.test(line), line);
    const facts = readFileSync(join(TOOLS, 'jev-facts.mjs'), 'utf8');
    assert.deepEqual(facts.match(/^import .*$/gm), ["import { join } from 'node:path';"]);
  });
});

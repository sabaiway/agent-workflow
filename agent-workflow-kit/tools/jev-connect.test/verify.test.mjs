// spec:jev-guide — docs/ai/specs/kit/jev-guide/jev-connect.md
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Both leaves are loaded dynamically, so the suite loads on a tree without them and each cell fails at its first call.
const facts = await import('../jev-facts.mjs').catch(() => ({}));
const { JEV_ENDPOINT, JEV_ERROR_MEANINGS = {}, JEV_SAMPLE_BODY } = facts;
const loaded = await import('../jev-connect.mjs').catch(() => ({}));
const verifyKey = loaded.verifyKey ?? (() => { throw new Error('verifyKey is absent'); });
const main = loaded.main ?? (() => { throw new Error('main is absent'); });
const KEY = 'tsk-Secret-9z';
const OK = { answers: { department: { choice: 'billing', confidence: 0.81 } } };

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-verify-'));
  made.push(dir);
  return dir;
};
const hashTree = (path) => createHash('sha256').update(readdirSync(path).sort().map((name) => {
  const stat = lstatSync(join(path, name));
  return `${name}:${stat.mode}:${stat.isFile() ? readFileSync(join(path, name), 'utf8') : 'x'}`;
}).join('\n')).digest('hex');
const answering = (status, body) => async () => ({ status, json: async () => body });
const recording = (impl) => {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return impl(url, init); } };
};
// A fetch that never answers but keeps the loop alive, so the AbortSignal's own timer can fire.
const hanging = (url, init) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve({ status: 200, json: async () => OK }), 10000);
  init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); });
});

describe('spec:jev-guide/S24 the one request', () => {
  it('makes exactly one POST to the endpoint with the Bearer header, the JSON type, the sample body, no redirect and a signal', async () => {
    const { calls, fetch } = recording(answering(200, OK));
    const verdict = await verifyKey(KEY, { fetch });
    assert.deepEqual(verdict, { ok: true, line: 'verified: HTTP 200 — department billing, confidence 0.81' });
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    assert.equal(init.body, JSON.stringify(JEV_SAMPLE_BODY));
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  });

  const NOT_OK = [
    ['a 200 that is not JSON', async () => ({ status: 200, json: async () => { throw new SyntaxError('bad'); } }), 'not verified: HTTP 200 with an answer that is not JSON'],
    ['a 200 without the fields', answering(200, { answers: { department: { choice: 1 } } }), 'not verified: HTTP 200 without a department choice and a confidence'],
    ['a 200 with no answers', answering(200, {}), 'not verified: HTTP 200 without a department choice and a confidence'],
    ...[401, 422, 429, 529].map((status) => [`HTTP ${status}`, answering(status, {}), `not verified: HTTP ${status} — ${JEV_ERROR_MEANINGS[status]}`]),
    ['another status', answering(500, {}), 'not verified: HTTP 500'],
    ['a thrown fetch with a cause', async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.typesafe.ai') }); }, 'not verified: getaddrinfo ENOTFOUND api.typesafe.ai'],
    ['a thrown fetch without a cause', async () => { throw new Error('socket hang up'); }, 'not verified: socket hang up'],
  ];
  for (const [name, impl, line] of NOT_OK) {
    it(`${name} returns not ok with its line`, async () => {
      const { calls, fetch } = recording(impl);
      assert.deepEqual(await verifyKey(KEY, { fetch }), { ok: false, line });
      assert.equal(calls.length, 1);
    });
  }

  it('a timeout under a 0.03 s budget returns not ok naming the wait', async () => {
    assert.deepEqual(await verifyKey(KEY, { fetch: hanging, timeoutMs: 30 }), { ok: false, line: 'not verified: no answer within 0.03 s' });
  });

  it('replaces the key by <key> in a cause and in a choice that carried it', async () => {
    const thrown = await verifyKey(KEY, { fetch: async () => { throw new Error(`refused for ${KEY} here`); } });
    assert.equal(thrown.line, 'not verified: refused for <key> here');
    const echoed = await verifyKey(KEY, { fetch: answering(200, { answers: { department: { choice: KEY, confidence: 0.5 } } }) });
    assert.equal(echoed.line, 'verified: HTTP 200 — department <key>, confidence 0.5');
  });
});

class FakeStdin extends EventEmitter {
  constructor(feed) { super(); this.isTTY = true; this.feed = feed; }

  setRawMode() {}

  setEncoding() {}

  pause() {}

  resume() { setImmediate(() => { for (const chunk of this.feed) this.emit('data', chunk); }); }
}
const runMain = async (argv, fetch, home) => {
  const out = [];
  const err = [];
  const code = await main(argv, { stdin: new FakeStdin([`${KEY}\r`]), stdout: { write: () => {} }, log: (text) => out.push(text),
    error: (text) => err.push(text), env: { SHELL: '/bin/bash' }, home, platform: 'linux', fetch });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
};

describe('the verdict in main (S24, continued)', () => {
  it('a not-ok verdict prints its line and nothing written, exits 1 and leaves the home unchanged', async () => {
    const home = tmp();
    const before = hashTree(home);
    const { calls, fetch } = recording(answering(401, {}));
    const result = await runMain([], fetch, home);
    assert.deepEqual([result.code, result.stdout, result.stderr], [1, `not verified: HTTP 401 — ${JEV_ERROR_MEANINGS[401]}\nnothing written`, '']);
    assert.equal(calls.length, 1);
    assert.equal(hashTree(home), before);
  });

  it('--unverified makes no call, prints the skipped line and saves', async () => {
    const home = tmp();
    const { calls, fetch } = recording(answering(200, OK));
    const result = await runMain(['--unverified'], fetch, home);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], 'not verified: skipped (--unverified)');
    assert.equal(calls.length, 0);
    assert.ok(readFileSync(join(home, '.bashrc'), 'utf8').includes(loaded.MARK));
  });
});

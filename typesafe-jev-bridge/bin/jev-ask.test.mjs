import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, '..');
const REPO = resolve(BRIDGE, '..');
const HOST = 'api.jev.invalid';
const ENDPOINT = `https://${HOST}/v1/systemone`;
const KEY_VARIABLE = 'TYPESAFE_API_KEY';
const REQUEST_ID = 'req-1';
const STATE_LIMIT = 30000;
const BODY_LIMIT = 60000;
const made = [];
const client = () => import('./jev-client.mjs');
const read = (path) => readFileSync(path, 'utf8');
const readManifest = () => JSON.parse(read(join(BRIDGE, 'capability.json')));
const getModel = () => { const model = readManifest().posture?.model; assert.ok(model, 'capability.json posture.model is absent'); return model; };
const getFacts = () => [read(join(REPO, 'codex-cli-bridge/service-facts.txt')).split('\n')[0], `HOST=${HOST}`, `RUN_HOST=${HOST}`, `PASSED_VARIABLE=${KEY_VARIABLE}`, ''].join('\n');
const makeQuestion = (instructions = 'Choose the supported option.') => ({ type: 'choice', instructions, criteria: { yes: 'Supported', no: 'Unsupported' } });
const makeRequest = () => ({ state: 'The build passed and the change is ready for review.', questions: { ready: makeQuestion(), safe: { ...makeQuestion(), criteria: { yes: 'Safe', no: 'Unsafe', unsure: 'Unclear' } } } });
const makeAnswer = (model, request = makeRequest()) => ({ model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, { type: 'choice', choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((option, index) => [option, index === 0 ? 1 : 0])), confidence: 0.9 }])) });
const makeResponse = (body, status = 200, headers = { 'x-typesafe-request-id': REQUEST_ID }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const neverCall = () => assert.fail('transport must not be called');
const makeFixture = (context, wrapper = false) => {
  if (wrapper) read(join(HERE, 'jev-ask.sh'));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jev-ask-')));
  made.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  if (wrapper) cpSync(HERE, join(root, 'bin'), { recursive: true });
  cpSync(join(BRIDGE, 'capability.json'), join(root, 'capability.json'));
  writeFileSync(join(root, 'service-facts.txt'), getFacts());
  const path = join(root, 'request.json');
  writeFileSync(path, JSON.stringify(makeRequest()));
  const key = `tsk-test-${Buffer.from(context.name).toString('hex')}-${'Q7xZp3'.repeat(6)}`;
  const preload = join(root, 'no-network.mjs');
  writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('unexpected transport call'); };\n");
  const env = { PATH: process.env.PATH ?? '', HOME: home, LC_ALL: 'C', [KEY_VARIABLE]: key, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  return { root, path, key, env, argv: ['--host', HOST, '--key-variable', KEY_VARIABLE, path] };
};
after(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));
const assertOutcome = (result, key, code, posture = false, shared = false) => {
  assert.equal(result.code, code, result.stderr);
  for (const stream of [result.stdout, result.stderr]) { assert.equal(typeof stream, 'string'); assert.equal(stream.includes(key.trim()), false, 'key leaked'); }
  const lines = result.stderr === '' ? [] : result.stderr.split('\n').slice(0, -1);
  assert.equal(result.stderr, lines.length ? `${lines.join('\n')}\n` : '');
  assert.equal(lines.length, Number(posture) + Number(code !== 0), result.stderr);
  if (posture) assert.match(lines[0], /^judge posture: /);
  if (code !== 0) { assert.equal(result.stdout, ''); assert.match(lines.at(-1), shared ? /^error: / : /^jev-ask: /); }
  return result;
};
const runClient = async (cli, fixture, code, options = {}, posture = false) => {
  const calls = [];
  const transport = (...args) => { calls.push(args); return (options.transport ?? neverCall)(...args); };
  const result = await cli.runJudgeCli({ argv: fixture.argv, env: fixture.env, folder: fixture.root, ...options, transport });
  assertOutcome(result, fixture.key, code, posture);
  assert.equal(calls.length, Number(posture), 'one request only after posture');
  return result;
};
const runWrapper = (fixture, argv, code, overrides = {}, posture = false, shared = false, bash = 'bash') => {
  const result = spawnSync(bash, [join(fixture.root, 'bin/jev-ask.sh'), ...argv], { cwd: fixture.root, env: { ...fixture.env, ...overrides }, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return assertOutcome({ code: result.status, stdout: result.stdout, stderr: result.stderr }, fixture.key, code, posture, shared);
};
const addPreload = (fixture, body, status = 200) => {
  const log = join(fixture.root, 'fetch.log');
  const preload = join(fixture.root, 'preload.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';\nglobalThis.fetch = async (url) => { appendFileSync(${JSON.stringify(log)}, String(url) + '\\n'); return new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status}, headers: { 'x-typesafe-request-id': '${REQUEST_ID}' } }); };\n`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, log };
};
const addRecordingNode = (fixture) => {
  const bin = join(fixture.root, 'recording');
  mkdirSync(bin);
  const argv = join(fixture.root, 'node.argv');
  const env = join(fixture.root, 'node.env');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${quote(argv)}\nprintf '%s' "\${TYPESAFE_API_KEY-}" > ${quote(env)}\nexec ${quote(process.execPath)} "$@"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  return { PATH: `${bin}:${fixture.env.PATH}`, argv, env };
};
const listFiles = (root, relative = '') => readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => entry.name === 'node_modules' ? [] : entry.isDirectory() ? listFiles(root, join(relative, entry.name)) : [join(relative, entry.name)]).sort();
const scanFolder = (root) => {
  const files = listFiles(root).filter((file) => !file.endsWith('.test.mjs'));
  const hits = files.flatMap((file) => {
    const text = read(join(root, file));
    return [file !== 'service-facts.txt' && /[a-z0-9.-]*typesafe\.ai\b/i.test(text) ? `${file}: host` : null, file !== 'capability.json' && /\bjev-(?:\d+(?:\.\d+)*|latest)\b/i.test(text) ? `${file}: model` : null].filter(Boolean);
  });
  return { files, hits };
};

it('spec:typesafe-jev-bridge/S1 posts the pinned two-question request and prints only normalized notes', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  const model = getModel();
  for (const requestId of [REQUEST_ID, null]) {
    const calls = [];
    const answer = makeAnswer(model);
    const transport = async (...args) => { calls.push(args); return makeResponse(answer, 200, requestId ? { 'x-typesafe-request-id': requestId } : {}); };
    const result = await runClient(cli, fixture, 0, { env: { [KEY_VARIABLE]: `  ${fixture.key}  ` }, transport }, true);
    assert.equal(result.stderr, `judge posture: model=${model} host=${HOST} timeout=10s\n`);
    assert.match(result.stdout, /[^\n]\n$/);
    assert.deepEqual(JSON.parse(result.stdout), { model, requestId, notes: Object.fromEntries(Object.entries(answer.answers).map(([id, { type, ...note }]) => [id, note])) });
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(String(url), ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${fixture.key}`);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(init.body), { ...makeRequest(), model });
  }
  const request = { ...makeRequest(), questions: { 'a\nb': makeQuestion(), 'a b': makeQuestion() } };
  writeFileSync(fixture.path, JSON.stringify(request));
  const answer = makeAnswer(model, request);
  const result = await runClient(cli, fixture, 0, { transport: async () => makeResponse(answer) }, true);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout).notes).sort(), Object.keys(request.questions).sort());
});
it('spec:typesafe-jev-bridge/S2 trims key presence and validates the request before a missing key', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  for (const value of [undefined, '', '   ', '\u00a0']) {
    const env = value === undefined ? {} : { [KEY_VARIABLE]: value };
    assert.equal(cli.keyIsSet(env, KEY_VARIABLE), false);
    await runClient(cli, fixture, 3, { env });
  }
  assert.equal(cli.keyIsSet({ [KEY_VARIABLE]: '  k  ' }, KEY_VARIABLE), true);
  writeFileSync(fixture.path, '{not json');
  await runClient(cli, fixture, 2, { env: {} });
});
it('spec:typesafe-jev-bridge/S3 bounds a stalled transport and a stalled response body', { timeout: 3000 }, async (context) => {
  const cli = await client();
  assert.equal(cli.JUDGE_TIMEOUT_MS, 10000);
  const fixture = makeFixture(context);
  for (const reply of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start: () => {} }), { status: 200 })]) {
    const signals = [];
    await runClient(cli, fixture, 4, { transport: (url, init) => { signals.push(init.signal); return reply(); }, timeoutMs: 50 }, true);
    assert.equal(signals[0].aborted, true);
  }
});
it('spec:typesafe-jev-bridge/S4 classifies HTTP refusals without following redirects', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  const causes = /key|refused|validation|rate limit|overloaded/i;
  for (const [status, cause] of [[401, /key.*refused|refused.*key/i], [422, /validation/i], [429, /rate limit/i], [529, /overloaded/i], [500, null], [302, null]]) {
    const headers = { ...(status === 401 || status === 302 ? { 'x-typesafe-request-id': REQUEST_ID } : {}), ...(status === 302 ? { Location: 'https://redirect.jev.invalid/' } : {}) };
    const signals = [];
    const result = await runClient(cli, fixture, 5, { transport: async (url, init) => { signals.push(init.signal); return makeResponse('refusal', status, headers); } }, true);
    assert.equal(signals[0].aborted, true, `the ${status} exchange is aborted`);
    const line = result.stderr.split('\n')[1];
    assert.match(line, new RegExp(`\\b${status}\\b`));
    if (headers['x-typesafe-request-id']) assert.ok(line.includes(REQUEST_ID));
    if (cause) assert.match(line, cause); else assert.doesNotMatch(line, causes);
  }
});
it('spec:typesafe-jev-bridge/S5 reports a transport rejection before any status', async (context) => {
  const cli = await client();
  await runClient(cli, makeFixture(context), 8, { transport: async () => { throw new TypeError('fetch failed', { cause: new Error('connection failed') }); } }, true);
});
it('spec:typesafe-jev-bridge/S6 rejects every malformed answer cell', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  const valid = makeAnswer(getModel());
  const { answers, model } = valid;
  const changeNote = (patch) => ({ ...valid, answers: { ...answers, ready: { ...answers.ready, ...patch } } });
  const invalid = ['not JSON', { model }, { answers }, { ...valid, model: 13 }, { ...valid, answers: { ready: answers.ready } }, { ...valid, answers: { ...answers, extra: answers.ready } },
    changeNote({ choice: 'outside' }), changeNote({ probabilities: { yes: 1 } }), changeNote({ probabilities: { ...answers.ready.probabilities, extra: 0 } }),
    ...[1.5, -0.1].map((yes) => changeNote({ probabilities: { ...answers.ready.probabilities, yes } })), changeNote({ confidence: 1.5 }), changeNote({ type: 'noul' })];
  for (const body of invalid) await runClient(cli, fixture, 6, { transport: async () => makeResponse(body) }, true);
});
it('spec:typesafe-jev-bridge/S7 names both models when a well-formed answer uses another pin', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  const other = 'jev-0.0.1';
  const result = await runClient(cli, fixture, 7, { transport: async () => makeResponse(makeAnswer(other)) }, true);
  for (const model of [getModel(), other]) assert.ok(result.stderr.includes(model));
});
describe('spec:typesafe-jev-bridge/S8 every refused operand, flag and request exits 2 before any request', () => {
  it('refuses wrapper operands and flags before starting node', (context) => {
    const fixture = makeFixture(context, true);
    const recording = addRecordingNode(fixture);
    for (const argv of [[], [fixture.path, fixture.path], ['--bogus'], ['-x']]) { runWrapper(fixture, argv, 2, { PATH: recording.PATH }); assert.equal(existsSync(recording.argv), false); }
  });
  it('rejects unreadable requests and every invalid request grammar cell', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    for (const path of [join(fixture.root, 'absent'), fixture.root]) await runClient(cli, fixture, 2, { argv: [...fixture.argv.slice(0, -1), path] });
    const request = makeRequest();
    const criteria = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`o${index}`, 'Option']));
    const withQuestion = (patch) => ({ ...request, questions: { ready: { ...makeQuestion(), ...patch } } });
    const invalid = ['{not json', { ...request, model: getModel() }, { questions: request.questions }, { ...request, state: '' }, { ...request, questions: {} },
      ...['noul', 'score'].map((type) => withQuestion({ type })), ...[1, 256].map((count) => withQuestion({ criteria: criteria(count) })), withQuestion({ criteria: { yes: '', no: 'No' } })];
    for (const body of invalid) { writeFileSync(fixture.path, typeof body === 'string' ? body : JSON.stringify(body)); await runClient(cli, fixture, 2); }
    for (const count of [2, 255]) {
      const body = withQuestion({ criteria: criteria(count) });
      writeFileSync(fixture.path, JSON.stringify(body));
      const calls = [];
      await runClient(cli, fixture, 0, { transport: async (...args) => { calls.push(args); return makeResponse(makeAnswer(getModel(), body)); } }, true);
      assert.equal(calls.length, 1);
    }
  });
});
it('spec:typesafe-jev-bridge/S9 measures UTF-8 bytes and admits requests exactly at both limits', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  const model = getModel();
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const measure = ({ state, questions }) => ({ sum: bytes(state) + Math.max(...Object.entries(questions).map(bytes)), body: bytes({ state, model, questions }) });
  const sizeRequest = (sum, body) => {
    const state = '\u00e9'.repeat(10);
    const first = makeQuestion('x'.repeat(sum - bytes(state) - bytes(['ready', makeQuestion('')])));
    const request = { state, questions: { ready: first, safe: makeQuestion('') } };
    return { ...request, questions: { ...request.questions, safe: makeQuestion('x'.repeat(body - measure(request).body)) } };
  };
  for (const [sum, body, code] of [[STATE_LIMIT + 1, BODY_LIMIT, 2], [STATE_LIMIT - 1, BODY_LIMIT + 1, 2], [STATE_LIMIT, BODY_LIMIT, 0]]) {
    const request = sizeRequest(sum, body);
    assert.deepEqual(measure(request), { sum, body });
    writeFileSync(fixture.path, JSON.stringify(request));
    const calls = [];
    const result = await runClient(cli, fixture, code, { transport: async (...args) => { calls.push(args); return makeResponse(makeAnswer(model, request)); } }, code === 0);
    assert.equal(calls.length, code === 0 ? 1 : 0);
    if (code !== 0) for (const number of sum > STATE_LIMIT ? [sum, STATE_LIMIT] : [body, BODY_LIMIT]) assert.match(result.stderr, new RegExp(`\\b${number}\\b`));
  }
});
describe('spec:typesafe-jev-bridge/S10 every missing facts line, manifest model and node exits 127 naming its cause', () => {
  it('reads missing facts before even invalid operands', (context) => {
    const fixture = makeFixture(context, true);
    const path = join(fixture.root, 'service-facts.txt');
    rmSync(path);
    for (const argv of [[fixture.path], [fixture.path, fixture.path]]) {
      const result = runWrapper(fixture, argv, 127, {}, false, true);
      for (const text of [path, '/agent-workflow-kit upgrade']) assert.ok(result.stderr.includes(text));
    }
  });
  it('names missing admitted facts fields', (context) => {
    const fixture = makeFixture(context, true);
    const path = join(fixture.root, 'service-facts.txt');
    for (const field of ['RUN_HOST', 'PASSED_VARIABLE']) {
      writeFileSync(path, getFacts().split('\n').filter((line) => !line.startsWith(`${field}=`)).join('\n'));
      const result = runWrapper(fixture, [fixture.path], 127);
      for (const text of [path, field]) assert.ok(result.stderr.includes(text));
    }
  });
  it('reports node absent from a complete PATH farm', (context) => {
    const fixture = makeFixture(context, true);
    const farm = join(fixture.root, 'path');
    mkdirSync(farm);
    const seen = new Set(['node']);
    for (const directory of (process.env.PATH ?? '').split(':').filter((path) => path && existsSync(path) && statSync(path).isDirectory())) {
      for (const name of readdirSync(directory)) if (!seen.has(name)) { seen.add(name); symlinkSync(join(directory, name), join(farm, name)); }
    }
    assert.ok(existsSync(join(farm, 'bash')));
    assert.equal(existsSync(join(farm, 'node')), false);
    runWrapper(fixture, [fixture.path], 127, { PATH: farm }, false, false, join(farm, 'bash'));
  });
  it('refuses absent, unparseable and posture-less manifests', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    const path = join(fixture.root, 'capability.json');
    for (const body of [null, '{not json', '{}', JSON.stringify({ posture: { model: '' } })]) {
      if (body === null) rmSync(path); else writeFileSync(path, body);
      const result = await runClient(cli, fixture, 127);
      assert.ok(result.stderr.includes(path));
    }
  });
});
describe('spec:typesafe-jev-bridge/S11 the posture line precedes the request and no byte carries the key', () => {
  it('flattens and redacts a rejection and its cause after the exact posture', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    const result = await runClient(cli, fixture, 8, { transport: async () => { throw new TypeError(`failed ${fixture.key}\nagain`, { cause: new Error(`cause ${fixture.key}\nagain`) }); } }, true);
    assert.equal(result.stderr.split('\n')[0], `judge posture: model=${getModel()} host=${HOST} timeout=10s`);
  });
  it('removes a key of any bytes from outside text before it is made one line or encoded', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    const broken = fixture.key.replace('-Q7', '\nQ7');
    const quoted = fixture.key.replace('-Q7', '"Q7');
    const assertNoKey = (result, key) => {
      for (const part of [...key.split(/["\n]/), JSON.stringify(key).slice(1, -1)]) assert.equal(`${result.stdout}${result.stderr}`.includes(part), false, 'key leaked');
    };
    assertNoKey(await runClient(cli, fixture, 8, { env: { [KEY_VARIABLE]: broken }, transport: async (url, init) => new Headers(init.headers) }, true), broken);
    assertNoKey(await runClient(cli, fixture, 7, { env: { [KEY_VARIABLE]: broken }, transport: async () => makeResponse(makeAnswer(`other-${broken}`)) }, true), broken);
    const result = await runClient(cli, fixture, 0, { env: { [KEY_VARIABLE]: quoted }, transport: async () => makeResponse(makeAnswer(getModel()), 200, { 'x-typesafe-request-id': `id-${quoted}` }) }, true);
    assertNoKey(result, quoted);
    assert.equal(JSON.parse(result.stdout).requestId.includes(quoted), false);
  });
  it('ends a defect inside the client in one scrubbed line', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    const result = await cli.runJudgeCli({ argv: fixture.argv, env: fixture.env, folder: 42, transport: neverCall });
    assertOutcome(result, fixture.key, 8);
  });
  it('gives node the key only through its environment', (context) => {
    const fixture = makeFixture(context, true);
    const recording = addRecordingNode(fixture);
    const preload = addPreload(fixture, makeAnswer(getModel()));
    runWrapper(fixture, [fixture.path], 0, { PATH: recording.PATH, NODE_OPTIONS: preload.NODE_OPTIONS }, true);
    assert.equal(read(recording.env), fixture.key);
    const argv = read(recording.argv);
    assert.equal(argv.includes(fixture.key), false);
    assert.deepEqual(argv.split('\n').slice(0, -1), [join(fixture.root, 'bin/jev-client.mjs'), ...fixture.argv]);
    assert.equal(read(preload.log), `${ENDPOINT}\n`);
  });
});
it('spec:typesafe-jev-bridge/S12 prints help and keeps the version and exact bundle consistent', (context) => {
  const fixture = makeFixture(context, true);
  const { version } = readManifest();
  for (const flag of ['--help', '-h']) { const result = runWrapper(fixture, [flag], 0); assert.match(result.stdout, /^Usage:$/m); for (const text of ['jev-ask', version]) assert.ok(result.stdout.includes(text)); }
  assert.equal(read(join(HERE, 'jev-ask.sh')).match(/^AW_BRIDGE_VERSION="([^"]+)"\s+# aw-version-anchor$/m)?.[1], version);
  const frontmatter = read(join(BRIDGE, 'SKILL.md')).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  assert.ok(frontmatter);
  assert.match(frontmatter, /^name:\s*['"]?typesafe-jev-bridge['"]?\s*$/m);
  assert.equal(frontmatter.match(/^metadata:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:\s*['"]?([^\s'"\n]+)['"]?\s*$/m)?.[1], version);
  assert.deepEqual(listFiles(BRIDGE), ['SKILL.md', 'bin/jev-ask.sh', 'bin/jev-ask.test.mjs', 'bin/jev-client.mjs', 'capability.json', 'setup/README.md']);
  const setup = read(join(BRIDGE, 'setup/README.md'));
  assert.ok(setup.includes('jev-connect.mjs'));
  assert.match(setup, /restart/i);
});
it('spec:typesafe-jev-bridge/S13 scans every shipped file and catches planted host and model literals', (context) => {
  const fixture = makeFixture(context);
  mkdirSync(join(fixture.root, 'bin'));
  writeFileSync(join(fixture.root, 'SKILL.md'), 'API.TypeSafe.AI');
  writeFileSync(join(fixture.root, 'bin/jev-client.mjs'), 'jev-1.13.0');
  assert.deepEqual(scanFolder(fixture.root).hits, ['SKILL.md: host', 'bin/jev-client.mjs: model']);
  const scanned = scanFolder(BRIDGE);
  assert.deepEqual(scanned.hits, []);
  for (const file of ['SKILL.md', 'bin/jev-ask.sh', 'bin/jev-client.mjs', 'setup/README.md']) assert.ok(scanned.files.includes(file), `scan did not read ${file}`);
});
it('spec:typesafe-jev-bridge/S15 forwards client outcomes unchanged for success and HTTP refusal', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context, true);
  for (const status of [200, 401]) {
    const body = status === 200 ? makeAnswer(getModel()) : { error: 'refused' };
    const code = status === 200 ? 0 : 5;
    const preload = addPreload(fixture, body, status);
    const wrapped = runWrapper(fixture, [fixture.path], code, { NODE_OPTIONS: preload.NODE_OPTIONS }, true);
    const direct = await runClient(cli, fixture, code, { transport: async () => makeResponse(body, status) }, true);
    assert.deepEqual(wrapped, direct);
    assert.equal(read(preload.log), `${ENDPOINT}\n`);
    rmSync(preload.log);
  }
});

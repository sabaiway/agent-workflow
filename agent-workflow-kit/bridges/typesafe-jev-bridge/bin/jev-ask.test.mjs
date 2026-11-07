import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  HERE, BRIDGE, REPO, HOST, ENDPOINT, KEY_VARIABLE, REQUEST_ID, STATE_LIMIT, BODY_LIMIT,
  client, read, readManifest, getModel, getFacts, makeQuestion, makeRequest, makeAnswer, makeResponse,
  neverCall, makeArgv, makePosture, writeManifest, writeSettings, makeFixture, assertOutcome,
  runClient, runWrapper, addPreload, addRecordingNode, listFiles, scanFolder,
} from './jev-ask-harness.test.mjs';

it('spec:typesafe-jev-bridge/S1 posts the pinned two-question request and prints only normalized notes', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  const model = getModel();
  for (const requestId of [REQUEST_ID, null]) {
    const calls = [];
    const answer = makeAnswer(model);
    const transport = async (...args) => { calls.push(args); return makeResponse(answer, 200, requestId ? { 'x-typesafe-request-id': requestId } : {}); };
    const result = await runClient(cli, fixture, 0, { env: { [KEY_VARIABLE]: `  ${fixture.key}  ` }, transport }, true);
    assert.equal(result.stderr, `${makePosture(model, 'default')}\n`);
    assert.match(result.stdout, /[^\n]\n$/);
    assert.deepEqual(JSON.parse(result.stdout), { model, calibrated: true, requestId, notes: Object.fromEntries(Object.entries(answer.answers).map(([id, { type, ...note }]) => [id, note])) });
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
    const result = runWrapper(fixture, [fixture.path], 127, { PATH: farm }, false, false, join(farm, 'bash'));
    assert.ok(result.stderr.includes('Node.js 22.21'), result.stderr);
  });
  it('refuses absent, unparseable and posture-less manifests', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    const path = join(fixture.root, 'capability.json');
    const manifest = { ...readManifest(), settings: [{ key: 'JEV_MODEL', kind: 'posture', default: getModel(), appliesTo: ['jev-ask'], effect: 'Selects the judge model.', offered: [getModel(), 'jev-1.14.0'] }] };
    const { settings, ...withoutSettings } = manifest;
    const { offered, ...withoutOffered } = settings[0];
    const invalid = [null, '{not json', {}, { posture: { model: '' } }, withoutSettings, { ...manifest, settings: [] },
      { ...manifest, settings: [withoutOffered] }, ...[[], 'jev-1.14.0', [13]].map((offered) => ({ ...manifest, settings: [{ ...settings[0], offered }] }))];
    for (const body of invalid) {
      if (body === null) rmSync(path); else writeManifest(fixture, body);
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
    assert.equal(result.stderr.split('\n')[0], makePosture(getModel(), 'default'));
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
    assert.deepEqual(argv.split('\n').slice(0, -1), ['--disable-warning=UNDICI-EHPA', join(fixture.root, 'bin/jev-client.mjs'), ...fixture.argv]);
    assert.equal(read(preload.log), `${JSON.stringify({ url: ENDPOINT, model: getModel() })}\n`);
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
  assert.deepEqual(listFiles(BRIDGE), ['SKILL.md', 'bin/jev-ask-harness.test.mjs', 'bin/jev-ask.sh', 'bin/jev-ask.test.mjs', 'bin/jev-client.mjs', 'capability.json', 'service-facts.txt', 'setup/README.md']);
  const setup = read(join(BRIDGE, 'setup/README.md'));
  assert.ok(setup.includes('jev-connect.mjs'));
  assert.match(setup, /restart/i);
  assert.match(setup, /Node(?:\.js)? 22\.21 or newer/);
});
it('spec:typesafe-jev-bridge/S13 scans every shipped file and catches planted host and model literals', (context) => {
  const fixture = makeFixture(context);
  mkdirSync(join(fixture.root, 'bin'));
  writeFileSync(join(fixture.root, 'SKILL.md'), 'API.TypeSafe.AI');
  for (const model of ['jev-1.13.0', 'jev-latest', 'jev-preview']) {
    writeFileSync(join(fixture.root, 'bin/jev-client.mjs'), model);
    assert.deepEqual(scanFolder(fixture.root).hits, ['SKILL.md: host', 'bin/jev-client.mjs: model']);
  }
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
    assert.equal(read(preload.log), `${JSON.stringify({ url: ENDPOINT, model: getModel() })}\n`);
    rmSync(preload.log);
  }
});
it('spec:typesafe-jev-bridge/S16 the wrapper reaches a loopback CONNECT proxy by its own switch and prints no key or proxy password', async (context) => {
  const fixture = makeFixture(context, true);
  const lines = [];
  const loopback = '127.0.0.1';
  const password = `proxy-${Buffer.from(context.name).toString('hex')}-${fixture.key.slice(-32)}`;
  const server = createServer((req, res) => {
    lines.push(`${req.method} ${req.url}`);
    res.writeHead(403);
    res.end();
  });
  server.on('connect', (req, socket) => {
    lines.push(`${req.method} ${req.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, loopback);
  try {
    await once(server, 'listening');
    const env = { PATH: process.env.PATH, HOME: fixture.env.HOME, [KEY_VARIABLE]: fixture.key,
      HTTPS_PROXY: `http://proxy-user:${password}@${loopback}:${server.address().port}` };
    const result = await new Promise((resolve, reject) => {
      const child = spawn('bash', [join(fixture.root, 'bin/jev-ask.sh'), fixture.path], { cwd: fixture.root, env });
      const stdout = [];
      const stderr = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
      });
    });
    assert.deepEqual(lines, [`CONNECT ${HOST}:443`]);
    assertOutcome(result, fixture.key, 8, true);
    for (const stream of [result.stdout, result.stderr]) assert.equal(stream.includes(password), false, 'proxy password leaked');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
describe('spec:typesafe-jev-bridge/S17 the wrapper selects the host model and reports its source', () => {
  const cases = [
    ['no setting', undefined, {}, getModel(), 'default', 0],
    ['file setting', 'jev-1.14.0', {}, 'jev-1.14.0', 'setting', 0],
    ['environment overrides file', 'jev-1.13.0', { JEV_MODEL: 'jev-1.14.0' }, 'jev-1.14.0', 'environment', 0],
    ['empty environment selects default', 'jev-1.14.0', { JEV_MODEL: '' }, getModel(), 'environment', 0],
    ['empty file warns', '', {}, getModel(), 'default', 1],
    ['control-byte file warns', 'jev-1.14.0\x01', {}, getModel(), 'default', 1],
  ];
  for (const [name, setting, overrides, model, source, warnings] of cases) it(name, (context) => {
    const fixture = makeFixture(context, true);
    if (setting !== undefined) writeSettings(fixture, `JEV_MODEL=${setting}\n`);
    const preload = addPreload(fixture, makeAnswer(model));
    const calibrated = model === getModel();
    const result = runWrapper(fixture, [fixture.path], 0, { ...overrides, NODE_OPTIONS: preload.NODE_OPTIONS }, true, false, 'bash', warnings);
    assert.equal(result.stderr.split('\n')[warnings], makePosture(model, source, calibrated));
    assert.deepEqual(read(preload.log).trim().split('\n').map((line) => JSON.parse(line)), [{ url: ENDPOINT, model }]);
    assert.equal(JSON.parse(result.stdout).model, model);
    assert.equal(JSON.parse(result.stdout).calibrated, calibrated);
    if (warnings) assert.doesNotMatch(result.stderr.split('\n')[0], /[\x00-\x1f\x7f-\x9f\u2028\u2029]|''/u);
  });
});
describe('spec:typesafe-jev-bridge/S18 unoffered models fail before reading the request and invalid sources fail usage', () => {
  for (const source of ['setting', 'environment']) for (const model of ['jev-0.0.1', 'jev-latest', 'jev-preview']) it(`${source}: ${model}`, (context) => {
    const fixture = makeFixture(context, true);
    const path = join(fixture.root, 'absent-request.json');
    if (source === 'setting') writeSettings(fixture, `JEV_MODEL=${model}\n`);
    const result = runWrapper(fixture, [path], 2, source === 'environment' ? { JEV_MODEL: model } : {});
    assert.match(result.stderr, /^jev-ask: /);
    for (const text of [model, getModel(), 'jev-1.14.0', 'JEV_MODEL=', '/agent-workflow-kit bridge-settings']) assert.ok(result.stderr.includes(text), result.stderr);
    if (source === 'environment') assert.ok(result.stderr.includes('unset'), result.stderr);
    assert.equal(result.stderr.includes(path), false, result.stderr);
    assert.doesNotMatch(result.stderr, /request file/i);
  });
  for (const source of ['setting', 'environment']) it(`the client names the offered list and the remedy for ${source}`, async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    const result = await runClient(cli, fixture, 2, { argv: makeArgv(fixture, { model: 'jev-0.0.1', source }) });
    for (const text of ['jev-0.0.1', getModel(), 'jev-1.14.0', 'JEV_MODEL=', '/agent-workflow-kit bridge-settings']) assert.ok(result.stderr.includes(text), result.stderr);
    assert.equal(result.stderr.includes('unset JEV_MODEL'), source === 'environment', result.stderr);
  });
  it('refuses a source outside default, setting and environment', async (context) => {
    const cli = await client();
    const fixture = makeFixture(context);
    await runClient(cli, fixture, 2, { argv: makeArgv(fixture, { source: 'flag' }) });
  });
});
it('spec:typesafe-jev-bridge/S19 offered versions mark only the default model as calibrated', async (context) => {
  const cli = await client();
  const fixture = makeFixture(context);
  for (const [model, source, calibrated] of [['jev-1.14.0', 'setting', false], [getModel(), 'default', true]]) {
    const models = [];
    const result = await runClient(cli, fixture, 0, { argv: makeArgv(fixture, { model, source }), transport: async (url, init) => {
      models.push(JSON.parse(init.body).model);
      return makeResponse(makeAnswer(model));
    } }, true);
    assert.deepEqual(models, [model]);
    assert.equal(result.stderr, `${makePosture(model, source, calibrated)}\n`);
    assert.equal(JSON.parse(result.stdout).model, model);
    assert.equal(JSON.parse(result.stdout).calibrated, calibrated);
    if (calibrated) assert.doesNotMatch(result.stderr, /uncalibrated/);
  }
});
it('spec:typesafe-jev-bridge/S20 the manifest offers pinned judge versions and rejects aliases', () => {
  const checkManifest = (manifest) => {
    const setting = manifest.settings?.find((entry) => entry.key === 'JEV_MODEL');
    assert.ok(setting, 'capability.json JEV_MODEL entry is absent');
    assert.equal(setting.kind, 'posture');
    assert.equal(setting.default, manifest.posture.model);
    assert.deepEqual(setting.appliesTo, ['jev-ask']);
    assert.ok(Array.isArray(setting.offered));
    assert.ok(setting.offered.includes(manifest.posture.model));
    for (const model of setting.offered) { assert.equal(typeof model, 'string'); assert.match(model, /^jev-\d+\.\d+\.\d+$/); }
    for (const alias of ['jev-latest', 'jev-preview']) assert.equal(setting.offered.includes(alias), false);
  };
  const manifest = readManifest();
  checkManifest(manifest);
  const copy = structuredClone(manifest);
  copy.settings.find((entry) => entry.key === 'JEV_MODEL').offered.push('jev-latest');
  assert.throws(() => checkManifest(copy), assert.AssertionError);
});

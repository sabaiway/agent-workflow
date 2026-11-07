import { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = resolve(HERE, '..');
export const REPO = resolve(BRIDGE, '..');
export const HOST = 'api.jev.invalid';
export const ENDPOINT = `https://${HOST}/v1/systemone`;
export const KEY_VARIABLE = 'TYPESAFE_API_KEY';
export const REQUEST_ID = 'req-1';
export const STATE_LIMIT = 30000;
export const BODY_LIMIT = 60000;
const made = [];
export const client = () => import('./jev-client.mjs');
export const read = (path) => readFileSync(path, 'utf8');
export const readManifest = () => JSON.parse(read(join(BRIDGE, 'capability.json')));
export const getModel = () => { const model = readManifest().posture?.model; assert.ok(model, 'capability.json posture.model is absent'); return model; };
export const getFacts = () => [read(join(REPO, 'codex-cli-bridge/service-facts.txt')).split('\n')[0], `HOST=${HOST}`, `RUN_HOST=${HOST}`, `PASSED_VARIABLE=${KEY_VARIABLE}`, ''].join('\n');
export const makeQuestion = (instructions = 'Choose the supported option.') => ({ type: 'choice', instructions, criteria: { yes: 'Supported', no: 'Unsupported' } });
export const makeRequest = () => ({ state: 'The build passed and the change is ready for review.', questions: { ready: makeQuestion(), safe: { ...makeQuestion(), criteria: { yes: 'Safe', no: 'Unsafe', unsure: 'Unclear' } } } });
export const makeAnswer = (model, request = makeRequest()) => ({ model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, { type: 'choice', choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((option, index) => [option, index === 0 ? 1 : 0])), confidence: 0.9 }])) });
export const makeResponse = (body, status = 200, headers = { 'x-typesafe-request-id': REQUEST_ID }) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
export const neverCall = () => assert.fail('transport must not be called');
export const makeArgv = (fixture, { model = '', source = 'default' } = {}) => ['--host', HOST, '--key-variable', KEY_VARIABLE, '--model', model, '--model-source', source, fixture.path];
export const makePosture = (model, source, calibrated = true) => `judge posture: model=${model} source=model:${source} ${calibrated ? '' : 'uncalibrated '}host=${HOST} timeout=10s`;
export const writeManifest = (fixture, manifest) => writeFileSync(join(fixture.root, 'capability.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
export const writeSettings = (fixture, text) => {
  const folder = join(fixture.env.HOME, '.config/agent-workflow');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'bridge-settings.conf');
  writeFileSync(path, text);
  return path;
};
export const makeFixture = (context, wrapper = false) => {
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
  return { root, path, key, env, argv: makeArgv({ path }) };
};
after(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })));
export const assertOutcome = (result, key, code, posture = false, shared = false, warnings = 0) => {
  assert.equal(result.code, code, result.stderr);
  for (const stream of [result.stdout, result.stderr]) { assert.equal(typeof stream, 'string'); assert.equal(stream.includes(key.trim()), false, 'key leaked'); }
  const lines = result.stderr === '' ? [] : result.stderr.split('\n').slice(0, -1);
  assert.equal(result.stderr, lines.length ? `${lines.join('\n')}\n` : '');
  assert.equal(lines.length, warnings + Number(posture) + Number(code !== 0), result.stderr);
  for (const line of lines.slice(0, warnings)) {
    assert.match(line, /^warning: /);
    assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u);
  }
  if (posture) assert.match(lines[warnings], /^judge posture: /);
  if (code !== 0) { assert.equal(result.stdout, ''); assert.match(lines.at(-1), shared ? /^error: / : /^jev-ask: /); }
  return result;
};
export const runClient = async (cli, fixture, code, options = {}, posture = false, warnings = 0) => {
  const calls = [];
  const transport = (...args) => { calls.push(args); return (options.transport ?? neverCall)(...args); };
  const result = await cli.runJudgeCli({ argv: fixture.argv, env: fixture.env, folder: fixture.root, ...options, transport });
  assertOutcome(result, fixture.key, code, posture, false, warnings);
  assert.equal(calls.length, Number(posture), 'one request only after posture');
  return result;
};
export const runWrapper = (fixture, argv, code, overrides = {}, posture = false, shared = false, bash = 'bash', warnings = 0) => {
  const result = spawnSync(bash, [join(fixture.root, 'bin/jev-ask.sh'), ...argv], { cwd: fixture.root, env: { ...fixture.env, ...overrides }, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return assertOutcome({ code: result.status, stdout: result.stdout, stderr: result.stderr }, fixture.key, code, posture, shared, warnings);
};
export const addPreload = (fixture, body, status = 200) => {
  const log = join(fixture.root, 'fetch.log');
  const preload = join(fixture.root, 'preload.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';\nglobalThis.fetch = async (url, init) => { appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), model: JSON.parse(init.body).model }) + '\\n'); return new Response(${JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))}, { status: ${status}, headers: { 'x-typesafe-request-id': '${REQUEST_ID}' } }); };\n`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, log };
};
export const addRecordingNode = (fixture) => {
  const bin = join(fixture.root, 'recording');
  mkdirSync(bin);
  const argv = join(fixture.root, 'node.argv');
  const env = join(fixture.root, 'node.env');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${quote(argv)}\nprintf '%s' "\${TYPESAFE_API_KEY-}" > ${quote(env)}\nexec ${quote(process.execPath)} "$@"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  return { PATH: `${bin}:${fixture.env.PATH}`, argv, env };
};
export const listFiles = (root, relative = '') => readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => entry.name === 'node_modules' ? [] : entry.isDirectory() ? listFiles(root, join(relative, entry.name)) : [join(relative, entry.name)]).sort();
export const scanFolder = (root) => {
  const files = listFiles(root).filter((file) => !file.endsWith('.test.mjs'));
  const hits = files.flatMap((file) => {
    const text = read(join(root, file));
    return [file !== 'service-facts.txt' && /[a-z0-9.-]*typesafe\.ai\b/i.test(text) ? `${file}: host` : null, file !== 'capability.json' && /\bjev-(?:\d+(?:\.\d+)*|latest|preview)\b/i.test(text) ? `${file}: model` : null].filter(Boolean);
  });
  return { files, hits };
};

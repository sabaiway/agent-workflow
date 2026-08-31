import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROCESS_DEADLINE_MS, runProcess } from './git-process.mjs';
import { buildSanitizedEnv } from './smoke-init.mjs';

const NPM_COMMAND = 'npm';
const TEMP_PREFIX = 'agent-workflow-npm-view-';
// Two files, not one: npm 12 refuses to load the same path as both the user and the global config
// ("double-loading config … as global, previously loaded as user", exit 1 before any request).
const EMPTY_USER_CONFIG_BASENAME = 'empty-user.npmrc';
const EMPTY_GLOBAL_CONFIG_BASENAME = 'empty-global.npmrc';
const HTTP_CODE_PATTERN = /^E(\d{3})$/;
const CREDENTIAL_VARS = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN']);

export const NPM_VIEW_ARGS = Object.freeze([
  'view',
  'version',
  '--json',
  '--registry=https://registry.npmjs.org/',
]);

export const NPM_TRANSPORT_CODES = Object.freeze([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'EPROTO',
  'FETCH_ERROR',
  'ERR_SOCKET_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readEnvelope = ({ stdout = '', stderr = '' }) =>
  [stdout, stderr, `${stdout}${stderr}`]
    .map((text) => parseJson(text.trim()))
    .find((body) => body && typeof body === 'object' && !Array.isArray(body) && body.error && typeof body.error === 'object');

const describeLocalFailure = ({ status, stdout = '', stderr = '', error, signal }, envelope) => {
  if (error) return `${error.code ?? error.name ?? 'spawn error'}: ${error.message}`;
  if (signal) return `killed by ${signal} outside the deadline`;
  if (envelope?.error?.code) return `npm error code ${envelope.error.code}`;
  const output = `${stdout}\n${stderr}`.trim();
  return output === '' ? `exit ${status} without an npm JSON error envelope` : `exit ${status}: ${output}`;
};

const classifyResult = (result, deadlineMs) => {
  if (result.status === 0) {
    const body = parseJson(result.stdout);
    if (typeof body === 'string') return { version: body };
    if (Array.isArray(body) && body.length === 1 && typeof body[0] === 'string') return { version: body[0] };
    return { parseError: body === null ? 'invalid JSON' : 'expected a JSON string or one-string array' };
  }
  if (result.killedByDeadline === true) return { transportError: `timeout after ${deadlineMs}ms` };
  const envelope = readEnvelope(result);
  const http = typeof envelope?.error?.code === 'string' ? envelope.error.code.match(HTTP_CODE_PATTERN) : null;
  if (http) return { httpError: Number(http[1]) };
  const code = result.error?.code ?? envelope?.error?.code;
  if (NPM_TRANSPORT_CODES.includes(code)) return { transportError: code };
  throw new Error(`local npm failure: ${describeLocalFailure(result, envelope)}`);
};

export const npmViewLatest = async (name, { exec = runProcess, deadlineMs = PROCESS_DEADLINE_MS } = {}) => {
  const cwd = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const userConfigPath = join(cwd, EMPTY_USER_CONFIG_BASENAME);
  const globalConfigPath = join(cwd, EMPTY_GLOBAL_CONFIG_BASENAME);
  try {
    await writeFile(userConfigPath, '');
    await writeFile(globalConfigPath, '');
    const env = buildSanitizedEnv(process.env, { home: cwd, npmCache: cwd });
    for (const key of CREDENTIAL_VARS) delete env[key];
    const argv = [
      NPM_VIEW_ARGS[0],
      `${name}@latest`,
      ...NPM_VIEW_ARGS.slice(1),
      `--userconfig=${userConfigPath}`,
      `--globalconfig=${globalConfigPath}`,
    ];
    const result = await Promise.resolve()
      .then(() => exec(NPM_COMMAND, argv, { cwd, env, deadlineMs }))
      .catch((error) => { throw new Error(`local npm failure: ${error.message}`); });
    return classifyResult(result, deadlineMs);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

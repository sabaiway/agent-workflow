export const GIT_LOCATION_VARS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']);
export const READ_ARGV = Object.freeze(['--no-pager', 'config', '--no-includes', '--show-scope', '-z', '--get-regexp',
  '^(http\\.(.+\\.)?proxyauthmethod|credential\\.(.+\\.)?helper)$']);
export const PROXY_VARIABLES = Object.freeze(['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']);

const NUL_BYTE = 0;
const LINE_FEED_BYTE = 0x0a;
const RECORD_FIELD_COUNT = 2;
const CREDENTIAL_PREFIX = 'credential.';
const HELPER_SUFFIX = '.helper';
const WARN_PREFIX = 'release-run: the git transport config was not carried — ';

export const readEnv = (inheritedEnv) => ({
  ...Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !GIT_LOCATION_VARS.includes(key) && key !== 'GIT_CONFIG')),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
});

export const parseRecords = (stdout) => {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== NUL_BYTE) return null;
  const boundaries = [-1, ...Array.from(bytes.entries()).filter(([, byte]) => byte === NUL_BYTE).map(([index]) => index)];
  const fields = boundaries.slice(0, -1).map((boundary, index) => bytes.subarray(boundary + 1, boundaries[index + 1]));
  if (fields.length % RECORD_FIELD_COUNT !== 0) return null;
  const records = fields.filter((_, index) => index % RECORD_FIELD_COUNT === 0).map((scopeBytes, index) => {
    const entryBytes = fields[index * RECORD_FIELD_COUNT + 1];
    const separator = entryBytes.indexOf(LINE_FEED_BYTE);
    const keyBytes = separator === -1 ? entryBytes : entryBytes.subarray(0, separator);
    if (scopeBytes.length === 0 || keyBytes.length === 0) return null;
    const valueBytes = separator === -1 ? null : entryBytes.subarray(separator + 1);
    const key = keyBytes.toString('utf8');
    const value = valueBytes === null ? null : valueBytes.toString('utf8');
    if (!Buffer.from(key, 'utf8').equals(keyBytes) || (valueBytes !== null && !Buffer.from(value, 'utf8').equals(valueBytes))) return undefined;
    return { scope: scopeBytes.toString('utf8'), key, value };
  });
  return records.includes(null) ? null : records.filter((record) => record !== undefined);
};

export const proxyOrigins = (env) => [...new Set(PROXY_VARIABLES.flatMap((key) => {
  try {
    const proxy = new URL(env[key]);
    return proxy.host !== '' && !proxy.host.includes('*') ? [`${proxy.protocol}//${proxy.host}`] : [];
  } catch { return []; }
}))];

export const isCarried = (record, origins) => record.scope === 'command' && (
  (/^http\.(?:.+\.)?proxyauthmethod$/u.test(record.key) && record.value !== null)
  || (record.key.startsWith(CREDENTIAL_PREFIX) && record.key.endsWith(HELPER_SUFFIX) && record.value === ''
    && origins.includes(record.key.slice(CREDENTIAL_PREFIX.length, -HELPER_SUFFIX.length)))
);

export const serialize = (records) => records.length === 0 ? {} : {
  GIT_CONFIG_COUNT: String(records.length),
  ...Object.fromEntries(records.flatMap(({ key, value }, index) => [
    [`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value],
  ])),
};

export const redactLine = (text) => text.replace(/:\/\/[^/\s]*/gu, '://<redacted>').split('\n')[0]
  .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/gu, '?');

export const carryTransportConfig = async (inheritedEnv, { git, cwd, warn }) => {
  const result = await git(READ_ARGV, { cwd, env: readEnv(inheritedEnv), encoding: null });
  const warnFailure = (cause) => { warn(WARN_PREFIX + redactLine(String(cause))); return {}; };
  if (result.error) return warnFailure(result.error.code ?? result.error.message);
  if (result.status === null) return warnFailure(`signal ${result.signal}`);
  if (result.status === 1) return {};
  if (result.status !== 0) return warnFailure(`exit ${result.status}: ${redactLine(String(result.stderr))}`);
  const records = parseRecords(result.stdout);
  if (records === null) return warnFailure('exit 0: the output did not parse');
  const origins = proxyOrigins(inheritedEnv);
  return serialize(records.filter((record) => isCarried(record, origins)));
};

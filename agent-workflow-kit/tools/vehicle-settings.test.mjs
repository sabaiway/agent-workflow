import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = './vehicle-settings.mjs';
const ENSURE_MODULE_PATH = './ensure-ops.mjs';
const VOCABULARY_MODULE_PATH = './ensure-vocabulary.mjs';
const EXPORT_NAMES = Object.freeze({
  path: 'VEHICLES_REL', defaults: 'EXECUTOR_DEFAULTS', validate: 'validateVehicles',
  read: 'readVehicles', load: 'loadVehicles', resolve: 'resolveExecutor',
  ensure: 'ensureVehicles', implementations: 'OWN_IMPLEMENTATIONS', operations: 'ENSURE_OPS',
});
const ABSENT_PREFIX = 'absent: ';
const absent = (name) => () => { throw new Error(`${ABSENT_PREFIX}${name}`); };
const loaded = await import(MODULE_PATH).catch(() => ({}));
const loadedEnsures = await import(ENSURE_MODULE_PATH).catch(() => ({}));
const loadedVocabulary = await import(VOCABULARY_MODULE_PATH).catch(() => ({}));
const VEHICLES_REL = loaded.VEHICLES_REL ?? absent(EXPORT_NAMES.path);
const EXECUTOR_DEFAULTS = loaded.EXECUTOR_DEFAULTS ?? absent(EXPORT_NAMES.defaults);
const validateVehicles = loaded.validateVehicles ?? absent(EXPORT_NAMES.validate);
const readVehicles = loaded.readVehicles ?? absent(EXPORT_NAMES.read);
const loadVehicles = loaded.loadVehicles ?? absent(EXPORT_NAMES.load);
const resolveExecutor = loaded.resolveExecutor ?? absent(EXPORT_NAMES.resolve);
const ensureVehicles = loadedEnsures.ensureVehicles ?? absent(EXPORT_NAMES.ensure);
const OWN_IMPLEMENTATIONS = loadedEnsures.OWN_IMPLEMENTATIONS ?? absent(EXPORT_NAMES.implementations);
const ENSURE_OPS = loadedVocabulary.ENSURE_OPS ?? absent(EXPORT_NAMES.operations);

const SETTINGS_REL = 'docs/ai/vehicles.json';
const DEPLOYMENT_REL = 'docs/ai';
const PARENT_REL = '..';
const TEMPLATE_REL = 'references/templates/vehicles.json';
const LINK_TARGET_REL = 'target.json';
const DIRECTORY_SENTINEL = 'preserved.txt';
const TEMP_PREFIX = 'vehicle-settings-';
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), PARENT_REL);
const ENCODING = 'utf8';
const STRING_TYPE = 'string';
const README_KEY = '_README';
const EXECUTOR_KEY = 'executor';
const EXECUTOR_KEYS = Object.freeze(['model', 'effort', 'fallback']);
const MODEL_KEY = 'model';
const FALLBACK_KEY = 'fallback';
const UNKNOWN_KEY = 'surprise';
const UNKNOWN_STATE = 'unexpected';
const EXPECTED_DEFAULTS = Object.freeze({ model: 'opus', effort: 'high', fallback: 'sonnet' });
const CUSTOM_EXECUTOR = Object.freeze({ model: 'primary.v2', effort: 'medium', fallback: 'backup-model_1' });
const README = 'Hand edited project settings.';
const VALID_BODY = Object.freeze({ _README: README, executor: CUSTOM_EXECUTOR });
const PRESENT = 'present';
const ABSENT = 'absent';
const UNREADABLE = 'unreadable';
const FILE_SOURCE = 'file';
const DEFAULT_SOURCE = 'default';
const VEHICLES_OP = 'vehicles';
const AUTONOMY_OP = 'autonomy';
const SEEDED = 'seeded';
const ALREADY_PRESENT = 'already-present';
const WOULD_SEED = 'would-seed';
const FAILED = 'failed';
const EXPECTED_OPS = Object.freeze(['orchestration', 'gates', AUTONOMY_OP, VEHICLES_OP, 'scripts', 'specs', 'index']);
const OP_COUNT = 7;
const VEHICLES_INDEX = 3;
const AUTONOMY_INDEX = 2;
const FIRST_INDEX = 0;
const EXIT_FAILURE = 1;
const PERMISSION_CODE = 'EACCES';
const LSTAT_EVENT = 'lstat';
const READ_EVENT = 'readFile';
const DIRECTORY_KIND = 'directory';
const OTHER_KIND = 'other';
const DANGLING_KIND = 'dangling';
const SYMLINK_KIND = 'symlink';
const READ_ERROR_KIND = 'read-error';
const LSTAT_ERROR_KIND = 'lstat-error';
const NON_OBJECT_STRING = 'scalar';
const NON_OBJECT_NUMBER = 42;
const EMPTY_TOKEN = '';
const BAD_TOKENS = Object.freeze(['two words', '-leading', 'bad/token']);
const INVALID_JSON = '{"executor":';
const AUTHORED_BYTES = '  {"executor": "keep this malformed declaration"}\n';
const SENTINEL_BYTES = 'keep me\n';
const NON_OBJECT_REASON = /\b(?:object|array|null|string|number|scalar|42)\b/;
const PARSE_REASON = /\b(?:JSON|parse|Unexpected|unexpected|Expected|expected)\b/;
const DIRECTORY_REASON = /\bdirectory\b/;
const OTHER_REASON = /\bnot a regular file\b/;
const SYMLINK_REASON = /\bsymlink\b/;
const PERMISSION_REASON = /\bEACCES\b/;
const WRONG_KIND_REASON = /^wrong-node-kind\b/;
const TEMPLATE_REASON = /^template-unreadable\b/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const REGEX_ESCAPE = '\\$&';
const WORD_BOUNDARY = '\\b';

const matchWord = (word) => new RegExp(`${WORD_BOUNDARY}${word.replace(REGEX_SPECIAL, REGEX_ESCAPE)}${WORD_BOUNDARY}`);
const withProject = (run) => {
  const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  try {
    mkdirSync(join(directory, DEPLOYMENT_REL), { recursive: true });
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const writeSettings = (directory, value) => writeFileSync(join(directory, SETTINGS_REL), JSON.stringify(value));
const throwPermission = () => { throw Object.assign(new Error(PERMISSION_CODE), { code: PERMISSION_CODE }); };
const assertReason = (reason, expectedWord) => {
  assert.equal(typeof reason, STRING_TYPE);
  assert.ok(reason.includes(SETTINGS_REL), reason);
  assert.match(reason, expectedWord);
};
const assertLoadFailure = (run, reason) => assert.throws(run, (error) => {
  assert.ok(error instanceof Error);
  assert.equal(error.exitCode, EXIT_FAILURE);
  assert.equal(error.message, reason);
  return true;
});
const assertUnreadable = (answer, expectedWord) => {
  assert.equal(answer.state, UNREADABLE);
  assert.notEqual(answer.state, ABSENT);
  assertReason(answer.reason, expectedWord);
  assert.deepEqual(resolveExecutor(answer), { posture: null, reason: answer.reason });
};
const assertOutcome = (answer, token, cause) => {
  assert.equal(answer.op, VEHICLES_OP);
  assert.equal(answer.token, token);
  assert.equal(answer.failed, token === FAILED);
  assert.ok(Array.isArray(answer.lines));
  for (const line of answer.lines) assert.equal(typeof line, STRING_TYPE);
  if (cause) assert.match(answer.lines[FIRST_INDEX], cause);
};

it('reads and resolves authored values (spec:vehicle-settings/S1)', () => {
  withProject((directory) => {
    writeSettings(directory, VALID_BODY);
    const answer = readVehicles(directory);
    const settings = { executor: CUSTOM_EXECUTOR };
    assert.deepEqual(answer, { state: PRESENT, settings });
    assert.deepEqual(resolveExecutor(answer), {
      posture: { ...CUSTOM_EXECUTOR, source: FILE_SOURCE }, reason: null,
    });
    assert.deepEqual(loadVehicles(directory), answer);
    assert.deepEqual(validateVehicles(VALID_BODY), { ok: true, settings });
    assert.deepEqual(validateVehicles(settings), { ok: true, settings });
    assert.equal(VEHICLES_REL, SETTINGS_REL);
    assert.deepEqual(Object.keys(loaded).sort(), [
      EXPORT_NAMES.path, EXPORT_NAMES.defaults, EXPORT_NAMES.validate,
      EXPORT_NAMES.read, EXPORT_NAMES.load, EXPORT_NAMES.resolve,
    ].sort());
  });
});

it('resolves absence to frozen defaults and pins the seed (spec:vehicle-settings/S2)', () => {
  withProject((directory) => {
    const answer = readVehicles(directory);
    assert.deepEqual(answer, { state: ABSENT });
    assert.deepEqual(loadVehicles(directory), answer);
    assert.deepEqual(EXECUTOR_DEFAULTS, EXPECTED_DEFAULTS);
    assert.equal(Object.isFrozen(EXECUTOR_DEFAULTS), true);
    assert.deepEqual(resolveExecutor(answer), {
      posture: { ...EXECUTOR_DEFAULTS, source: DEFAULT_SOURCE }, reason: null,
    });
    const template = JSON.parse(readFileSync(join(KIT_ROOT, TEMPLATE_REL), ENCODING));
    assert.deepEqual(Object.keys(template), [README_KEY, EXECUTOR_KEY]);
    assert.equal(typeof template._README, STRING_TYPE);
    assert.deepEqual(template.executor, EXECUTOR_DEFAULTS);
    assert.equal(existsSync(join(directory, SETTINGS_REL)), false);
  });
});

it('refuses every malformed form without a posture (spec:vehicle-settings/S3)', () => {
  const nonObjects = [[], null, NON_OBJECT_STRING, NON_OBJECT_NUMBER];
  const malformed = [
    ...nonObjects.map((value) => ({ value, reason: NON_OBJECT_REASON })),
    { value: { ...VALID_BODY, [UNKNOWN_KEY]: true }, reason: matchWord(UNKNOWN_KEY) },
    { value: { ...VALID_BODY, [README_KEY]: false }, reason: matchWord(README_KEY) },
    { value: {}, reason: matchWord(EXECUTOR_KEY) },
    ...nonObjects.map((executor) => ({ value: { executor }, reason: matchWord(EXECUTOR_KEY) })),
    ...EXECUTOR_KEYS.map((missingKey) => ({
      value: { executor: Object.fromEntries(Object.entries(CUSTOM_EXECUTOR).filter(([key]) => key !== missingKey)) },
      reason: matchWord(missingKey),
    })),
    { value: { executor: { ...CUSTOM_EXECUTOR, [UNKNOWN_KEY]: true } }, reason: matchWord(UNKNOWN_KEY) },
    ...EXECUTOR_KEYS.flatMap((key) => [false, EMPTY_TOKEN, ...BAD_TOKENS].map((value) => ({
      value: { executor: { ...CUSTOM_EXECUTOR, [key]: value } }, reason: matchWord(key),
    }))),
    { value: { executor: { ...CUSTOM_EXECUTOR, [FALLBACK_KEY]: CUSTOM_EXECUTOR[MODEL_KEY] } }, reason: matchWord(FALLBACK_KEY) },
  ];
  for (const { value, reason } of malformed) {
    withProject((directory) => {
      writeSettings(directory, value);
      const answer = readVehicles(directory);
      assertUnreadable(answer, reason);
      assertLoadFailure(() => loadVehicles(directory), answer.reason);
      const validation = validateVehicles(value);
      assert.equal(validation.ok, false);
      assertReason(validation.reason, reason);
      assert.equal(answer.reason, validation.reason);
    });
  }
  withProject((directory) => {
    writeFileSync(join(directory, SETTINGS_REL), INVALID_JSON);
    const answer = readVehicles(directory);
    assertUnreadable(answer, PARSE_REASON);
    assertLoadFailure(() => loadVehicles(directory), answer.reason);
  });
  assert.throws(() => resolveExecutor({ state: UNKNOWN_STATE }), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.exitCode, EXIT_FAILURE);
    assert.match(error.message, matchWord(UNKNOWN_STATE));
    return true;
  });
});

it('refuses node kinds and IO errors before following links (spec:vehicle-settings/S4)', () => {
  const cases = [
    { kind: DIRECTORY_KIND, reason: DIRECTORY_REASON, events: [LSTAT_EVENT] },
    { kind: OTHER_KIND, reason: OTHER_REASON, events: [LSTAT_EVENT] },
    { kind: DANGLING_KIND, reason: SYMLINK_REASON, events: [LSTAT_EVENT] },
    { kind: SYMLINK_KIND, reason: SYMLINK_REASON, events: [LSTAT_EVENT] },
    { kind: READ_ERROR_KIND, reason: PERMISSION_REASON, events: [LSTAT_EVENT, READ_EVENT] },
    { kind: LSTAT_ERROR_KIND, reason: PERMISSION_REASON, events: [LSTAT_EVENT] },
  ];
  for (const { kind, reason, events } of cases) {
    withProject((directory) => {
      const settingsPath = join(directory, SETTINGS_REL);
      const targetPath = join(directory, LINK_TARGET_REL);
      if (kind === DIRECTORY_KIND) mkdirSync(settingsPath);
      else if (kind === DANGLING_KIND || kind === SYMLINK_KIND) {
        if (kind === SYMLINK_KIND) writeFileSync(targetPath, JSON.stringify(VALID_BODY));
        symlinkSync(targetPath, settingsPath);
      } else writeSettings(directory, VALID_BODY);
      const calls = [];
      const probeEntry = (path) => {
        calls.push(LSTAT_EVENT);
        assert.equal(path, settingsPath);
        if (kind === LSTAT_ERROR_KIND) return throwPermission();
        if (kind === OTHER_KIND) return {
          isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false,
        };
        return lstatSync(path);
      };
      const readBody = (path, encoding) => {
        calls.push(READ_EVENT);
        assert.equal(path, settingsPath);
        if (kind === READ_ERROR_KIND) return throwPermission();
        return readFileSync(path, encoding);
      };
      const answer = readVehicles(directory, readBody, probeEntry);
      assertUnreadable(answer, reason);
      assert.deepEqual(calls, events);
      assertLoadFailure(() => loadVehicles(directory, readBody, probeEntry), answer.reason);
      assert.deepEqual(calls, [...events, ...events]);
    });
  }
});

it('seeds once, preserves authored bytes and owns the fourth slot (spec:vehicle-settings/S5)', () => {
  withProject((directory) => {
    const answer = ensureVehicles({ cwd: directory, kitRoot: KIT_ROOT });
    assertOutcome(answer, SEEDED);
    const settingsPath = join(directory, SETTINGS_REL);
    const seededBytes = readFileSync(settingsPath);
    assert.deepEqual(seededBytes, readFileSync(join(KIT_ROOT, TEMPLATE_REL)));
    assertOutcome(ensureVehicles({ cwd: directory, kitRoot: KIT_ROOT }), ALREADY_PRESENT);
    assert.deepEqual(readFileSync(settingsPath), seededBytes);
  });
  withProject((directory) => {
    const settingsPath = join(directory, SETTINGS_REL);
    writeFileSync(settingsPath, AUTHORED_BYTES);
    const reads = [];
    const readBody = (path, encoding) => {
      reads.push(path);
      return readFileSync(path, encoding);
    };
    const answer = ensureVehicles({ cwd: directory, kitRoot: KIT_ROOT, deps: { readFile: readBody } });
    assertOutcome(answer, ALREADY_PRESENT);
    assert.deepEqual(reads, []);
    assert.deepEqual(readFileSync(settingsPath), Buffer.from(AUTHORED_BYTES));
  });
  withProject((directory) => {
    const settingsPath = join(directory, SETTINGS_REL);
    mkdirSync(settingsPath);
    writeFileSync(join(settingsPath, DIRECTORY_SENTINEL), SENTINEL_BYTES);
    const before = readdirSync(join(directory, DEPLOYMENT_REL));
    const answer = ensureVehicles({ cwd: directory, kitRoot: KIT_ROOT });
    assertOutcome(answer, FAILED, WRONG_KIND_REASON);
    assert.equal(lstatSync(settingsPath).isDirectory(), true);
    assert.deepEqual(readdirSync(join(directory, DEPLOYMENT_REL)), before);
    assert.deepEqual(readdirSync(settingsPath), [DIRECTORY_SENTINEL]);
    assert.equal(readFileSync(join(settingsPath, DIRECTORY_SENTINEL), ENCODING), SENTINEL_BYTES);
  });
  withProject((directory) => {
    const before = readdirSync(join(directory, DEPLOYMENT_REL));
    assertOutcome(ensureVehicles({ cwd: directory, kitRoot: KIT_ROOT, dryRun: true }), WOULD_SEED);
    assert.equal(existsSync(join(directory, SETTINGS_REL)), false);
    assert.deepEqual(readdirSync(join(directory, DEPLOYMENT_REL)), before);
  });
  withProject((directory) => {
    const answer = ensureVehicles({ cwd: directory, kitRoot: KIT_ROOT, deps: { readFile: throwPermission } });
    assertOutcome(answer, FAILED, TEMPLATE_REASON);
    assert.equal(existsSync(join(directory, SETTINGS_REL)), false);
    assert.deepEqual(readdirSync(join(directory, DEPLOYMENT_REL)), []);
  });
  assert.equal(OWN_IMPLEMENTATIONS.vehicles, ensureVehicles);
  assert.deepEqual(ENSURE_OPS, EXPECTED_OPS);
  assert.equal(ENSURE_OPS.length, OP_COUNT);
  assert.equal(ENSURE_OPS[VEHICLES_INDEX], VEHICLES_OP);
  assert.equal(ENSURE_OPS[AUTONOMY_INDEX], AUTONOMY_OP);
});

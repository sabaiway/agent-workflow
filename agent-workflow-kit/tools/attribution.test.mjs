import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLAUDE_DIR, EXPECTED_WORKFLOW_VERSION, SETTINGS_FILE, SETTINGS_LOCAL_FILE,
  VELOCITY_MALFORMED, VELOCITY_SYMLINK, VELOCITY_UNSAFE_MODE, WORKFLOW_STAMP,
} from './velocity-profile.mjs';

const leaf = await import('./attribution.mjs').catch(() => ({}));
const need = (name) => {
  if (!(name in leaf)) throw new Error(name + ' is absent');
  return leaf[name];
};
const UTF8 = 'utf8';
const AGENTS_FILE = 'AGENTS.md';
const HIDDEN = { commit: '', pr: '', sessionUrl: false };
const HIDDEN_TEXT = JSON.stringify(HIDDEN);
const WOULD_SET = `would set attribution (.claude/settings.json): ${HIDDEN_TEXT}`;
const SET = `set attribution (.claude/settings.json): ${HIDDEN_TEXT}`;
const NOTICE = 'notice: .claude/settings.json is the project-scope settings file — in a visible deployment it is committed and shared with everyone on this project, as the AGENTS.md block is';
const NOTHING = 'nothing to change: the settings already hide the trailer and the PR text';
const USAGE = 'usage: attribution [--cwd <root>] [--apply]';
const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const put = (root, relative, text) => {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, UTF8);
  return path;
};
const writeJson = (root, relative, data) => put(root, relative, `${JSON.stringify(data, null, 2)}\n`);
const readJson = (root, relative) => JSON.parse(readFileSync(join(root, relative), UTF8));
const snapshot = (root) => readdirSync(root).sort().map((name) => {
  const path = join(root, name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { name, kind: 'link', target: readlinkSync(path) };
  if (stat.isDirectory()) return { name, kind: 'directory', children: snapshot(path) };
  return { name, kind: 'file', bytes: readFileSync(path), inode: stat.ino, mtime: stat.mtimeMs };
});
const makeTempProject = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'attribution-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exit = t.mock.method(process, 'exit', () => {
    throw new Error('main must not exit');
  });
  t.after(() => assert.equal(exit.mock.callCount(), 0));
  put(root, WORKFLOW_STAMP, `${EXPECTED_WORKFLOW_VERSION}\n`);
  put(root, AGENTS_FILE, '> **Agent attribution: off** (chosen at setup).\n');
  return root;
};
const runMain = (argv, root, deps = {}) => {
  const log = [];
  const errlog = [];
  const code = need('main')(argv, {
    ...deps,
    cwd: root,
    log: (line) => log.push(line),
    errlog: (line) => errlog.push(line),
  });
  return { code, log, errlog };
};
const assertSuccess = (result, lines) => {
  assert.deepEqual(result, { code: EXIT_OK, log: lines, errlog: [] });
};
const captureError = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};
const assertRefusal = (result, code, key) => {
  assert.equal(result.code, EXIT_REFUSED);
  assert.deepEqual(result.log, []);
  assert.equal(result.errlog.length, 1);
  assert.match(result.errlog[0], new RegExp(`\\b${code}\\b`));
  if (key) assert.ok(result.errlog[0].includes(key));
};

describe('spec:init-project/S46 attribution reader, precedence, writer and CLI', () => {
  it('readAttributionChoice reads off, on and null and throws for an unreadable file', (t) => {
    const root = makeTempProject(t);
    const readChoice = need('readAttributionChoice');
    assert.equal(readChoice(root), 'off');
    put(root, AGENTS_FILE, '> **Agent attribution: on** (chosen at setup).\n');
    assert.equal(readChoice(root), 'on');
    rmSync(join(root, AGENTS_FILE));
    assert.equal(readChoice(root), null);
    put(root, AGENTS_FILE, '# Project\n');
    assert.equal(readChoice(root), null);
    put(root, AGENTS_FILE, '> **Agent attribution: maybe** (chosen at setup).\n');
    assert.equal(readChoice(root), null);
    rmSync(join(root, AGENTS_FILE));
    mkdirSync(join(root, AGENTS_FILE));
    assert.throws(() => readChoice(root), { code: 'EISDIR' });
  });

  it('effectiveAttribution takes each local key whole and falls back only for absent keys', (t) => {
    const root = makeTempProject(t);
    const project = { attribution: HIDDEN, includeCoAuthoredBy: false, permissions: {} };
    writeJson(root, SETTINGS_FILE, project);
    const localObject = { sessionUrl: true };
    const cases = [
      [{ attribution: localObject, includeCoAuthoredBy: true }, { attribution: localObject, includeCoAuthoredBy: true }],
      [{ attribution: localObject }, { attribution: localObject, includeCoAuthoredBy: false }],
      [{ includeCoAuthoredBy: true }, { attribution: HIDDEN, includeCoAuthoredBy: true }],
      [{}, { attribution: HIDDEN, includeCoAuthoredBy: false }],
    ];
    const effective = need('effectiveAttribution');
    for (const [local, expected] of cases) {
      writeJson(root, SETTINGS_LOCAL_FILE, local);
      const localData = readJson(root, SETTINGS_LOCAL_FILE);
      const result = effective(readJson(root, SETTINGS_FILE), localData);
      assert.deepEqual(result, expected);
      if (Object.hasOwn(localData, 'attribution')) assert.equal(result.attribution, localData.attribution);
    }
    writeJson(root, SETTINGS_FILE, {});
    writeJson(root, SETTINGS_LOCAL_FILE, {});
    assert.deepEqual(effective(readJson(root, SETTINGS_FILE), readJson(root, SETTINGS_LOCAL_FILE)), {});
  });

  it('attributionHidesText judges every documented text and legacy form', (t) => {
    makeTempProject(t);
    const cases = [
      [{ attribution: false }, true],
      [{ attribution: { commit: '', pr: '' } }, true],
      [{ attribution: { commit: '', pr: '', sessionUrl: true } }, true],
      [{ attribution: { commit: '', pr: '', sessionUrl: false } }, true],
      [{ includeCoAuthoredBy: false }, true],
      [{ includeCoAuthoredBy: false, attribution: { sessionUrl: false } }, true],
      [{ attribution: { commit: 'trailer', pr: '' } }, false],
      [{ attribution: { commit: '', pr: 'text' } }, false],
      [{ includeCoAuthoredBy: false, attribution: { commit: '' } }, false],
      [{ includeCoAuthoredBy: true }, false],
      [{}, false],
    ];
    const hidesText = need('attributionHidesText');
    for (const [settings, expected] of cases) {
      assert.equal(hidesText(settings), expected, JSON.stringify(settings));
    }
  });

  it('dry runs print the planned object and notice or nothing to change without writes', (t) => {
    const root = makeTempProject(t);
    writeJson(root, SETTINGS_FILE, { permissions: { allow: [] } });
    const before = snapshot(root);
    assertSuccess(runMain(['--cwd', root], root), [WOULD_SET, NOTICE]);
    assert.deepEqual(snapshot(root), before);
    assertSuccess(runMain([], root), [WOULD_SET, NOTICE]);
    assert.deepEqual(snapshot(root), before);
    writeJson(root, SETTINGS_FILE, { attribution: HIDDEN });
    const hiddenBefore = snapshot(root);
    assertSuccess(runMain([], root), [NOTHING]);
    assert.deepEqual(snapshot(root), hiddenBefore);
  });

  it('apply preserves the inode, CRLF, other keys and legacy value and is idempotent', (t) => {
    const root = makeTempProject(t);
    const original = { permissions: { allow: [] }, includeCoAuthoredBy: true };
    const text = `${JSON.stringify(original, null, 2)}\n`.replace(/\n/g, '\r\n');
    const path = put(root, SETTINGS_FILE, text);
    const inode = statSync(path).ino;
    assertSuccess(runMain(['--apply'], root), [SET]);
    const first = readFileSync(path);
    assert.equal(statSync(path).ino, inode);
    assert.ok(first.toString(UTF8).includes('\r\n'));
    assert.doesNotMatch(first.toString(UTF8), /(?<!\r)\n/);
    assert.deepEqual(readJson(root, SETTINGS_FILE), { ...original, attribution: HIDDEN });
    assertSuccess(runMain(['--apply'], root), [NOTHING]);
    assert.deepEqual(readFileSync(path), first);
  });

  it('apply creates the absent .claude directory and settings with exactly the hidden object', (t) => {
    const root = makeTempProject(t);
    assert.equal(existsSync(join(root, CLAUDE_DIR)), false);
    assertSuccess(runMain(['--apply'], root), [SET]);
    assert.ok(statSync(join(root, CLAUDE_DIR)).isDirectory());
    assert.deepEqual(readJson(root, SETTINGS_FILE), { attribution: HIDDEN });
  });

  it('wrong-typed project keys refuse both dry run and apply with zero writes', (t) => {
    const cases = [
      ['attribution', 'off'],
      ['attribution', []],
      ['includeCoAuthoredBy', 'false'],
    ];
    for (const [key, value] of cases) {
      const root = makeTempProject(t);
      writeJson(root, SETTINGS_FILE, { [key]: value });
      const before = snapshot(root);
      for (const argv of [[], ['--apply']]) {
        assertRefusal(runMain(argv, root), 'ATTRIBUTION_MALFORMED', key);
        assert.deepEqual(snapshot(root), before);
      }
    }
  });

  it('an old stamp permits preview but refuses apply through main and writeAttribution', (t) => {
    const root = makeTempProject(t);
    put(root, WORKFLOW_STAMP, '3.0.0\n');
    const before = snapshot(root);
    assertSuccess(runMain([], root), [WOULD_SET, NOTICE]);
    assert.deepEqual(snapshot(root), before);
    assertRefusal(runMain(['--apply'], root), 'ATTRIBUTION_STAMP');
    assert.deepEqual(snapshot(root), before);
    const writeAttribution = need('writeAttribution');
    assert.throws(() => writeAttribution({ cwd: root, dryRun: false }), { code: 'ATTRIBUTION_STAMP' });
    assert.deepEqual(snapshot(root), before);
  });

  it('preflight unsafe-mode, symlink and malformed refusals stop preview and apply without writes', (t) => {
    const cases = [
      [VELOCITY_UNSAFE_MODE, (root) => writeJson(root, SETTINGS_FILE, { permissions: { defaultMode: 'bypassPermissions' } })],
      [VELOCITY_SYMLINK, (root) => {
        const target = join(root, 'settings-target');
        mkdirSync(target);
        symlinkSync(target, join(root, CLAUDE_DIR), 'dir');
      }],
      [VELOCITY_MALFORMED, (root) => put(root, SETTINGS_FILE, '{ not json')],
    ];
    for (const [code, seed] of cases) {
      const root = makeTempProject(t);
      seed(root);
      const before = snapshot(root);
      const writeAttribution = need('writeAttribution');
      for (const dryRun of [true, false]) {
        const error = captureError(() => writeAttribution({ cwd: root, dryRun }));
        assert.equal(error?.code, code);
        assert.deepEqual(snapshot(root), before);
        assert.deepEqual(runMain(dryRun ? [] : ['--apply'], root), { code: EXIT_REFUSED, log: [], errlog: [error.message] });
        assert.deepEqual(snapshot(root), before);
      }
    }
  });

  it('CLI help reads nothing and invalid arguments return the reason and usage without exiting', (t) => {
    const root = makeTempProject(t);
    const missing = join(root, 'does-not-exist');
    const deps = { readFile: () => assert.fail('help must not read files') };
    const before = snapshot(root);
    for (const flag of ['--help', '-h']) {
      assertSuccess(runMain([flag], missing, deps), [USAGE]);
    }
    const regularFile = join(root, AGENTS_FILE);
    const cases = [
      [['--bogus'], 'unknown argument: --bogus'],
      [['--cwd'], '--cwd takes a value'],
      [['--cwd', regularFile], `--cwd is not a directory: ${regularFile}`],
      [['--help', '--apply'], 'unknown argument: --help'],
    ];
    for (const [argv, reason] of cases) {
      assert.deepEqual(runMain(argv, root), { code: EXIT_USAGE, log: [], errlog: [reason, USAGE] });
    }
    assert.deepEqual(snapshot(root), before);
  });
});

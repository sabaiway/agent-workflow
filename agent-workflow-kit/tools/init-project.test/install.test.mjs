import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENTINEL = 'SENTINEL-S17\n';
const STOPPED = '[agent-workflow-kit] project step skipped: an earlier step stopped init';
const NO_TERMINAL = "project step skipped: no terminal — run init in a console from the project's folder";

const lineCount = (path) => {
  const text = readFileSync(path, 'utf8');
  return text.split('\n').length - Number(text.endsWith('\n'));
};

describe('spec:init-project/S17 install runs the project step after the engine from the installed copy', () => {
  let payloadDir;
  let payload;
  let payloadError;
  let dir;
  let target;
  let project;
  let home;
  let emptyBin;
  let stepLog;

  before(() => {
    try {
      payloadDir = mkdtempSync(join(tmpdir(), 'aw-init-payload-'));
      payload = join(payloadDir, 'agent-workflow-kit');
      cpSync(KIT, payload, { recursive: true });
      writeFileSync(join(payload, 'tools', 'init-project.mjs'), [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "let input = '';",
        'try {',
        "  input = readFileSync(0, 'utf8');",
        '} catch {',
        "  input = '';",
        '}',
        'writeFileSync(process.env.FAKE_STEP_LOG, JSON.stringify({',
        '  argv1: process.argv[1],',
        '  cwd: process.cwd(),',
        '  input,',
        '}));',
        "console.log('FAKE-STEP-RAN');",
        'process.exit(Number(process.env.FAKE_STEP_EXIT ?? 0));',
        '',
      ].join('\n'));
    } catch (err) {
      payloadError = err;
    }
  });

  after(() => {
    if (payloadDir) rmSync(payloadDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-init-install-'));
    target = join(dir, 'agent-workflow-kit');
    project = join(dir, 'project');
    home = join(dir, 'home');
    emptyBin = join(dir, 'emptybin');
    stepLog = join(dir, 'step.json');
    mkdirSync(project);
    mkdirSync(home);
    mkdirSync(emptyBin);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Only the isolated PATH is visible, even on the --no-engine paths.
  const runInstaller = ({ real = false, engine = false, env = {} } = {}) => {
    assert.ifError(payloadError);
    const installer = join(real ? KIT : payload, 'bin', 'install.mjs');
    const extra = engine ? [] : ['--no-engine'];
    const res = spawnSync(process.execPath, [
      installer,
      '--dir', target,
      '--no-launchers',
      '--no-memory',
      '--no-bridges',
      ...extra,
    ], {
      cwd: project,
      encoding: 'utf8',
      input: SENTINEL,
      env: {
        ...process.env,
        HOME: home,
        PATH: emptyBin,
        FAKE_STEP_LOG: stepLog,
        FAKE_STEP_EXIT: '0',
        AW_INSTALL_RETRY_DELAY_MS: '0',
        ...env,
      },
    });
    assert.ifError(res.error);
    return res;
  };

  it("The step runs after the engine step from the installed copy, with init's own stdin", () => {
    const res = runInstaller();
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(stepLog), 'the installed project step must write its log');
    const logged = JSON.parse(readFileSync(stepLog, 'utf8'));
    assert.equal(logged.input, SENTINEL);
    assert.equal(realpathSync(logged.argv1), realpathSync(join(target, 'tools', 'init-project.mjs')));
    assert.equal(logged.cwd, realpathSync(project));
    const engineNote = res.stdout.indexOf('--no-engine: skipped installing the methodology engine');
    const stepNote = res.stdout.indexOf('FAKE-STEP-RAN');
    assert.ok(engineNote >= 0, res.stdout);
    assert.ok(stepNote > engineNote, res.stdout);
    assert.equal(res.stdout.includes('This command only installs/updates the kit itself'), false);
    assert.ok(lineCount(join(KIT, 'bin', 'install.mjs')) <= 585);
    assert.ok(lineCount(join(KIT, 'bin', 'install.test.mjs')) <= 739);
  });

  it("The step's failure is init's", () => {
    const res = runInstaller({ env: { FAKE_STEP_EXIT: '7' } });
    assert.notEqual(res.status, 0, 'a project-step failure must make init exit non-zero');
    assert.ok(existsSync(stepLog), 'the failing step must have run');
  });

  it('A stopped init skips the step, saying so', () => {
    const res = runInstaller({ engine: true });
    assert.notEqual(res.status, 0, 'the unavailable engine must stop init');
    assert.ok(`${res.stdout}\n${res.stderr}`.includes(STOPPED), `${res.stdout}\n${res.stderr}`);
    assert.equal(existsSync(stepLog), false, 'a stopped init must not run the project step');
  });

  it('No preflight before the kit copy and no inside-an-agent line without a TTY', () => {
    const res = runInstaller({ real: true, env: { CLAUDECODE: '1' } });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(join(target, 'SKILL.md')), 'the kit copy precedes the project preflight');
    assert.ok(res.stdout.includes(NO_TERMINAL), res.stdout);
    assert.equal(res.stdout.includes('you are inside an agent'), false);
  });
});

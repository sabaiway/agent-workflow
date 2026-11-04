import { it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, refreshPlacedBridges } from '../setup-backends.mjs';
import { readonlySkipLine } from '../refresh-parity.mjs';
const { loadServiceFragments, loadUserServices } = await import('./index.mjs').catch(() => ({}));

const USER_SERVICES = {
  acme: { hosts: ['api.acme.example'], writableDirs: [{ env: 'ACME_HOME', default: '~/.acme' }],
    excludedCommands: ['acme *'], passedVariables: ['ACME_TOKEN'], billingVariables: ['ACME_BILLING_KEY'], runReachesHosts: true },
  beta: { hosts: ['*.beta.example'], writableDirs: [], excludedCommands: [], passedVariables: [],
    billingVariables: [], runReachesHosts: false },
};
const EXPECTED_FACTS = [
  "# generated from the kit's service fragments (agent-workflow-kit/tools/services/); do not edit",
  'HOST=chatgpt.com', 'HOST=*.chatgpt.com', 'HOST=api.typesafe.ai', 'HOST=docs.typesafe.ai',
  'HOST=api.acme.example', 'HOST=*.beta.example',
  'RUN_HOST=api.typesafe.ai', 'RUN_HOST=docs.typesafe.ai', 'RUN_HOST=api.acme.example',
  'WRITABLE_DIR=CODEX_HOME:~/.codex', 'WRITABLE_DIR=ACME_HOME:~/.acme',
  'EXCLUDED_COMMAND=acme *', 'PASSED_VARIABLE=TYPESAFE_API_KEY', 'PASSED_VARIABLE=ACME_TOKEN', '',
].join('\n');

const createFixture = (context, { placed = true, xdg = false } = {}) => {
  const temporary = mkdtempSync(join(tmpdir(), 'awf-user-list-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundleRoot = join(temporary, 'bundles');
  const bundleDir = join(bundleRoot, 'codex-cli-bridge');
  const skillDir = join(temporary, 'skill');
  const bundled = fileURLToPath(new URL('../../bridges/codex-cli-bridge/', import.meta.url));
  const copyOptions = { recursive: true, filter: (path) => basename(path) !== 'node_modules' };
  cpSync(bundled, bundleDir, copyOptions);
  if (placed) cpSync(bundled, skillDir, copyOptions);
  const home = join(temporary, 'home');
  const configHome = xdg ? join(temporary, 'xdg') : join(home, '.config');
  const file = join(configHome, 'agent-workflow/services.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(USER_SERVICES));
  const deps = {
    home, getenv: { CODEX_CLI_BRIDGE_DIR: skillDir, PATH: '', ...(xdg ? { XDG_CONFIG_HOME: configHome } : {}) },
    bundleRoot, bindir: join(temporary, 'bin'), platform: 'linux',
    detect: () => ({ name: 'codex-cli-bridge', manifestState: 'ok',
      cli: { bin: 'codex', state: 'present', path: '/usr/bin/codex' },
      credentials: { state: 'present', path: '/c/auth.json' },
      wrappers: [], readiness: 'ready', setupHint: { url: 'u' }, skillDir }),
  };
  return { file, bundleDir, skillDir, deps, facts: join(skillDir, 'service-facts.txt') };
};
const runSetup = (deps) => {
  const lines = [];
  const code = main(['codex'], { ...deps, log: (line) => lines.push(line), errlog: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
};
const snapshotFolder = (root) => {
  const walk = (relative = '') => readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(relative, entry.name);
      return entry.isDirectory() ? [[path, null], ...walk(path)] : [[path, readFileSync(join(root, path)).toString('hex')]];
    });
  return existsSync(root) ? walk() : null;
};

it('spec:services/S11 placement and refresh render user facts without changing the bundle or reporting facts drift', async (context) => {
  for (const action of ['place', 'refresh']) {
    await context.test(action, () => {
      const fixture = createFixture(context, { placed: action !== 'place', xdg: action === 'place' });
      const bundled = readFileSync(join(fixture.bundleDir, 'service-facts.txt'));
      if (action === 'place') {
        const result = runSetup(fixture.deps);
        assert.equal(result.code, 0, result.text);
      } else {
        const [result] = refreshPlacedBridges(fixture.deps, ['codex-cli-bridge']);
        assert.equal(result.outcome, 'already-current', result.line);
      }
      assert.equal(readFileSync(fixture.facts, 'utf8'), EXPECTED_FACTS);
      assert.deepEqual(readFileSync(join(fixture.bundleDir, 'service-facts.txt')), bundled);
    });
  }
  for (const previous of ['hand edit\n', EXPECTED_FACTS.replace('HOST=*.beta.example\n', '')]) {
    await context.test(previous === 'hand edit\n' ? 'hand edit' : 'earlier list render', () => {
      const fixture = createFixture(context);
      const bundled = readFileSync(join(fixture.bundleDir, 'service-facts.txt'));
      writeFileSync(fixture.facts, previous);
      const [result] = refreshPlacedBridges(fixture.deps, ['codex-cli-bridge']);
      assert.equal(readFileSync(fixture.facts, 'utf8'), EXPECTED_FACTS);
      assert.doesNotMatch(result.line, /service-facts\.txt/);
      assert.deepEqual(readFileSync(join(fixture.bundleDir, 'service-facts.txt')), bundled);
    });
  }
});

it('spec:services/S12 refused lists stop refresh and setup with the exact refusal and no folder writes', async (context) => {
  for (const refusal of ['unparsable JSON', 'kit passed user billing']) {
    for (const placed of [true, false]) {
      await context.test(`${refusal}, ${placed ? 'placed' : 'never placed'}`, () => {
        const fixture = createFixture(context, { placed });
        writeFileSync(fixture.file, refusal === 'unparsable JSON' ? '{' : JSON.stringify({
          acme: { ...USER_SERVICES.acme, billingVariables: ['TYPESAFE_API_KEY'] },
        }));
        assert.equal(typeof loadUserServices, 'function');
        const messages = [];
        assert.throws(() => loadUserServices(loadServiceFragments(), { file: fixture.file }), (error) => {
          messages.push(error.message);
          return error.message.includes(fixture.file);
        });
        const before = snapshotFolder(fixture.skillDir);
        if (placed) {
          const [result] = refreshPlacedBridges(fixture.deps, ['codex-cli-bridge']);
          assert.equal(result.outcome, 'failed', result.line);
          assert.ok(result.line.includes(messages[0]), result.line);
          assert.ok(result.line.includes('/agent-workflow-kit upgrade'), result.line);
          assert.doesNotMatch(result.line, /recover with \/agent-workflow-kit setup/);
          assert.deepEqual(snapshotFolder(fixture.skillDir), before);
        }
        const result = runSetup(fixture.deps);
        assert.notEqual(result.code, 0, result.text);
        assert.ok(result.text.includes(messages[0]), result.text);
        assert.ok(result.text.includes('/agent-workflow-kit setup'), result.text);
        assert.deepEqual(snapshotFolder(fixture.skillDir), before);
        if (!placed) assert.equal(existsSync(fixture.skillDir), false);
      });
    }
  }
});

it('spec:services/S13 read-only parity compares facts with the current user list render', async (context) => {
  for (const changed of [false, true]) {
    await context.test(changed ? 'changed list is drifted' : 'current render is clean-parity', () => {
      const fixture = createFixture(context);
      const setup = runSetup(fixture.deps);
      assert.equal(setup.code, 0, setup.text);
      writeFileSync(fixture.facts, EXPECTED_FACTS);
      if (changed) writeFileSync(fixture.file, JSON.stringify({ acme: USER_SERVICES.acme }));
      const copyFile = () => { throw Object.assign(new Error('read-only fixture'), { code: 'EROFS' }); };
      const [result] = refreshPlacedBridges({ ...fixture.deps, copyFile }, ['codex-cli-bridge']);
      assert.equal(result.outcome, 'skipped-readonly', result.line);
      if (changed) {
        assert.ok(result.line.includes('service-facts.txt'), result.line);
        assert.ok(result.line.includes('still differing from what the refresh writes'), result.line);
      } else {
        const version = JSON.parse(readFileSync(join(fixture.bundleDir, 'capability.json'), 'utf8')).version;
        assert.equal(result.line, readonlySkipLine('codex-cli-bridge', version, {
          state: 'clean-parity', drifted: [], conflicts: [], unverifiable: [],
        }));
      }
      assert.equal(readFileSync(fixture.facts, 'utf8'), EXPECTED_FACTS);
    });
  }
});

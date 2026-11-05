import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, VALID } from '../tools/manifest/validate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readManifest = (name) => JSON.parse(readFileSync(join(REPO_ROOT, name, 'capability.json'), 'utf8'));

it('spec:jev-judge/S1 the declared judge stub has exactly the agreed manifest, shared provenance and a valid verdict', () => {
  const expected = JSON.parse('{"family":"agent-workflow","schema":1,"name":"typesafe-jev-bridge","kind":"execution-backend","version":"1.0.0","available":false,"provides":["judge"],"roles":{"judge":{"cmd":"jev-ask","source":"bin/jev-ask.sh","output":"advisory"}},"services":["jev"],"detect":{"installed":{"env":"TYPESAFE_JEV_BRIDGE_DIR","default":"~/.claude/skills/typesafe-jev-bridge","file":"SKILL.md"}},"provenance":{"author":"sabaiway","source":"github:sabaiway/agent-workflow"}}');
  const manifest = readManifest('typesafe-jev-bridge');
  assert.deepEqual(manifest, expected);
  for (const bridge of ['codex-cli-bridge', 'antigravity-cli-bridge']) {
    assert.deepEqual(manifest.provenance, readManifest(bridge).provenance);
  }
  const result = validateManifest(join(REPO_ROOT, 'typesafe-jev-bridge'));
  assert.equal(result.result, VALID, result.errors.join('; '));
  assert.deepEqual(result.errors, []);
});

it('spec:jev-judge/S2 every declared stub is absent from runtime code and kit mirrors and holds its manifest alone', () => {
  const stubs = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(REPO_ROOT, entry.name, 'capability.json')))
    .map(({ name }) => name).filter((name) => readManifest(name).available === false);
  assert.ok(stubs.includes('typesafe-jev-bridge'), JSON.stringify(stubs));
  const scanCode = (directory, name) => readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || path === join('agent-workflow-kit', 'test') ? [] : scanCode(path, name);
    if (!entry.isFile() || entry.name.endsWith('.test.mjs') || !/\.(mjs|json)$/.test(entry.name)) return [];
    return readFileSync(join(REPO_ROOT, path), 'utf8').includes(name) ? [path] : [];
  });
  for (const name of stubs) {
    const offending = ['agent-workflow-kit', 'agent-workflow-engine', 'scripts'].flatMap((directory) => scanCode(directory, name));
    assert.deepEqual(offending, [], offending.join('\n'));
    assert.equal(existsSync(join(REPO_ROOT, 'agent-workflow-kit', 'bridges', name)), false, name);
    assert.deepEqual(readdirSync(join(REPO_ROOT, name)).sort(), ['capability.json'], name);
  }
});

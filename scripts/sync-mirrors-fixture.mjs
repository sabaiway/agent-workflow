import { afterEach } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, BRIDGE_DIRS, MIRROR_TEMPLATE_FILES, TEMPLATE_HARD_EXCLUDES, runCli } from './sync-mirrors.mjs';

const tempDirs = [];
export const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-mirrors-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});
export const SERVICES_REL = 'agent-workflow-kit/tools/services';
export const FACTS_FILE = 'service-facts.txt';
const seedFacts = (id) => [
  "# generated from the kit's service fragments (agent-workflow-kit/tools/services/); do not edit",
  `HOST=${id}.example`, 'HOST=jev.example', 'RUN_HOST=jev.example',
  `WRITABLE_DIR=${id === 'codex' ? 'CODEX_HOME:~/.codex' : ':~/.gemini/antigravity-cli'}`,
  'PASSED_VARIABLE=TYPESAFE_API_KEY', '',
].join('\n');
export const seedFamily = (root) => {
  const hookRel = 'agent-workflow-kit/references/hooks/gate-approve.mjs';
  mkdirSync(join(root, hookRel, '..'), { recursive: true });
  copyFileSync(join(REPO_ROOT, hookRel), join(root, hookRel));
  const servicesDir = join(root, SERVICES_REL);
  mkdirSync(servicesDir, { recursive: true });
  for (const id of ['codex', 'antigravity', 'jev']) {
    const writableDirs = id === 'jev' ? [] : [{ env: id === 'codex' ? 'CODEX_HOME' : null,
      default: id === 'codex' ? '~/.codex' : '~/.gemini/antigravity-cli' }];
    writeFileSync(join(servicesDir, `${id}.json`), JSON.stringify({ hosts: [`${id}.example`], writableDirs,
      excludedCommands: [], passedVariables: id === 'jev' ? ['TYPESAFE_API_KEY'] : [], billingVariables: [], runReachesHosts: id === 'jev' }));
  }
  for (const bridge of BRIDGE_DIRS) {
    const id = bridge.replace('-cli-bridge', '');
    for (const base of [join(root, bridge), join(root, 'agent-workflow-kit', 'bridges', bridge)]) {
      mkdirSync(join(base, 'bin'), { recursive: true });
      writeFileSync(join(base, 'SKILL.md'), `# ${bridge}\n`);
      writeFileSync(join(base, 'capability.json'), `${JSON.stringify({ name: bridge, version: '1.0.0', services: [id, 'jev'] })}\n`);
      writeFileSync(join(base, FACTS_FILE), seedFacts(id));
      writeFileSync(join(base, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
      chmodSync(join(base, 'bin', 'run.sh'), 0o755);
    }
  }
  for (const side of ['agent-workflow-memory', 'agent-workflow-kit']) {
    const scripts = join(root, side, 'references', 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'tool.mjs'), 'export const tool = 1;\n');
    const templates = join(root, side, 'references', 'templates');
    mkdirSync(join(templates, 'pages'), { recursive: true });
    mkdirSync(join(templates, 'adr'), { recursive: true });
    mkdirSync(join(templates, 'specs'), { recursive: true });
    for (const rel of MIRROR_TEMPLATE_FILES) writeFileSync(join(templates, rel), `template ${rel}\n`);
    for (const rel of TEMPLATE_HARD_EXCLUDES) writeFileSync(join(templates, rel), `${side} divergent ${rel}\n`);
    writeFileSync(join(templates, 'local-extra.md'), `${side} extra outside the manifest\n`);
  }
  for (const rel of ['agent-workflow-memory/bin/payload-prune.mjs', 'agent-workflow-kit/tools/payload-prune.mjs']) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), 'export const prunePayload = () => ({});\n');
    chmodSync(join(root, rel), 0o644);
  }
};
export const run = (argv, root) => {
  const out = [];
  const err = [];
  const code = runCli([...argv, '--root', root], { log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

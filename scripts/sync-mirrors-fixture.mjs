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
export const AGY_BRIDGE = 'antigravity-cli-bridge';
export const AGY_MANIFEST_REL = join(AGY_BRIDGE, 'capability.json');
export const AGY_WRAPPERS = ['bin/agy.sh', 'bin/agy-review.sh'].map((rel) => `${AGY_BRIDGE}/${rel}`);
export const AGY_MODEL_CONSTANT = 'DEFAULT_AGY_MODEL';
export const LEGACY_AGY_MODEL_CONSTANT = 'DEFAULT_AGY_REVIEW_MODEL';
export const AGY_POSTURE_ROWS = AGY_WRAPPERS.map((wrapper) => ({ bridge: AGY_BRIDGE, wrapper, constant: AGY_MODEL_CONSTANT, slot: 'model' }));
export const FIXTURE_MODEL = 'Fixture Aurora (High)';
export const POSTURE_BEGIN = '# generated from capability.json posture by scripts/sync-mirrors.mjs; do not edit';
export const POSTURE_END = '# end of the generated posture defaults';
export const AGY_READER_BEGIN = '# --- Bridge settings file (host-level, kit-independent) — byte-identical across the four wrappers ---';
export const postureRegionLines = (model) => [POSTURE_BEGIN, `${AGY_MODEL_CONSTANT}='${model}'`, POSTURE_END];
const EXECUTABLE_MODE = 0o755;
const BRIDGE_SERVICES = new Map([
  ['codex-cli-bridge', ['codex', 'jev']],
  ['antigravity-cli-bridge', ['antigravity', 'jev']],
  ['typesafe-jev-bridge', ['jev']],
]);
const seedFacts = (services) => [
  "# generated from the kit's service fragments (agent-workflow-kit/tools/services/); do not edit",
  ...services.map((id) => `HOST=${id}.example`), 'RUN_HOST=jev.example',
  ...services.filter((id) => id !== 'jev').map((id) => `WRITABLE_DIR=${id === 'codex' ? 'CODEX_HOME:~/.codex' : ':~/.gemini/antigravity-cli'}`),
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
    const services = BRIDGE_SERVICES.get(bridge);
    if (!services) throw new Error(`Unknown bridge services: ${bridge}`);
    for (const base of [join(root, bridge), join(root, 'agent-workflow-kit', 'bridges', bridge)]) {
      mkdirSync(join(base, 'bin'), { recursive: true });
      writeFileSync(join(base, 'SKILL.md'), `# ${bridge}\n`);
      const posture = bridge === AGY_BRIDGE ? { posture: { model: FIXTURE_MODEL } } : {};
      writeFileSync(join(base, 'capability.json'), `${JSON.stringify({ name: bridge, version: '1.0.0', services, ...posture })}\n`);
      writeFileSync(join(base, FACTS_FILE), seedFacts(services));
      writeFileSync(join(base, 'bin', 'run.sh'), '#!/bin/sh\necho run\n');
      chmodSync(join(base, 'bin', 'run.sh'), 0o755);
      if (bridge === AGY_BRIDGE) for (const wrapper of AGY_WRAPPERS) {
        const path = join(base, wrapper.slice(AGY_BRIDGE.length + 1));
        writeFileSync(path, ['#!/bin/bash', ...postureRegionLines(FIXTURE_MODEL), AGY_READER_BEGIN, 'echo run', ''].join('\n'), { mode: EXECUTABLE_MODE });
      }
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

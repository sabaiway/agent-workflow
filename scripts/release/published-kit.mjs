// published-kit.mjs — the cross-version gate's published-kit probe leaf: the sanitized child env
// and the @latest install into a throwaway dir. Split out of cross-version-gate.mjs so the gate
// holds the 400-line source-size cap by construction (the plan's named seam) — no CLI, no side
// effects on import. Dependency-free, Node >= 22.

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSanitizedEnv } from './smoke-init.mjs';
import { fail, KIT_PACKAGE_NAME } from './smoke-candidate.mjs';

// buildSanitizedEnv repoints HOME/npm-cache and strips the family overrides; the AW_* strip is
// this lane's addition — a leaked AW_FLOW_STORE or AW_GIT_DIR from the orchestrating shell would
// redirect (or refuse) the published kit's own runner.
export const gateChildEnv = (baseEnv, { home, npmCache }) => {
  const env = buildSanitizedEnv(baseEnv, { home, npmCache });
  for (const key of Object.keys(env)) {
    if (key.startsWith('AW_')) delete env[key];
  }
  return env;
};

// The probe IS the install: whatever @latest resolves to is both the version under test and the
// recorded probed version — one fact, never two reads that could disagree. An unreachable
// registry is a loud refusal (the caller writes no receipt over it).
export const installPublishedKit = ({ installDir, env, exec, readFile = readFileSync, writeFile = writeFileSync }) => {
  writeFile(join(installDir, 'package.json'), '{"name":"cross-version-probe","private":true}\n');
  const res = exec('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `${KIT_PACKAGE_NAME}@latest`], { cwd: installDir, env });
  if (res.error || res.status !== 0) {
    const detail = res.error ? res.error.message : `${res.stderr ?? ''}\n${res.stdout ?? ''}`.trim();
    throw fail(1, `the published kit could not be installed from the registry — no axis can be probed and no receipt is written (${detail})`);
  }
  const publishedVersion = JSON.parse(String(readFile(join(installDir, 'node_modules', KIT_PACKAGE_NAME, 'package.json'), 'utf8'))).version;
  return { publishedVersion, installedTools: join(installDir, 'node_modules', KIT_PACKAGE_NAME, 'tools') };
};

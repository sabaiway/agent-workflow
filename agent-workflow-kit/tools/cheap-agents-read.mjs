// cheap-agents-read.mjs — the READ-ONLY core of the subagent-vehicle surface: the bundle, the
// placement plan and the executor vehicle's readiness. Split from cheap-agents.mjs (the writer) so
// the read-only advisor graph (procedures -> recipes) reaches these facts WITHOUT importing a module
// that can create `.claude/agents/` — by construction, pinned by the read-graph purity walk.

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseDirectRun } from './direct-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const AGENTS_DIR = '.claude/agents';
export const CLAUDE_DIR = '.claude';
export const WORKFLOW_STAMP = 'docs/ai/.workflow-version';
export const EXPECTED_WORKFLOW_VERSION = '3.0.0';
export const BUNDLED_AGENTS_DIR = resolve(HERE, '..', 'references', 'agents');

export const UTF8 = 'utf8';
const ERROR_PREFIX = '[agent-workflow-kit]';
const EXIT_PRECONDITION = 1;

export const CHEAP_AGENTS_STAMP = 'CHEAP_AGENTS_STAMP';
export const CHEAP_AGENTS_SYMLINK = 'CHEAP_AGENTS_SYMLINK';
export const CHEAP_AGENTS_BUNDLE = 'CHEAP_AGENTS_BUNDLE';

export const makeCheapAgentsError = (code, message) =>
  Object.assign(new Error(`${ERROR_PREFIX} ${message}`), { name: 'CheapAgentsError', code, exitCode: EXIT_PRECONDITION });

// The injectable READ surface — four functions, none of which can create or modify a file. The
// writer shell adds its own mkdir/writeFile pair rather than widening this one.
export const readFsDeps = (deps = {}) => ({
  exists: deps.exists ?? existsSync,
  lstat: deps.lstat ?? lstatSync,
  readFile: deps.readFile ?? readFileSync,
  readdir: deps.readdir ?? readdirSync,
});

export const lstatNoFollow = (absPath, fs) => {
  try {
    return fs.lstat(absPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// ── the bundle (the kit's own references/agents/) ─────────────────────────────────────

export const readBundledAgents = (deps = {}) => {
  const fs = readFsDeps(deps);
  const bundleDir = deps.bundleDir ?? BUNDLED_AGENTS_DIR;
  let names;
  try {
    names = fs.readdir(bundleDir);
  } catch (err) {
    throw makeCheapAgentsError(CHEAP_AGENTS_BUNDLE, `bundled agents dir unreadable (${err.code ?? err.message}): ${bundleDir}`);
  }
  const templates = names
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name, content: fs.readFile(join(bundleDir, name), UTF8) }));
  if (templates.length === 0) {
    throw makeCheapAgentsError(CHEAP_AGENTS_BUNDLE, `no bundled agent templates found in ${bundleDir} — the kit install is incomplete`);
  }
  return templates;
};

// ── the preflight reads (velocity discipline: symlink-safe, stamp read, no writes) ────

export const readStamp = (absPath, fs) => {
  try {
    if (!fs.exists(absPath)) return null;
    const stamp = String(fs.readFile(absPath, UTF8)).trim();
    return stamp.length ? stamp : null;
  } catch {
    return null; // unreadable stamp == not a valid deployment stamp (apply STOPs; dry-run reports)
  }
};

export const assertDirSafe = (absPath, relPath, fs) => {
  const stat = lstatNoFollow(absPath, fs);
  if (stat === null) return { absent: true };
  if (stat.isSymbolicLink()) throw makeCheapAgentsError(CHEAP_AGENTS_SYMLINK, `${relPath} is a symlink — refusing to write through it`);
  if (!stat.isDirectory()) throw makeCheapAgentsError(CHEAP_AGENTS_SYMLINK, `${relPath} exists but is not a directory — refusing to write through it`);
  return { absent: false };
};

// Per-template placement plan: place | already-current | customized-preserved (never clobbered).
export const planPlacement = (templates, projectDir, deps = {}) => {
  const fs = readFsDeps(deps);
  return templates.map((template) => {
    const rel = `${AGENTS_DIR}/${template.name}`;
    const abs = join(projectDir, AGENTS_DIR, template.name);
    const stat = lstatNoFollow(abs, fs);
    if (stat === null) return { ...template, rel, abs, action: 'place' };
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw makeCheapAgentsError(CHEAP_AGENTS_SYMLINK, `${rel} exists but is not a regular file — refusing to touch it`);
    }
    const existing = fs.readFile(abs, UTF8);
    if (existing === template.content) return { ...template, rel, abs, action: 'already-current' };
    return { ...template, rel, abs, action: 'customized-preserved', existing };
  });
};

// ── the executor vehicle's readiness (the subagent carrier's one instrument) ──────────

export const EXECUTOR_VEHICLE = 'executor.md';
export const EXECUTOR_VEHICLE_REL = `${AGENTS_DIR}/${EXECUTOR_VEHICLE}`;

// The YAML subset a vehicle's frontmatter is read with: a bare scalar, a single- or double-quoted
// scalar, or a flow sequence; an unquoted ` #comment` and surrounding whitespace are dropped first.
const cleanValue = (raw) => {
  const noComment = String(raw ?? '').replace(/^((?:[^"'#]|"[^"]*"|'[^']*')*?)\s+#.*$/u, '$1').trim();
  return noComment.replace(/^(["'])(.*)\1$/u, '$2').replace(/^\[(.*)\]$/u, '$1').trim();
};

// The block-sequence items under the `tools:` key: `- item` lines indented deeper than the key,
// with blank and comment lines allowed between them; the first other line ends the list.
const blockItems = (frontmatter) => {
  const lines = frontmatter.split('\n');
  const start = lines.findIndex((line) => /^tools:/u.test(line));
  if (start === -1) return [];
  const keyIndent = lines[start].match(/^[ \t]*/u)[0].length;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[ \t]*(#.*)?$/u.test(line)) continue;
    const item = line.match(/^([ \t]*)-[ \t]*(.*)$/u);
    if (!item || item[1].length <= keyIndent) break;
    const value = cleanValue(item[2]);
    if (value) items.push(value);
  }
  return items;
};

const executorFrontmatterRefusal = (content) => {
  const frontmatter = String(content).replace(/\r\n/gu, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1] ?? '';
  for (const key of ['name', 'tools']) {
    if ((frontmatter.match(new RegExp(`^${key}:`, 'gmu')) ?? []).length > 1) return `duplicate \`${key}:\` key in the frontmatter`;
  }
  if (cleanValue(frontmatter.match(/^name:(.*)$/mu)?.[1]) !== 'executor') return 'frontmatter does not declare `name: executor`';
  if (!/^tools:/mu.test(frontmatter)) return null;
  const inline = cleanValue(frontmatter.match(/^tools:(.*)$/mu)?.[1]);
  const listed = inline || blockItems(frontmatter).join(', ');
  if (!listed) return 'tools: is empty — grant a list that includes Bash, or drop the line';
  const granted = listed.split(',').map((tool) => cleanValue(tool));
  return granted.includes('Bash') ? null : `tools: ${listed} is read-only`;
};

// A symlinked, non-regular or unreadable vehicle is a STATE the carrier degrades on, so this survey
// answers it instead of throwing: its callers compose the answer into a readiness array.
export const surveyExecutorVehicle = (projectDir, deps = {}) => {
  const rel = EXECUTOR_VEHICLE_REL;
  try {
    const template = readBundledAgents(deps).find((item) => item.name === EXECUTOR_VEHICLE);
    if (!template) throw makeCheapAgentsError(CHEAP_AGENTS_BUNDLE, `${EXECUTOR_VEHICLE} is missing from the bundle`);
    const fs = readFsDeps(deps);
    assertDirSafe(join(projectDir, CLAUDE_DIR), CLAUDE_DIR, fs);
    assertDirSafe(join(projectDir, AGENTS_DIR), AGENTS_DIR, fs);
    const [placement] = planPlacement([template], projectDir, deps);
    if (placement.action === 'place') return { state: 'missing', reason: null, rel };
    if (placement.action === 'already-current') return { state: 'placed', reason: null, rel };
    const refusal = executorFrontmatterRefusal(placement.existing);
    return refusal === null
      ? { state: 'customized', reason: null, rel }
      : { state: 'unusable', reason: refusal, rel };
  } catch (err) {
    return { state: 'unusable', reason: err?.message ?? String(err), rel };
  }
};

refuseDirectRun(import.meta.url);

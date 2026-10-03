// bridge-catalog.mjs — reads the models each installed bridge CLI offers, exactly as the bridge
// wrappers read them before a run (spec bridge-model: Catalog check; spec bridge-settings): codex
// `codex debug models -c model_provider=openai`, the `visibility: list` slugs each with its efforts;
// agy `agy models`, the display string after the TAB of each line carrying one. Each read runs on the
// caller's PATH with every *_API_KEY (and, for codex, OPENAI_BASE_URL) removed, so the list is the
// subscription catalog the runs use. A read is bounded by the wrapper's own constant, then killed with
// its whole process group after the wrapper's kill grace. Read-only: it runs no model, writes nothing.
//
// Dependency-free, Node >= 22. No side effects on import.

import { spawn } from 'node:child_process';
import { accessSync, statSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

// The wrappers' constants: codex-exec.sh CODEX_CATALOG_TIMEOUT_S=15, agy.sh AGY_CATALOG_TIMEOUT=30s,
// both under `timeout --kill-after=5s`.
export const CATALOG_BOUNDS_MS = Object.freeze({ 'codex-cli-bridge': 15000, 'antigravity-cli-bridge': 30000 });
export const CATALOG_KILL_GRACE_MS = 5000;

const CONTROL = /[\u0000-\u001f\u007f]/u;
const unreadable = (cause) => ({ state: 'unreadable', cause, entries: [] });

export const parseCodexCatalog = (text) => {
  let doc;
  try { doc = JSON.parse(text); } catch { return unreadable('its output is not JSON'); }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.models)) return unreadable('it carries no models[]');
  const offered = doc.models.filter((m) => m !== null && typeof m === 'object' && m.visibility === 'list');
  if (offered.some((m) => typeof m.slug !== 'string' || m.slug === '' || CONTROL.test(m.slug))) return unreadable('an offered entry carries no usable slug');
  if (offered.length === 0) return unreadable('it offers no model');
  const effortsOf = (m) => (Array.isArray(m.supported_reasoning_levels)
    && m.supported_reasoning_levels.every((l) => l !== null && typeof l === 'object' && typeof l.effort === 'string' && l.effort !== '' && !CONTROL.test(l.effort))
    ? m.supported_reasoning_levels.map((l) => l.effort) : null);
  return { state: 'offered', cause: null, entries: offered.map((m) => ({ model: m.slug, efforts: effortsOf(m) })) };
};

export const parseAgyCatalog = (text) => {
  const entries = text.split('\n')
    .map((line) => line.replace(/\r$/u, ''))
    .filter((line) => line.includes('\t'))
    .map((line) => line.slice(line.indexOf('\t') + 1))
    .filter((model) => model !== '' && !CONTROL.test(model))
    .map((model) => ({ model }));
  return entries.length ? { state: 'offered', cause: null, entries } : unreadable('it offers no model');
};

const CLIS = {
  'codex-cli-bridge': { cli: 'codex', args: ['debug', 'models', '-c', 'model_provider=openai'], parse: parseCodexCatalog, clears: ['OPENAI_BASE_URL'] },
  'antigravity-cli-bridge': { cli: 'agy', args: ['models'], parse: parseAgyCatalog, clears: [] },
};

// The environment a catalog read runs in: the caller's, minus every *_API_KEY and the bridge's own
// base-URL variable — the variables the wrapper's subscription guard clears before its own read.
export const catalogEnv = (name, getenv) => Object.fromEntries(Object.entries(getenv)
  .filter(([key]) => !/_API_KEY$/u.test(key) && !(CLIS[name]?.clears ?? []).includes(key)));

const resolveOnPath = (cli, env) => {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, cli);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not this directory */ }
  }
  return null;
};

const killGroup = (child, signal) => {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
};

const readOne = (name, ctx) => new Promise((done) => {
  const spec = CLIS[name];
  if (!spec) return done(unreadable(`no catalog reader for ${name}`));
  const env = catalogEnv(name, ctx.getenv ?? process.env);
  const bin = resolveOnPath(spec.cli, env);
  if (bin === null) return done({ state: 'not-installed', cause: `${spec.cli} is not on PATH`, entries: [] });
  const boundMs = ctx.catalogBoundsMs?.[name] ?? CATALOG_BOUNDS_MS[name];
  const graceMs = ctx.catalogKillGraceMs ?? CATALOG_KILL_GRACE_MS;
  const label = `${spec.cli} ${spec.args.slice(0, name === 'codex-cli-bridge' ? 2 : 1).join(' ')}`;
  const chunks = [];
  let timedOut = false;
  let settled = false;
  let bound;
  let kill;
  const finish = (result) => { if (!settled) { settled = true; clearTimeout(bound); clearTimeout(kill); done(result); } };
  // spawn THROWS for an execve errno it does not emit (ETXTBSY: the binary is being replaced).
  let child;
  try {
    child = spawn(bin, spec.args, { env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  } catch (err) {
    return finish(unreadable(`${label} could not start (${err.code ?? err.message})`));
  }
  bound = setTimeout(() => {
    timedOut = true;
    killGroup(child, 'SIGTERM');
    kill = setTimeout(() => killGroup(child, 'SIGKILL'), graceMs);
  }, boundMs);
  child.stdout?.on('data', (chunk) => chunks.push(chunk));
  child.on('error', (err) => finish(unreadable(`${label} could not start (${err.code ?? err.message})`)));
  child.on('close', (code, signal) => {
    if (timedOut) return finish(unreadable(`it exceeded ${boundMs / 1000}s`));
    if (code !== 0) return finish(unreadable(`${label} exited ${code ?? signal}`));
    return finish(spec.parse(Buffer.concat(chunks).toString('utf8')));
  });
});

// names: bridge names (the family-members `name`). Resolves to { [name]: { state, cause, entries } },
// state `offered` | `unreadable` | `not-installed`; the reads run concurrently and never reject.
export const readCatalogs = async (names, ctx = {}) => {
  const results = await Promise.all(names.map((name) => readOne(name, ctx)));
  return Object.fromEntries(names.map((name, i) => [name, results[i]]));
};

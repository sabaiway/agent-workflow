// bridge-settings-read.mjs — the READ-ONLY core of the host-level bridge settings surface (bridges
// 2.3.0, D6). Split out from bridge-settings.mjs so the read-only status/advisor consumers
// (family-registry, recipes --status-line, procedures) can surface settings facts WITHOUT importing
// the writer (which pulls in the atomic-write core — forbidden in a read-only module, pinned by the
// procedures import guard). It reads: the settings-file path, the file's state, the parsed KEY=VALUE
// lines, the manifest-as-source registry (the union of the bundled bridges' `settings` blocks), and
// the effective value of each knob (env > file > built-in default). It NEVER writes.
//
// Dependency-free, Node >= 22. No side effects on import.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_MEMBERS } from './family-members.mjs';
import { resolveDir } from './detect-backends.mjs';
import { settingValueValid, SETTING_KINDS } from './manifest/validate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// bridges/ ships beside tools/ in both the repo and the installed kit, so this resolves in both.
export const DEFAULT_BUNDLE_ROOT = resolve(__dirname, '..', 'bridges');
export const SETTINGS_XDG = { env: 'XDG_CONFIG_HOME', default: '~/.config' };
export const SETTINGS_SUBDIR = 'agent-workflow';
export const SETTINGS_FILENAME = 'bridge-settings.conf';
// A valid settings line: an UPPER/lower_snake KEY (the wrappers' own `^[A-Za-z_][A-Za-z0-9_]*=`) then
// everything after the first `=` as the value. Anchored at column 0, exactly like the wrappers' grep.
export const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// A typed refusal we surface. `exitCode` lets a CLI map it to the process code without matching text.
export const fail = (exitCode, message) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'BridgeSettingsError', exitCode });

// ── the registry (manifest-as-source) ───────────────────────────────────────────────

// The bundled execution-backend bridge dirs (derived, never hardcoded — a future bridge joins here by
// its family-members row, not an edit).
const bridgeDirs = (ctx) =>
  FAMILY_MEMBERS
    .filter((m) => m.kind === 'execution-backend')
    .map((m) => ({ name: m.name, dir: join(ctx.bundleRoot ?? DEFAULT_BUNDLE_ROOT, m.name) }));

// Load the union of both bridges' `settings` blocks → a Map keyed by settings key, each entry carrying
// its typed rule + the owning bridge. A missing/corrupt bundle is a loud STOP (a writer cannot be
// honored without a trustworthy allowlist; a reader/snapshot caller catches it to degrade). The
// registry is validated at build time (manifest validate --strict + the mirror drift-guard); here we
// only guard fs/JSON errors and the block's basic shape.
export const loadRegistry = (ctx) => {
  const read = ctx.readFile ?? readFileSync;
  const byKey = new Map();
  for (const { name, dir } of bridgeDirs(ctx)) {
    const manifestPath = join(dir, 'capability.json');
    const manifest = (() => {
      try {
        return JSON.parse(String(read(manifestPath, 'utf8')));
      } catch (err) {
        throw fail(1, `cannot read the bundled bridge manifest ${manifestPath} (${err.code ?? err.message}) — corrupt kit install?`);
      }
    })();
    const settings = manifest.settings ?? [];
    if (!Array.isArray(settings)) throw fail(1, `bundled ${name} manifest \`settings\` is not an array — corrupt kit install?`);
    for (const entry of settings) {
      if (!entry || typeof entry.key !== 'string' || !SETTING_KINDS.has(entry.kind)) {
        throw fail(1, `bundled ${name} manifest carries a malformed settings entry — corrupt kit install?`);
      }
      byKey.set(entry.key, { ...entry, bridge: name });
    }
  }
  return byKey;
};

// A one-line, fact-only description of a knob's allowed values (from its typed rule) for help/preview.
export const allowedLabel = (entry) => {
  switch (entry.kind) {
    case 'enum': return entry.values.map((v) => `"${v}"`).join(' | ');
    case 'integer': return `integer ${entry.min}..${entry.max}`;
    case 'duration': return 'duration (e.g. 5m, 30m, 90s — a unit is required, nonzero)';
    case 'boolean': return '"0" | "1"';
    default: return entry.kind;
  }
};

// ── the settings file ────────────────────────────────────────────────────────────────

export const settingsDir = (ctx) => join(resolveDir(SETTINGS_XDG, ctx.getenv ?? process.env, ctx.home ?? homedir()), SETTINGS_SUBDIR);
export const settingsPath = (ctx) => join(settingsDir(ctx), SETTINGS_FILENAME);

// Lines with a single trailing newline normalized away, so edits operate on an exact line array and
// re-serialize with one trailing newline (comments/blank lines in the middle survive verbatim).
export const splitLines = (text) => {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
};
export const joinLines = (lines) => (lines.length ? `${lines.join('\n')}\n` : '');

// Read the file's STATE the SAME way the wrappers do — `stat` (FOLLOW symlinks), matching their
// `-e`/`-f`/`-r` guard EXACTLY so the reader/status/reconcile reflect what the wrappers actually use:
// 'absent' (missing OR a dangling symlink — silent, defaults apply, like the wrapper's `-e`), 'unusable'
// (a directory / FIFO / unreadable target — the wrapper's `-f`/`-r` false → warn + defaults), or
// 'present' with its text (a regular file OR a symlink-to-regular — the wrapper reads it). The WRITER
// stays secure regardless: the atomic core refuses a symlinked leaf (a write would clobber the target),
// so a symlinked config is READ (matching the wrappers) but never written THROUGH.
export const readFileState = (path, ctx) => {
  const stat = ctx.stat ?? statSync;
  const read = ctx.readFile ?? readFileSync;
  const st = (() => {
    try {
      return stat(path);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      return 'error';
    }
  })();
  if (st === null) return { state: 'absent' };
  if (st === 'error' || !st.isFile()) return { state: 'unusable' };
  try {
    return { state: 'present', text: String(read(path, 'utf8')) };
  } catch {
    return { state: 'unusable' };
  }
};

// Parse a settings file body → valid KEY= entries (in order), malformed lines, and a key→entries map.
export const parseSettings = (text) => {
  const lines = splitLines(text);
  const entries = [];
  const malformed = [];
  lines.forEach((line, index) => {
    const noLeadWs = line.replace(/^[\s]+/, '');
    if (noLeadWs === '' || noLeadWs.startsWith('#')) return; // blank / comment (indented ok)
    const m = line.match(KEY_LINE_RE);
    if (!m) {
      malformed.push({ index, text: line });
      return;
    }
    entries.push({ key: m[1], value: m[2], index });
  });
  const byKey = new Map();
  for (const e of entries) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  return { lines, entries, malformed, byKey };
};

export const duplicateKeys = (parsed) => [...parsed.byKey.entries()].filter(([, es]) => es.length > 1).map(([k]) => k);

// ── effective-value resolution (env > file > built-in default) ────────────────────────

// The effective value of one knob + where it comes from. Fact-only; never a model claim.
export const effectiveOf = (entry, parsed, getenv) => {
  const key = entry.key;
  if (Object.prototype.hasOwnProperty.call(getenv, key)) {
    const v = getenv[key];
    // An EXPLICITLY-EMPTY env (`KEY=`) suppresses the FILE override for this run (the wrapper skips a
    // key already present in env, `${!key+x}`), so the effective value falls to the WRAPPER BUILT-IN —
    // NOT "flag absent" (only the tier's built-in default happens to be "no flag"; the timeout / bytes /
    // add-dir knobs fall to their real built-in default). Report the manifest default (null ⇒ "wrapper
    // built-in applies"), not a misleading null-for-everything.
    if (v === '') return { value: entry.default, source: 'default', note: 'the env KEY= suppresses the file override — the wrapper built-in applies' };
    // Mirror the wrapper: an ENUM knob (the service tier) validates its ENV value too — codex accepts
    // any `-c service_tier` string silently, so the wrapper drops an unsupported one to the built-in
    // default (codex-exec.sh:188). A non-enum env value is the operator's documented RAW override (e.g.
    // a timeout(1) duration like `2h` the wrapper passes straight through) — shown as-is (D3 scopes
    // typed validation to FILE lines; the Phase-1 council refuted validating non-enum env usage).
    if (entry.kind === 'enum' && !settingValueValid(entry, v)) {
      return { value: entry.default, source: 'default', note: `env value "${v}" is not a supported ${key} — the wrapper runs the built-in default` };
    }
    return { value: v, source: 'env' };
  }
  const fileEntries = parsed.byKey.get(key);
  if (fileEntries && fileEntries.length) {
    const v = fileEntries[fileEntries.length - 1].value; // last occurrence wins
    if (settingValueValid(entry, v)) return { value: v, source: 'file' };
    return { value: entry.default, source: 'default', note: `file value "${v}" is invalid — falls back to the built-in default` };
  }
  return { value: entry.default, source: 'default' };
};

export const displayValue = (v) => (v == null ? '(unset — wrapper built-in applies)' : v);

// ── the fact-only snapshot the read-only status/advisor surfaces consume ────────────────

// Best-effort, never throws: the ACTIVE knobs (a non-default value is in play — source env/file,
// non-null) plus file presence + any unknown/duplicate keys. Model/effort are structurally excluded
// from the registry, so `active` can NEVER carry a model claim (the fact-only guarantee). A corrupt
// bundle or fs error degrades to `{ error }` — the caller renders that localized-on-error, never crashes.
export const settingsSnapshot = (ctx = {}) => {
  try {
    const registry = loadRegistry(ctx);
    const path = settingsPath(ctx);
    const fileState = readFileState(path, ctx);
    // A symlink / non-regular / unreadable file is IGNORED by the wrappers (built-in defaults apply) —
    // surface that honestly instead of silently omitting it (the wrappers warn; the status must too).
    if (fileState.state === 'unusable') {
      return { path, fileState: 'unusable', active: [], unknown: [], duplicates: [], error: 'the settings file is a symlink / not a regular file — ignored, built-in defaults apply' };
    }
    const parsed = parseSettings(fileState.text ?? '');
    const getenv = ctx.getenv ?? process.env;
    const active = [];
    for (const entry of registry.values()) {
      const eff = effectiveOf(entry, parsed, getenv);
      // ACTIVE = a non-default value is genuinely in effect (source env/file AND differs from the
      // built-in default). A value that merely equals the default keeps every surface byte-identical to
      // "nothing set" — the "status line unchanged unless a knob is active" contract.
      if ((eff.source === 'env' || eff.source === 'file') && eff.value != null && eff.value !== entry.default) {
        active.push({ key: entry.key, value: eff.value, source: eff.source, bridge: entry.bridge });
      }
    }
    return {
      path,
      fileState: fileState.state,
      active,
      unknown: [...parsed.byKey.keys()].filter((k) => !registry.has(k)),
      duplicates: duplicateKeys(parsed),
    };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err), active: [] };
  }
};

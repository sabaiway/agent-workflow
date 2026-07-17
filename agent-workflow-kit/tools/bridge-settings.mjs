#!/usr/bin/env node
// bridge-settings.mjs — the reader + consent-gated WRITER for the host-level bridge settings file
// (bridges 2.3.0, D6). The four bridge wrappers READ ${XDG_CONFIG_HOME:-~/.config}/agent-workflow/
// bridge-settings.conf (KEY=VALUE lines, parsed never sourced; env > file > built-in default); this is
// the ONLY writer for it. It lives OUTSIDE every kit-managed tree, so a kit refresh never touches it
// (D2 — upgrade-survival is structural). The allowlist + typed validation come from the BUNDLED bridge
// manifests' `settings` blocks (manifest-as-source): the tool never invents a key or a value rule, and
// what it writes always passes the wrappers' own aw_settings_valid (the shared settingValueValid).
//
// Posture (D3, guarded): PREVIEW BY DEFAULT; --apply writes. It refuses an unknown key, an invalid /
// out-of-range value, and — loudly, naming the key — a file that already carries DUPLICATE keys (it
// never emits duplicates and never edits blindly around them). It touches only the KEY= line it owns,
// preserving every comment/blank/other line verbatim, and creates the dir + file on first apply via
// the hardened out-of-tree atomic writer (symlink/parent/TOCTOU-safe). Model/effort are NOT in the
// allowlist — the wrappers' quality-first guard is untouched (D4). CODEX_SERVICE_TIER carries the
// credit-rate caveat wherever it renders (from the manifest `effect`).
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes when narrating.
// Exit codes: 0 success (reader, preview, or apply); 2 usage (bad args / unknown key / invalid value);
// 1 precondition STOP (duplicate-carrying / symlinked / unreadable file, a write STOP) or a corrupt
// bundle (cannot determine the allowlist). main(argv, ctx) → { code, stdout, stderr }; getenv / home /
// bundleRoot / fs are injectable for host-independent tests.
//
// Dependency-free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { pathToFileURL } from 'node:url';
import { settingValueValid } from './manifest/validate.mjs';
import { writeHostConfigFileAtomic } from './atomic-write.mjs';
import {
  SETTINGS_SUBDIR, SETTINGS_FILENAME, fail, loadRegistry, allowedLabel, settingsDir, settingsPath,
  joinLines, readFileState, parseSettings, duplicateKeys, effectiveOf, displayValue,
} from './bridge-settings-read.mjs';

// ── reader render ──────────────────────────────────────────────────────────────────

const renderReader = (registry, parsed, fileState, ctx, path) => {
  const getenv = ctx.getenv ?? process.env;
  const lines = [`bridge settings — ${path}`];
  if (fileState.state === 'absent') lines.push('  (no settings file yet — every knob is at its built-in default)');
  else if (fileState.state === 'unusable') lines.push('  ⚠ the settings file is a symlink / not a regular file / unreadable — the wrappers ignore it and fall back to built-in defaults');
  lines.push('', '  effective knobs (env > file > built-in default):');
  for (const entry of registry.values()) {
    const eff = effectiveOf(entry, parsed, getenv);
    const note = eff.note ? `  — ${eff.note}` : '';
    lines.push(`    ${entry.key} = ${displayValue(eff.value)}  [${eff.source}]${note}`);
    lines.push(`        ${entry.bridge} · ${allowedLabel(entry)} · ${entry.effect}`);
  }
  const dups = duplicateKeys(parsed);
  const unknown = [...parsed.byKey.keys()].filter((k) => !registry.has(k));
  if (dups.length) lines.push('', `  ⚠ duplicate keys in the file (last wins at read time; the writer refuses to edit until you fix these): ${dups.join(', ')}`);
  if (unknown.length) lines.push('', `  ⚠ unknown keys (ignored by every wrapper): ${unknown.join(', ')}`);
  if (parsed.malformed.length) lines.push('', `  ⚠ malformed lines (ignored): ${parsed.malformed.map((m) => `line ${m.index + 1}`).join(', ')}`);
  lines.push('', `  edit with:  /agent-workflow-kit bridge-settings --set KEY=VALUE   (preview; add --apply to write)`);
  return lines.join('\n');
};

const buildReaderJson = (registry, parsed, fileState, ctx, path) => {
  const getenv = ctx.getenv ?? process.env;
  return {
    path,
    fileState: fileState.state,
    knobs: [...registry.values()].map((entry) => {
      const eff = effectiveOf(entry, parsed, getenv);
      return { key: entry.key, bridge: entry.bridge, kind: entry.kind, effective: eff.value, source: eff.source, note: eff.note ?? null, default: entry.default };
    }),
    duplicateKeys: duplicateKeys(parsed),
    unknownKeys: [...parsed.byKey.keys()].filter((k) => !registry.has(k)),
    malformedLines: parsed.malformed.map((m) => m.index + 1),
  };
};

// ── reconcile (the init/upgrade survival check — read-only, NEVER edits) ───────────────

// Classify every file key against the NEW bundled manifests (the union registry), for the init
// cascade + Mode: upgrade to run AFTER the bridge refresh. It NEVER writes: the file lives outside
// every kit tree (D2), so upgrade-survival is structural — a key the new manifests no longer declare
// (unknown / retired) is a loud flag, PRESERVED verbatim (the lens-region custom-edit posture). One
// tool-composed line per outcome, printed verbatim by the caller. Throws only on a corrupt bundle
// (cannot determine the allowlist) — the caller degrades that best-effort. Outcomes: absent · unusable
// · flagged (unknown/retired keys) · duplicates · ok.
export const reconcileSettings = (ctx = {}) => {
  const registry = loadRegistry(ctx);
  const path = settingsPath(ctx);
  const fileState = readFileState(path, ctx);
  if (fileState.state === 'absent') return { outcome: 'absent', lines: [`  bridge-settings: no settings file — skipped (${path})`] };
  if (fileState.state === 'unusable') return { outcome: 'unusable', lines: [`  bridge-settings: settings file is a symlink / not a regular file — skipped, never edited (${path})`] };
  const parsed = parseSettings(fileState.text);
  const known = [...parsed.byKey.keys()].filter((k) => registry.has(k));
  const unknown = [...parsed.byKey.keys()].filter((k) => !registry.has(k));
  const dups = duplicateKeys(parsed);
  const lines = [];
  if (unknown.length) lines.push(`  bridge-settings: ${unknown.length} unknown/retired key(s) preserved verbatim (never edited) — compare with the current knobs when convenient: ${unknown.join(', ')}`);
  if (dups.length) lines.push(`  bridge-settings: duplicate key(s) — the reader takes the last; fix by hand before the writer will edit: ${dups.join(', ')}`);
  if (!unknown.length && !dups.length) lines.push(`  bridge-settings: ${known.length} key(s) recognized, all current`);
  return { outcome: unknown.length ? 'flagged' : dups.length ? 'duplicates' : 'ok', lines };
};

// ── writer ─────────────────────────────────────────────────────────────────────────

// argv → { ops, apply, dryRun, json }. `--set KEY=VALUE` / `--unset KEY` (inline `=` forms too). A
// duplicate op for the same key, an unknown flag, or --dry-run WITH --apply → usage error (2). Order-
// independent so a later flag never silently decides whether the tool mutates.
const parseArgs = (argv) => {
  const ops = [];
  const seen = new Set();
  const flags = { apply: false, dryRun: false, json: false };
  const takeOp = (kind, tok) => {
    if (tok === undefined || tok.startsWith('-')) throw fail(2, `--${kind} requires KEY${kind === 'set' ? '=VALUE' : ''}`);
    if (kind === 'set') {
      const eq = tok.indexOf('=');
      if (eq <= 0) throw fail(2, `--set needs KEY=VALUE (got ${JSON.stringify(tok)})`);
      const key = tok.slice(0, eq);
      const value = tok.slice(eq + 1);
      if (seen.has(key)) throw fail(2, `duplicate op for "${key}" — name each key at most once`);
      seen.add(key);
      ops.push({ kind, key, value });
    } else {
      const key = tok;
      if (seen.has(key)) throw fail(2, `duplicate op for "${key}" — name each key at most once`);
      seen.add(key);
      ops.push({ kind, key });
    }
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--set') { takeOp('set', argv[i + 1]); i += 1; }
    else if (a === '--unset') { takeOp('unset', argv[i + 1]); i += 1; }
    else if (a.startsWith('--set=')) takeOp('set', a.slice('--set='.length));
    else if (a.startsWith('--unset=')) takeOp('unset', a.slice('--unset='.length));
    else if (a.startsWith('-')) throw fail(2, `unknown flag: ${a}`);
    else throw fail(2, `unexpected argument: ${a}`);
  }
  if (flags.apply && flags.dryRun) throw fail(2, '--apply does not combine with --dry-run (default is preview)');
  return { ops, ...flags };
};

// Validate ops against the registry: an unknown key or an out-of-range/invalid value is refused (2)
// BEFORE any file read, so a typo never reaches the settings file.
const validateOps = (ops, registry) => {
  for (const op of ops) {
    const entry = registry.get(op.key);
    if (!entry) throw fail(2, `unknown key "${op.key}" — not a settings knob of any bundled bridge. Known keys: ${[...registry.keys()].join(', ')}`);
    if (op.kind === 'set' && !settingValueValid(entry, op.value)) {
      throw fail(2, `invalid value "${op.value}" for ${op.key} — allowed: ${allowedLabel(entry)}`);
    }
  }
};

// Apply one op to the line array: replace the single owned KEY= line, append it, or drop it. The caller
// guarantees the file carries no duplicate keys, so findIndex hits at most one line. `startsWith(KEY=)`
// is exact (the `=` anchors it: `FOO_BAR=` never matches key `FOO`).
const applyOp = (lines, op) => {
  const idx = lines.findIndex((l) => l.startsWith(`${op.key}=`));
  if (op.kind === 'set') {
    const newLine = `${op.key}=${op.value}`;
    return idx === -1 ? [...lines, newLine] : lines.map((l, i) => (i === idx ? newLine : l));
  }
  return idx === -1 ? lines : lines.filter((_, i) => i !== idx);
};

const changeLine = (c) => {
  const b = c.before == null ? '(unset)' : c.before;
  const a = c.kind === 'set' ? c.after : '(unset — built-in default applies)';
  return `  ${c.key}: ${b} → ${a}`;
};

const renderWriter = ({ changes, wrote, path, willWrite, envShadows, caveats }) => {
  const lines = [];
  lines.push(wrote ? `wrote ${path}` : 'bridge-settings — preview (nothing written; re-run with --apply to write)');
  for (const c of changes) lines.push(changeLine(c));
  for (const cav of caveats) lines.push(`      ↳ ${cav}`);
  for (const key of envShadows) lines.push(`  ⚠ ${key} is currently set in the environment — the env value overrides the file for this session (unset it, or it wins until you do).`);
  if (!wrote && willWrite) lines.push('', `re-run with --apply to write ${path}.`);
  if (!wrote && !willWrite) lines.push('  no change — the file already reads this way.');
  return lines.join('\n');
};

// ── main ───────────────────────────────────────────────────────────────────────────

const HELP = `bridge-settings — read / write the host-level bridge settings file.

  ${'${XDG_CONFIG_HOME:-~/.config}'}/${SETTINGS_SUBDIR}/${SETTINGS_FILENAME}   (KEY=VALUE lines; parsed, never sourced)

Usage:
  node bridge-settings.mjs                          show every knob's effective value + source
  node bridge-settings.mjs --set KEY=VALUE          preview a change (writes nothing)
  node bridge-settings.mjs --set KEY=VALUE --apply  write the change (atomic; creates the file on first use)
  node bridge-settings.mjs --unset KEY [--apply]    return a knob to its built-in default
  node bridge-settings.mjs --json                   machine-readable read-out
  node bridge-settings.mjs --reconcile              init/upgrade survival check: flag unknown/retired
                                                    keys (preserved verbatim), never writes

Precedence at run time: explicit env (even empty: KEY= disables) > this file > the wrapper's built-in
default. Allowed keys + value rules come from the bundled bridge manifests; model/effort are NOT
settable here (the wrappers' quality guard is untouched). This host file survives every kit upgrade —
a kit refresh never writes or clobbers it.

Exit codes: 0 success (read / preview / write); 2 usage (bad args, unknown key, invalid value);
            1 precondition STOP (duplicate-carrying / symlinked / unreadable file, or a corrupt bundle).`;

export const main = (argv = [], ctx = {}) => {
  const getenv = ctx.getenv ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    // Reconcile mode (init/upgrade survival check) — classify keys, never write, exit 0 on any outcome.
    // It is a standalone mode: a write flag/op alongside it is a usage error, never silently ignored
    // (a consent-gated writer never lets a stray flag make a caller think it wrote when it only classified).
    if (argv.includes('--reconcile')) {
      const extra = argv.filter((a) => a !== '--reconcile');
      if (extra.length) throw fail(2, `--reconcile takes no other arguments (got ${extra.join(' ')}) — it only classifies keys, never writes`);
      return { code: 0, stdout: reconcileSettings(ctx).lines.join('\n'), stderr: '' };
    }
    const { ops, apply, json } = parseArgs(argv);
    const registry = loadRegistry(ctx);
    const path = settingsPath(ctx);

    // Reader (no ops): show effective settings. Best-effort — an unusable file warns but still exits 0.
    if (ops.length === 0) {
      const fileState = readFileState(path, ctx);
      const parsed = parseSettings(fileState.text ?? '');
      const stdout = json
        ? JSON.stringify(buildReaderJson(registry, parsed, fileState, ctx, path), null, 2)
        : renderReader(registry, parsed, fileState, ctx, path);
      return { code: 0, stdout, stderr: '' };
    }

    // Writer. Validate the ops against the registry BEFORE the file is even read — a typo / unknown key /
    // out-of-range value is refused (exit 2) without touching the file, exactly as the mode doc promises.
    validateOps(ops, registry);
    const fileState = readFileState(path, ctx);
    if (fileState.state === 'unusable') {
      throw fail(1, `the settings file is a symlink / not a regular file / unreadable — refusing to write through it: ${path}`);
    }
    const parsed = parseSettings(fileState.text ?? '');
    const dups = duplicateKeys(parsed);
    if (dups.length) {
      throw fail(1, `the settings file already carries duplicate keys (${dups.join(', ')}) — refusing to edit it. Fix the duplicates by hand first: ${path}`);
    }

    const changes = ops.map((op) => {
      const before = parsed.byKey.get(op.key)?.at(-1)?.value ?? null;
      const after = op.kind === 'set' ? op.value : null;
      return { key: op.key, kind: op.kind, before, after, entry: registry.get(op.key) };
    });
    const noop = changes.every((c) => (c.kind === 'set' ? c.before === c.after : c.before === null));
    // The credit-rate / spend caveat rides with any knob whose manifest effect flags a cost (D4).
    const caveats = changes
      .filter((c) => c.kind === 'set' && /credit rate|SPEND KNOB/i.test(c.entry.effect))
      .map((c) => `${c.key}: ${c.entry.effect}`);
    const envShadows = changes
      .filter((c) => Object.prototype.hasOwnProperty.call(getenv, c.key))
      .map((c) => c.key);

    const newLines = ops.reduce(applyOp, parsed.lines);
    const body = joinLines(newLines);

    // The machine surface carries the SAME spend/credit-rate caveats the human preview prints (D4) — a
    // --json consumer must not miss the 2.5x-credit consent warning the human render shows.
    const jsonBody = (wrote) => ({ path, wrote, noop, changes: changes.map((c) => ({ key: c.key, kind: c.kind, before: c.before, after: c.after })), envShadows, caveats });

    if (!apply || noop) {
      const stdout = json
        ? JSON.stringify(jsonBody(false), null, 2)
        : renderWriter({ changes, wrote: false, path, willWrite: !noop, envShadows, caveats });
      return { code: 0, stdout, stderr: '' };
    }

    // --apply. The out-of-tree atomic writer creates the dir + file on first use; symlink/parent/TOCTOU-safe.
    writeHostConfigFileAtomic(settingsDir(ctx), SETTINGS_FILENAME, body, ctx, { noun: 'the bridge settings file' });
    const stdout = json
      ? JSON.stringify(jsonBody(true), null, 2)
      : renderWriter({ changes, wrote: true, path, willWrite: false, envShadows, caveats });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `bridge-settings: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}

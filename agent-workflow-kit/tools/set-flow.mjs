#!/usr/bin/env node
// set-flow.mjs — the ARMING writer for the `flow` block of docs/ai/orchestration.json (flow
// orchestration, Plan 3 Step 3.1). Division of labor mirrors set-recipe (AD-025): the AGENT turns
// plain language into explicit `--preset` / `--set <key>=<value>` / `--unset <key>` ops; the KIT
// does the deterministic parse → merge → floor-check → preview → write. Preview by default;
// `--write` applies via the hardened writeConfig. It NEVER commits and NEVER runs a backend.
//
// Merge semantics (#30): the preset is a SEED — its values come verbatim from the ONE schema-1
// literal (FLOW_SCHEMA_1_FIXTURE, P20; candidates stay explicit — they name the project's real
// backends); explicit --set keys win over the seed, the seed wins over the existing block, and
// `schema` is pinned by the kit (never an op). The merged result previews before any write.
//
// Arming floors (#31 — validateConfig stays shape-only; EVERY deep floor lives here):
//   • kitMinVersion (Decision 6, #54): the null-GUARDED semver comparison characterized in the
//     FLOW-VERSION-FLOORS block of semver-lite.test.mjs — an unparseable version on EITHER side
//     never passes (the bare `>= 0` shape fails open on null and is banned).
//   • debtQueue / convergenceSummary (#37/#69): each declared path must be a single regular
//     TRACKED file OR carry its explicit declared-excluded flag (loud); never a symlink or
//     directory on disk; never under docs/ai/; never a literal substring of any declared gate cmd
//     (docs/ai/gates.json). The undecidable remainder is printed as a DISCLOSED residual
//     (FLOW_BOOKKEEPING_FLOOR_RESIDUAL), never a pretended rule.
// Floor refusals hold on the preview AND the write lane (a preview that could never write is
// already a failed check) — exit 1, nothing written.
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes when
// narrating. Exit codes: 0 success/preview; 2 usage (bad key/value/flag); 1 floor refusal, config
// error, or a write STOP. main(argv, ctx) → { code, stdout, stderr }; cwd / fs / git / kit
// version are injectable for hermetic tests. Dependency-free, Node >= 22. No side effects on
// import (the isDirectRun idiom).

import { readFileSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_REL,
  fail,
  loadConfig,
  validateConfig,
  serializeConfig,
  FLOW_SCHEMA_VERSION,
  FLOW_SCHEMA_1_KEYS,
  FLOW_PRESET_VALUES,
  FLOW_CANDIDATE_CLASSES,
  FLOW_SCHEMA_1_FIXTURE,
} from './orchestration-config.mjs';
import { isDirectRun } from './direct-run.mjs';
import { writeConfig as writeConfigFs } from './orchestration-write.mjs';
import { loadDeclaration } from './run-gates.mjs';
import { compareSemver } from './semver-lite.mjs';
import { lexicalRepoRelative } from './core-evidence.mjs';
import { readAuthoritativeVersion } from './manifest/validate.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATES_REL = 'docs/ai/gates.json';

// The honest boundary of the bookkeeping floors — printed on EVERY floor evaluation and
// doc-parity-bound into the set-flow mode doc, so the admission can never be reworded away.
export const FLOW_BOOKKEEPING_FLOOR_RESIDUAL =
  'the bookkeeping floors decide only what is decidable at arming time: a gate command reading the declared path INDIRECTLY (through its own script), content-level abuse inside the file, and a path re-pointed after arming stay undecided — bookkeeping WRITES are bound by digest and custody proof at the checker instead (#37/#69); this line is the honest boundary, not a pretended rule';

// ── op parsing (usage errors → exit 2) ──────────────────────────────────────────────

// The settable key set = the closed schema-1 surface minus the kit-pinned `schema`.
const SETTABLE_KEYS = FLOW_SCHEMA_1_KEYS.filter((k) => k !== 'schema');

const parseCandidates = (raw) => {
  if (raw === '') return [];
  return raw.split(',').map((token) => {
    const at = token.indexOf(':');
    if (at <= 0 || at === token.length - 1) {
      throw fail(2, `--set candidates takes comma-separated <name>:<class> pairs (got "${token}") — e.g. candidates=codex:review,agy:review`);
    }
    const name = token.slice(0, at);
    const cls = token.slice(at + 1);
    if (!FLOW_CANDIDATE_CLASSES.includes(cls)) {
      throw fail(2, `candidate class must be one of ${FLOW_CANDIDATE_CLASSES.join(' | ')} (got "${cls}")`);
    }
    return { name, class: cls };
  });
};

// One typed value parser per settable key — a malformed value is a USAGE error; the shape walk
// (validateConfig) re-checks the merged result defensively.
const parseFlowValue = (key, raw) => {
  if (key === 'preset') {
    if (!FLOW_PRESET_VALUES.includes(raw)) throw fail(2, `preset must be one of ${FLOW_PRESET_VALUES.join(' | ')} (got "${raw}")`);
    return raw;
  }
  if (key === 'councilRounds') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) throw fail(2, `councilRounds must be a positive integer (got "${raw}")`);
    return n;
  }
  if (key === 'debtQueueExcluded' || key === 'convergenceSummaryExcluded') {
    if (raw !== 'true' && raw !== 'false') throw fail(2, `${key} must be true or false (got "${raw}")`);
    return raw === 'true';
  }
  if (key === 'pregateExclude') {
    if (raw === '') return [];
    const ids = raw.split(',');
    if (ids.some((id) => id === '')) throw fail(2, `pregateExclude carries an empty gate id (got "${raw}") — comma-separated non-empty gate ids, e.g. pregateExclude=unit,lint`);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup !== undefined) throw fail(2, `pregateExclude carries a duplicate gate id "${dup}" (got "${raw}") — name each gate id at most once`);
    return ids;
  }
  if (key === 'candidates') return parseCandidates(raw);
  if (raw === '') throw fail(2, `${key} must be a non-empty value`);
  return raw; // debtQueue / convergenceSummary / kitMinVersion — strings
};

const parseArgs = (argv) => {
  const sets = {};
  const unsets = new Set();
  let preset = null;
  let write = false;
  let json = false;
  const takeSet = (tok) => {
    if (tok === undefined || tok.startsWith('--')) throw fail(2, '--set requires <key>=<value>');
    const eq = tok.indexOf('=');
    if (eq <= 0) throw fail(2, `--set must be <key>=<value> (got "${tok}")`);
    const key = tok.slice(0, eq);
    if (key === 'schema') throw fail(2, `"schema" is pinned by the kit (${FLOW_SCHEMA_VERSION}) — never an op`);
    if (!SETTABLE_KEYS.includes(key)) throw fail(2, `unknown flow key "${key}" (settable: ${SETTABLE_KEYS.join(', ')})`);
    if (key in sets || unsets.has(key)) throw fail(2, `duplicate op for flow key "${key}" — name each key at most once`);
    sets[key] = parseFlowValue(key, tok.slice(eq + 1));
  };
  const takeUnset = (tok) => {
    if (tok === undefined || tok.startsWith('--')) throw fail(2, '--unset requires <key>');
    if (tok === 'schema') throw fail(2, '"schema" is pinned by the kit — never an op');
    if (!SETTABLE_KEYS.includes(tok)) throw fail(2, `unknown flow key "${tok}" (settable: ${SETTABLE_KEYS.join(', ')})`);
    if (tok in sets || unsets.has(tok)) throw fail(2, `duplicate op for flow key "${tok}" — name each key at most once`);
    unsets.add(tok);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--write') write = true;
    else if (a === '--preset') {
      const tok = argv[i + 1];
      if (tok === undefined || tok.startsWith('--')) throw fail(2, `--preset requires one of ${FLOW_PRESET_VALUES.join(' | ')}`);
      if (preset !== null) throw fail(2, 'duplicate --preset — name one seed at most once');
      if (!FLOW_PRESET_VALUES.includes(tok)) throw fail(2, `unknown preset "${tok}" (known: ${FLOW_PRESET_VALUES.join(', ')})`);
      preset = tok;
      i += 1;
    } else if (a.startsWith('--preset=')) {
      const tok = a.slice('--preset='.length);
      if (preset !== null) throw fail(2, 'duplicate --preset — name one seed at most once');
      if (!FLOW_PRESET_VALUES.includes(tok)) throw fail(2, `unknown preset "${tok}" (known: ${FLOW_PRESET_VALUES.join(', ')})`);
      preset = tok;
    } else if (a === '--set') { takeSet(argv[i + 1]); i += 1; }
    else if (a === '--unset') { takeUnset(argv[i + 1]); i += 1; }
    else if (a.startsWith('--set=')) takeSet(a.slice('--set='.length));
    else if (a.startsWith('--unset=')) takeUnset(a.slice('--unset='.length));
    else if (a.startsWith('-')) throw fail(2, `unknown flag: ${a}`);
    else throw fail(2, `unexpected argument: ${a}`);
  }
  if (write && preset === null && Object.keys(sets).length === 0 && unsets.size === 0) {
    throw fail(2, 'nothing to write — pass --preset and/or at least one --set/--unset (a bare --write is a no-op)');
  }
  return { sets, unsets, preset, write, json };
};

// ── the merge (#30: existing < preset seed < explicit ops; schema pinned) ───────────

// The preset SEED = the schema-1 literal fixture's values verbatim (P20 — the arming path consumes
// the SAME fixture the structural validator pins), with the preset key set to the chosen preset.
// Candidates are never seeded — they name the project's REAL backends and stay explicit.
const presetSeed = (preset) => ({
  preset,
  councilRounds: FLOW_SCHEMA_1_FIXTURE.councilRounds,
  debtQueue: FLOW_SCHEMA_1_FIXTURE.debtQueue,
  convergenceSummary: FLOW_SCHEMA_1_FIXTURE.convergenceSummary,
  debtQueueExcluded: FLOW_SCHEMA_1_FIXTURE.debtQueueExcluded,
  convergenceSummaryExcluded: FLOW_SCHEMA_1_FIXTURE.convergenceSummaryExcluded,
  pregateExclude: [...FLOW_SCHEMA_1_FIXTURE.pregateExclude],
  kitMinVersion: FLOW_SCHEMA_1_FIXTURE.kitMinVersion,
});

export const mergeFlowBlock = ({ existing, preset, sets, unsets }) => {
  const merged = {
    ...(existing ?? {}),
    ...(preset === null ? {} : presetSeed(preset)),
    ...sets,
    schema: FLOW_SCHEMA_VERSION,
  };
  for (const key of unsets) delete merged[key];
  return merged;
};

// ── the arming floors (#31 — deep checks live HERE only) ────────────────────────────

// Decision 6: the guarded shape from the FLOW-VERSION-FLOORS characterization — null (unparseable
// EITHER side) never meets a floor; the bare `>= 0` relational is the trap this refuses to repeat.
const meetsVersionFloor = (version, floor) => {
  const cmp = compareSemver(version, floor);
  return cmp !== null && cmp >= 0;
};

const defaultRunGit = (args, cwd) => spawnSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true });

const gitToplevel = (cwd, runGit) => {
  const r = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (r.error || r.status !== 0) return null;
  const top = r.stdout.toString('utf8').replace(/\r?\n$/, '');
  return top === '' ? null : top;
};

// Single-regular-tracked-file check via a strict -z parse of a LITERAL pathspec: exactly one
// stage-0 entry whose path EQUALS the declared rel and whose mode is plain 100644.
const TRACKED_ENTRY_RE = /^(100644) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t(.*)$/;
const isSingleRegularTrackedFile = (top, rel, runGit) => {
  const out = runGit(['ls-files', '-s', '-z', '--', `:(literal)${rel}`], top);
  if (out.error || out.status !== 0) return { ok: false, reason: 'git ls-files failed — tracked-ness is undecidable (fail closed)' };
  const text = out.stdout.toString('utf8');
  if (text === '') return { ok: false, reason: 'not tracked' };
  if (!text.endsWith('\0')) return { ok: false, reason: 'unparseable git ls-files output — tracked-ness is undecidable (fail closed)' };
  const entries = text.slice(0, -1).split('\0');
  if (entries.length !== 1) return { ok: false, reason: `${entries.length} index entries — a single tracked file is required` };
  const m = TRACKED_ENTRY_RE.exec(entries[0]);
  if (m === null || m[3] !== rel) return { ok: false, reason: 'not a plain stage-0 100644 regular-file index entry' };
  return { ok: true };
};

// No-follow walk over every ancestor prefix of the declared path under the toplevel: a symlinked
// component would let the leaf checks judge a different physical home than the spelling claims.
const symlinkedAncestor = (top, rel, lstat) => {
  const segments = rel.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i).join('/');
    let st = null;
    try {
      st = lstat(join(top, prefix));
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true }; // nothing deeper exists to alias
      return { ok: false, failure: `unstatable ancestor "${prefix}" (${(err && err.code) || (err && err.message) || err}) — the class walk is undecidable (fail closed)` };
    }
    if (st.isSymbolicLink()) return { ok: false, failure: `ancestor "${prefix}" is a symlink — the class walk is no-follow (fail closed, #37)` };
  }
  return { ok: true };
};

const bookkeepingFloorFailures = ({ key, rel, excluded, top, gates, lstat, runGit }) => {
  const failures = [];
  const notes = [];
  const lex = lexicalRepoRelative(rel);
  if (!lex.ok) {
    failures.push(`flow.${key} "${rel}": must be lexically repo-relative — ${lex.reason} (#37)`);
    return { failures, notes };
  }
  // lexicalRepoRelative NORMALIZES interior dot segments — a "docs/plans/../ai/…" spelling would
  // dodge every raw-prefix floor below while resolving inside docs/ai (fail closed on segments).
  // A backslash byte is refused outright: on Windows it is a separator the raw-prefix floors do
  // not judge, so "docs\\ai\\…" would resolve under docs/ai there — forward-slash only.
  if (rel.includes('\\')) {
    failures.push(`flow.${key} "${rel}": carries a backslash — forward-slash is the only separator the floors judge (#37)`);
    return { failures, notes };
  }
  if (rel.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    failures.push(`flow.${key} "${rel}": must be a plain forward-slash path without "." or ".." segments (#37)`);
    return { failures, notes };
  }
  if (rel === 'docs/ai' || rel.startsWith('docs/ai/')) {
    failures.push(`flow.${key} "${rel}": a bookkeeping path never lives under docs/ai/ (#37)`);
  }
  for (const gate of gates) {
    if (gate.cmd.includes(rel)) {
      failures.push(`flow.${key} "${rel}": a literal substring of declared gate "${gate.id}"'s cmd — a bookkeeping path never feeds a gate (#37)`);
    }
  }
  if (top === null) {
    failures.push(`flow.${key} "${rel}": not inside a git work tree — the disk class and tracked-ness are undecidable (fail closed)`);
    return { failures, notes };
  }
  const walk = symlinkedAncestor(top, rel, lstat);
  if (!walk.ok) {
    failures.push(`flow.${key} "${rel}": ${walk.failure}`);
    return { failures, notes };
  }
  let st = null;
  try {
    st = lstat(join(top, rel));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      failures.push(`flow.${key} "${rel}": unstatable (${(err && err.code) || (err && err.message) || err}) — the disk class is undecidable (fail closed)`);
      return { failures, notes };
    }
  }
  if (st?.isSymbolicLink()) failures.push(`flow.${key} "${rel}": a symlink — never a bookkeeping path (#37)`);
  else if (st?.isDirectory()) failures.push(`flow.${key} "${rel}": a directory — never a bookkeeping path (#37)`);
  else if (st && !st.isFile()) failures.push(`flow.${key} "${rel}": not a regular file — never a bookkeeping path (#37)`);
  else if (st == null && !excluded) {
    // Only the declared-excluded lane may point at a not-yet-present machine-local file; a
    // tracked path deleted from the worktree would otherwise pass on its index entry alone.
    failures.push(`flow.${key} "${rel}": absent from the worktree — a bookkeeping file must exist as a regular file on disk, or be declared excluded loudly (#37/#69)`);
  }
  if (excluded) {
    notes.push(`flow.${key} "${rel}": DECLARED-EXCLUDED — the tracked-file floor is waived by the explicit declaration (hide-footprint support, #31); the checker still binds its writes by digest and custody proof`);
    return { failures, notes };
  }
  const tracked = isSingleRegularTrackedFile(top, rel, runGit);
  if (!tracked.ok) {
    failures.push(`flow.${key} "${rel}": ${tracked.reason} — track it as a single regular file, or declare it excluded loudly (${key}Excluded: true) (#37/#69)`);
  }
  return { failures, notes };
};

// The declaration is read through the gate runner's OWN loader (loadDeclaration: lstat-first, so
// a dangling symlink reads as present-but-unreadable, then the shared structural validator) —
// only a TRULY absent file means "no gates"; every other failure is an undecidable gate-cmd
// floor, never a silently-empty gate list (fail closed).
const readDeclaredGates = (cwd, readFile, lstat) => {
  try {
    const declaration = loadDeclaration(cwd, { readFile, lstat });
    return { gates: declaration.outcome === 'missing' ? [] : declaration.gates };
  } catch (err) {
    return { error: `${err.message} — the gate-cmd floor is undecidable (fail closed)` };
  }
};

// evaluateArmingFloors(merged, io) → { failures, notes }. Pure over injected io; consulted on the
// preview AND the write lane (same verdicts both ways).
export const evaluateArmingFloors = (merged, { cwd, readFile, lstat, runGit, kitVersion }) => {
  const failures = [];
  const notes = [];
  if (typeof merged.kitMinVersion === 'string') {
    if (!meetsVersionFloor(kitVersion, merged.kitMinVersion)) {
      failures.push(`flow.kitMinVersion "${merged.kitMinVersion}": this kit (${kitVersion ?? 'unknown version'}) does not meet the declared floor — the comparison is null-guarded: an unparseable version on either side never passes (Decision 6, #54)`);
    }
  }
  const declared = [
    { key: 'debtQueue', rel: merged.debtQueue, excluded: merged.debtQueueExcluded === true },
    { key: 'convergenceSummary', rel: merged.convergenceSummary, excluded: merged.convergenceSummaryExcluded === true },
  ].filter((d) => typeof d.rel === 'string');
  if (declared.length > 0) {
    const gatesRead = readDeclaredGates(cwd, readFile, lstat);
    if (gatesRead.error) {
      failures.push(gatesRead.error);
    } else {
      const top = gitToplevel(cwd, runGit);
      for (const d of declared) {
        const r = bookkeepingFloorFailures({ ...d, top, gates: gatesRead.gates, lstat, runGit });
        failures.push(...r.failures);
        notes.push(...r.notes);
      }
    }
  }
  return { failures, notes };
};

// ── rendering (ENGLISH; the agent localizes) ────────────────────────────────────────

const valueLabel = (v) => (v === undefined ? '(absent)' : JSON.stringify(v));

const changedKeys = (before, after) => {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();
  return keys
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ key: k, from: before?.[k], to: after[k] }));
};

// Three honest not-written headers (the reviewer's D-branch split): a pure preview may invite
// --write; a REQUESTED write that wrote nothing states exactly why and never re-invites itself.
const formatHuman = ({ changed, merged, floors, wrote, writeRequested, noop, fileBody }) => {
  const floorsOk = floors.failures.length === 0;
  const lines = [];
  if (wrote) lines.push(`wrote ${CONFIG_REL}`);
  else if (writeRequested && !floorsOk) lines.push('set-flow — nothing written (arming floors refused)');
  else if (writeRequested && noop) lines.push('set-flow — nothing written (the merged flow block equals the current one)');
  else lines.push('set-flow — preview (nothing written)');
  for (const c of changed) lines.push(`  flow.${c.key}: ${valueLabel(c.from)} → ${valueLabel(c.to)}`);
  if (noop && !writeRequested) lines.push('  no changes — the merged flow block equals the current one.');
  lines.push('', 'merged flow block:', JSON.stringify(merged, null, 2));
  for (const note of floors.notes) lines.push(`  ⚠ ${note}`);
  if (floorsOk) lines.push('  arming floors: PASS');
  for (const f of floors.failures) lines.push(`  FLOOR REFUSED — ${f}`);
  lines.push(`  residual: ${FLOW_BOOKKEEPING_FLOOR_RESIDUAL}`);
  if (wrote && fileBody) lines.push('', `${CONFIG_REL} now reads:`, fileBody.replace(/\n$/, ''));
  if (wrote) lines.push('', 'the CONFIG half is armed — the chain half arms at plan adoption (flow-writer adoption <plan-file>); gates-init offers the checker TRIO for a flow-carrying config.');
  if (!wrote && !writeRequested && !noop && floorsOk) lines.push('', `would write ${CONFIG_REL} — re-run with --write to apply.`);
  if (!wrote && !floorsOk) lines.push('', 'nothing will be written until every floor passes.');
  return lines.join('\n');
};

const buildJson = ({ changed, merged, floors, writtenPath, noop }) => ({
  changed: changed.map((c) => ({ key: c.key, from: c.from ?? null, to: c.to ?? null })),
  merged,
  floors: { ok: floors.failures.length === 0, failures: floors.failures, notes: floors.notes, residual: FLOW_BOOKKEEPING_FLOOR_RESIDUAL },
  writtenPath: writtenPath ?? null,
  noop,
});

const HELP = `set-flow — arm the flow block of the per-project orchestration config (${CONFIG_REL}).

Usage:
  node set-flow.mjs [--preset <${FLOW_PRESET_VALUES.join('|')}>] [--set <key>=<value>]... [--unset <key>]... [--write] [--json]

  --preset  seed the block from the schema-1 canon (explicit --set keys win; candidates stay explicit)
  --set     <key>=<value> — settable keys: ${SETTABLE_KEYS.join(', ')}
            (candidates: <name>:<class> pairs, comma-separated; pregateExclude: comma-separated ids)
  --unset   <key> — drop a key from the flow block ("schema" is pinned by the kit)
  --write   apply (default: preview only — writes nothing)
  --json    machine-readable output

Deep arming floors run HERE only (#31; validateConfig stays shape-only): the null-guarded
kitMinVersion comparison (an unparseable version never passes), and the bookkeeping floors —
debtQueue/convergenceSummary each a single regular TRACKED file or loudly declared-excluded,
never a symlink/directory, never under docs/ai/, never a literal substring of a declared gate cmd.
The undecidable remainder prints as a disclosed residual. Floors hold on preview AND write.

Exit codes: 0 success/preview; 2 usage; 1 floor refusal, config error, or a write STOP.`;

// ── main ────────────────────────────────────────────────────────────────────────────

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const readFile = ctx.readFileSync ?? readFileSync;
  const lstat = ctx.lstatSync ?? lstatSync;
  const writeConfig = ctx.writeConfig ?? writeConfigFs;
  const runGit = ctx.runGit ?? defaultRunGit;
  const kitVersion = 'kitVersion' in ctx ? ctx.kitVersion : readAuthoritativeVersion(KIT_ROOT).version;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const { sets, unsets, preset, write, json } = parseArgs(argv);
    const { config: current } = loadConfig(cwd, readFile, lstat);

    if (preset === null && Object.keys(sets).length === 0 && unsets.size === 0) {
      if (json) return { code: 0, stdout: JSON.stringify({ flow: current?.flow ?? null, noop: true }, null, 2), stderr: '' };
      const shown = current?.flow === undefined ? `(no flow block in ${CONFIG_REL} yet — the flow is config-unarmed)` : JSON.stringify(current.flow, null, 2);
      const hint = `\nPass --preset ${FLOW_PRESET_VALUES.join('|')} and/or --set <key>=<value> (preview), then --write to apply.`;
      return { code: 0, stdout: `${shown}${hint}`, stderr: '' };
    }

    const merged = mergeFlowBlock({ existing: current?.flow, preset, sets, unsets });
    const after = { ...(current ?? {}), flow: merged };
    validateConfig(after); // shape walk (closed key set + per-key types) — defensive; ops pre-validate
    const floors = evaluateArmingFloors(merged, { cwd, readFile, lstat, runGit, kitVersion });
    const changed = changedKeys(current?.flow, merged);
    const noop = changed.length === 0;
    const floorsOk = floors.failures.length === 0;

    if (!write || noop || !floorsOk) {
      const stdout = json
        ? JSON.stringify(buildJson({ changed, merged, floors, writtenPath: null, noop }), null, 2)
        : formatHuman({ changed, merged, floors, wrote: false, writeRequested: write, noop });
      return { code: floorsOk ? 0 : 1, stdout, stderr: floorsOk ? '' : 'set-flow: arming floors refused — nothing written' };
    }

    const { writtenPath } = writeConfig(cwd, after, ctx);
    const fileBody = serializeConfig(after);
    const stdout = json
      ? JSON.stringify(buildJson({ changed, merged, floors, writtenPath, noop: false }), null, 2)
      : formatHuman({ changed, merged, floors, wrote: true, writeRequested: true, noop: false, fileBody });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `set-flow: ${err.message}` };
  }
};

if (isDirectRun(import.meta.url)) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}

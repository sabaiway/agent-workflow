#!/usr/bin/env node
// set-recipe.mjs — the WRITER for docs/ai/orchestration.json. The division of labor (AD-025): the AGENT
// turns plain language into explicit `--set <activity>.<slot>=<recipe>` / `--unset <activity>.<slot>`
// ops; the KIT does the deterministic validate → merge → preview → write. The kit ships NO NL parser
// (stays dependency-free + deterministic) and performs no `all`-magic — the agent expands "both review"
// into explicit per-activity ops (asking if scope is unclear).
//
// Posture: PREVIEW BY DEFAULT (dry-run); `--write` applies. It NEVER commits and NEVER runs a backend.
// It previews current→proposed for the CHANGED slots only, resolves the effective recipe vs LIVE backend
// readiness (degradation honesty on BOTH the preview and the --write path), and writes only via the
// hardened writeConfig (deployment gate; exclusive-create tmp+rename; symlink/TOCTOU-safe; last-writer-
// wins). A no-op set never writes and never spuriously seeds the _README. `--unset` returns a slot to its
// computed default, so reverting needs no hand-edit either. Hand-edit stays first-class — this is an
// OFFERED convenience, never a lock.
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes to the user's
// language when narrating. Exit codes: 0 success (an explicit recipe that gracefully degrades is still
// 0); 2 usage (bad/duplicate op, --write with zero ops); 1 config error (malformed/unreadable config)
// or a write STOP (no deployment / symlinked leaf). main(argv, ctx) → { code, stdout, stderr }; cwd /
// env / home / detect / fs are injectable for host-independent tests.
//
// Dependency-free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { detectBackends } from './detect-backends.mjs';
import { resolveActivityRecipe, composeActiveRecipeLine } from './recipes.mjs';
import { loadAutonomy, resolveAutonomy } from './autonomy-config.mjs';
import {
  CONFIG_REL,
  fail,
  loadConfig,
  validateConfig,
  parseOp,
  applySetOps,
  serializeConfig,
  CANON_README,
} from './orchestration-config.mjs';
import { writeConfig as writeConfigFs } from './orchestration-write.mjs';

// ── argument parsing (usage errors → exit 2) ────────────────────────────────────────

// Parse argv → { ops, write, json }. `--set`/`--unset` take a fully-qualified token (parseOp validates
// it). A duplicate op for the same activity.slot, a `--write` with zero ops, an unknown flag, or a bad
// token → exit 2. `--set=<tok>` / `--unset=<tok>` inline forms are accepted too.
const parseArgs = (argv) => {
  const ops = [];
  const seen = new Set();
  let write = false;
  let json = false;
  const takeOp = (kind, tok) => {
    if (tok === undefined || tok.startsWith('--')) throw fail(2, `--${kind} requires <activity>.<slot>${kind === 'set' ? '=<recipe>' : ''}`);
    const op = parseOp(kind, tok);
    const key = `${op.activity}.${op.slot}`;
    if (seen.has(key)) throw fail(2, `duplicate op for "${key}" — name each activity.slot at most once`);
    seen.add(key);
    ops.push(op);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--write') write = true;
    else if (a === '--set') { takeOp('set', argv[i + 1]); i += 1; }
    else if (a === '--unset') { takeOp('unset', argv[i + 1]); i += 1; }
    else if (a.startsWith('--set=')) takeOp('set', a.slice('--set='.length));
    else if (a.startsWith('--unset=')) takeOp('unset', a.slice('--unset='.length));
    else if (a.startsWith('-')) throw fail(2, `unknown flag: ${a}`);
    else throw fail(2, `unexpected argument: ${a}`);
  }
  if (write && ops.length === 0) throw fail(2, 'nothing to write — pass at least one --set/--unset (a bare --write is a no-op)');
  return { ops, write, json };
};

// ── effective-recipe resolution per op (degradation honesty) ────────────────────────

// A single op's before/after value + the effective recipe it resolves to here (vs live readiness).
// `to` is null for an unset (falls to the computed default). degradedFrom/reason carry the honesty.
const resolveOp = (op, current, after, detection) => {
  const from = current?.[op.activity]?.[op.slot] ?? null;
  const to = after?.[op.activity]?.[op.slot] ?? null;
  const r = resolveActivityRecipe({ config: after ?? {}, readiness: detection, activity: op.activity, slot: op.slot });
  return { activity: op.activity, slot: op.slot, from, to, effective: r.recipe, degradedFrom: r.degradedFrom, reason: r.reason };
};

// ── rendering (ENGLISH; the agent localizes) ────────────────────────────────────────

const valueLabel = (v) => (v == null ? '(computed default)' : v);

const effectiveLine = (e) =>
  e.degradedFrom
    ? `effective here: ${e.effective} (requested ${e.degradedFrom} → degraded: ${e.reason})`
    : `effective here: ${e.effective}`;

const formatHuman = ({ changed, unchanged, warnings, willWrite, wrote, fileBody, activeLine }) => {
  const lines = [];
  if (wrote) lines.push(`wrote ${CONFIG_REL}`);
  else if (changed.length) lines.push(`set-recipe — preview (nothing written; re-run with --write to apply)`);
  for (const e of changed) {
    lines.push(`  ${e.activity}.${e.slot}: ${valueLabel(e.from)} → ${valueLabel(e.to)}`);
    lines.push(`      ↳ ${effectiveLine(e)}`);
  }
  for (const e of unchanged) lines.push(`  ${e.activity}.${e.slot}: already ${valueLabel(e.from)} (no change)`);
  for (const w of warnings) lines.push(`  ⚠ ${w}`);
  if (wrote && fileBody) lines.push('', `${CONFIG_REL} now reads:`, fileBody.replace(/\n$/, ''));
  // The post-write discovery echo (AD-038): after every successful write, paste the freshly composed
  // active-recipe line verbatim + the one-line handover reminder — the writer is the ONE surface that
  // changes the config, so the change is never announced anywhere else.
  if (wrote && activeLine) {
    lines.push('', activeLine, `refresh the "Active recipes:" slot line in docs/ai/handover.md with the line above.`);
  }
  if (!wrote) {
    if (!changed.length) lines.push('  no changes — nothing to write.');
    else if (willWrite) lines.push('', `would write ${CONFIG_REL} — re-run with --write to apply.`);
  }
  return lines.join('\n');
};

const buildJson = ({ changed, unchanged, warnings, writtenPath, noop, activeLine }) => ({
  changed: changed.map((e) => ({ activity: e.activity, slot: e.slot, from: e.from, to: e.to, effective: e.effective, degradedFrom: e.degradedFrom ?? null, reason: e.reason ?? null })),
  unchanged: unchanged.map((e) => ({ activity: e.activity, slot: e.slot, recipe: e.from })),
  writtenPath: writtenPath ?? null,
  noop,
  warnings,
  // ADDITIVE: the machine-composed active-recipe line, present only after a successful write (the
  // human render pastes the same line) — the output stays one parseable JSON object either way.
  activeLine: activeLine ?? null,
});

const HELP = `set-recipe — write the per-project orchestration config (docs/ai/orchestration.json).

Usage:
  node set-recipe.mjs [--set <activity>.<slot>=<recipe>]... [--unset <activity>.<slot>]... [--write] [--json]

  --set    <activity>.<slot>=<recipe>   pin a recipe (fully-qualified; e.g. plan-authoring.review=council)
  --unset  <activity>.<slot>            return a slot to its computed default
  --write                               apply the change (default: preview only — writes nothing)
  --json                                machine-readable output
  --help, -h                            this help

Activities/slots: plan-authoring → review;  plan-execution → execute, review
Recipes:          review accepts solo|reviewed|council;  execute accepts solo|delegated

Previews by default; --write applies via an atomic, symlink/TOCTOU-safe write behind a deployment gate.
Config writer only: it NEVER runs a backend and NEVER commits. Hand-editing the file stays fully supported.

Exit codes: 0 success (an explicit recipe that gracefully degrades is still 0);
            2 usage (bad/duplicate op, or --write with no ops);
            1 config error (malformed/unreadable config) or a write STOP (no deployment / symlinked leaf).`;

// ── main ────────────────────────────────────────────────────────────────────────────

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const detect = ctx.detect ?? detectBackends;
  const readFile = ctx.readFileSync ?? readFileSync;
  const lstat = ctx.lstatSync ?? lstatSync;
  const writeConfig = ctx.writeConfig ?? writeConfigFs;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const { ops, write, json } = parseArgs(argv);

    // Load the current config first (loadConfig throws fail(1) loud on malformed/unreadable — a write
    // never clobbers an unparseable file; the message points the agent at the parse error to help fix it).
    const { config: current, source } = loadConfig(cwd, readFile, lstat);

    // No ops + no --write → show the current config + a hint (read-only; nothing changes).
    if (ops.length === 0) {
      if (json) {
        return { code: 0, stdout: JSON.stringify(buildJson({ changed: [], unchanged: [], warnings: [], writtenPath: null, noop: true }), null, 2), stderr: '' };
      }
      const shown = current == null ? `(no ${CONFIG_REL} yet — computed defaults apply)` : serializeConfig(current).replace(/\n$/, '');
      const hint = `\nPass --set <activity>.<slot>=<recipe> (preview) then --write to apply. Activities/slots: plan-authoring.review, plan-execution.execute, plan-execution.review.`;
      return { code: 0, stdout: `${source === 'none' ? '' : `${CONFIG_REL}:\n`}${shown}${hint}`, stderr: '' };
    }

    const after = applySetOps(current, ops, { seedReadme: CANON_README });

    // Detection is a SECONDARY input — it only refines the EFFECTIVE recipe note. A throw must NOT block
    // the write (the config write is readiness-independent): treat all backends as not-ready, warn, exit 0.
    const warnings = [];
    let detection = [];
    try {
      detection = detect();
    } catch (err) {
      warnings.push(`backend detection failed (${(err && err.message) || err}) — treating all backends as not ready; recipes needing a backend degrade to solo.`);
    }

    const resolved = ops.map((op) => resolveOp(op, current, after, detection));
    const changed = resolved.filter((e) => e.from !== e.to);
    const unchanged = resolved.filter((e) => e.from === e.to);
    const noop = changed.length === 0;

    if (!write) {
      const stdout = json
        ? JSON.stringify(buildJson({ changed, unchanged, warnings, writtenPath: null, noop }), null, 2)
        : formatHuman({ changed, unchanged, warnings, willWrite: !noop, wrote: false });
      return { code: 0, stdout, stderr: '' };
    }

    // --write. A no-op never writes (idempotent; never re-seeds the _README).
    if (noop) {
      const stdout = json
        ? JSON.stringify(buildJson({ changed, unchanged, warnings, writtenPath: null, noop: true }), null, 2)
        : formatHuman({ changed, unchanged, warnings, willWrite: false, wrote: false });
      return { code: 0, stdout, stderr: '' };
    }

    validateConfig(after); // defensive re-validate immediately before the write
    const { writtenPath } = writeConfig(cwd, after, ctx);
    const fileBody = serializeConfig(after);
    // The echoed handover line carries the SAME autonomy levels recipes --active-line renders —
    // sync facts (no render-check needed for the cells; Segment B). A malformed policy
    // surfaces loudly through the line's own MALFORMED segment.
    const autonomyFacts = (() => {
      try {
        const { config: autonomyConfig, source } = loadAutonomy(cwd, ctx.readFileSync ?? readFileSync, ctx.lstatSync ?? lstatSync);
        return { source, ...resolveAutonomy(autonomyConfig) };
      } catch (err) {
        return { error: (err && err.message) || String(err) };
      }
    })();
    const activeLine = composeActiveRecipeLine({ config: after, source: CONFIG_REL }, detection, autonomyFacts);
    const stdout = json
      ? JSON.stringify(buildJson({ changed, unchanged, warnings, writtenPath, noop: false, activeLine }), null, 2)
      : formatHuman({ changed, unchanged, warnings, wrote: true, fileBody, activeLine });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `set-recipe: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}

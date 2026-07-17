#!/usr/bin/env node
// set-autonomy.mjs — the WRITER for docs/ai/autonomy.json (the per-project autonomy policy). Mirrors
// set-recipe.mjs (AD-044): the AGENT turns plain language into explicit `--set <section>.<key>=<value>`
// / `--unset <section>.<key>` ops; the KIT does the deterministic validate → merge → preview → write.
// No NL parser (stays dependency-free + deterministic), no `all`-magic — the agent expands plain
// language into explicit per-key ops (asking if scope is unclear). Ops route through the SAME
// accept/reject grammar as validateAutonomy (autonomy-config.mjs), so the writer and the config
// validator can never disagree.
//
// Posture: PREVIEW BY DEFAULT (dry-run); `--write` applies. It NEVER commits, NEVER runs a backend, and
// NEVER renders enforcement — it writes ONLY docs/ai/autonomy.json (the render into .claude/settings.json
// is the separate velocity autonomy mode). It writes only via the hardened writeAutonomy (deployment
// gate; exclusive-create tmp + rename; symlink/TOCTOU-safe; last-writer-wins). A no-op set never writes
// and never spuriously seeds the _README. `--unset` returns a key to its computed default, so reverting
// needs no hand-edit either. Hand-edit stays first-class — this is an OFFERED convenience, never a lock.
//
// Output is ENGLISH/structured (repo-artifact Hard Constraint); the agent localizes when narrating.
// Exit codes: 0 success; 2 usage (bad/duplicate op, --write with zero ops); 1 config error
// (malformed/unreadable policy) or a write STOP (no deployment / symlinked leaf). main(argv, ctx) →
// { code, stdout, stderr }; cwd / fs are injectable for host-independent tests.
//
// Dependency-free, Node >= 22. No side effects on import (the isDirectRun idiom).

import { readFileSync, lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AUTONOMY_REL,
  fail,
  loadAutonomy,
  validateAutonomy,
  parseAutonomyOp,
  applyAutonomyOps,
  serializeAutonomy,
  resolveAutonomy,
  AUTONOMY_README,
} from './autonomy-config.mjs';
import { writeAutonomy as writeAutonomyFs } from './autonomy-write.mjs';

// ── argument parsing (usage errors → exit 2) ────────────────────────────────────────

// Parse argv → { ops, write, json }. `--set`/`--unset` take a fully-qualified token (parseAutonomyOp
// validates it). A duplicate op for the same section.key, a `--write` with zero ops, an unknown flag, or
// a bad token → exit 2. `--set=<tok>` / `--unset=<tok>` inline forms are accepted too.
const parseArgs = (argv) => {
  const ops = [];
  const seen = new Set();
  let write = false;
  let json = false;
  const takeOp = (kind, tok) => {
    if (tok === undefined || tok.startsWith('--')) throw fail(2, `--${kind} requires <section>.<key>${kind === 'set' ? '=<value>' : ''}`);
    const op = parseAutonomyOp(kind, tok);
    const key = `${op.section}.${op.key}`;
    if (seen.has(key)) throw fail(2, `duplicate op for "${key}" — name each section.key at most once`);
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

// ── per-op before/after + resolved effective value ──────────────────────────────────

// The resolved effective value for a section.key against a resolved policy (computed defaults filled).
const resolvedValueFor = (resolved, section, key) =>
  section === 'redlines' ? resolved.redlines[key] : resolved.activities[section]?.[key];

// A single op's before/after value + the effective value it resolves to (the computed default shows for
// an unset). `to` is null for an unset (falls to the computed default).
const resolveOp = (op, current, after) => {
  const from = current?.[op.section]?.[op.key] ?? null;
  const to = after?.[op.section]?.[op.key] ?? null;
  const effective = resolvedValueFor(resolveAutonomy(after), op.section, op.key);
  return { section: op.section, key: op.key, from, to, effective };
};

// ── rendering (ENGLISH; the agent localizes) ────────────────────────────────────────

const valueLabel = (v) => (v == null ? '(computed default)' : v);

const APPLY_HINT =
  'Next: render this policy into .claude/settings.json with the velocity autonomy mode (previews first) — the writer changes only the policy file, never the settings.';

const formatHuman = ({ changed, unchanged, wrote, fileBody }) => {
  const lines = [];
  if (wrote) lines.push(`wrote ${AUTONOMY_REL}`);
  else if (changed.length) lines.push('set-autonomy — preview (nothing written; re-run with --write to apply)');
  for (const e of changed) {
    lines.push(`  ${e.section}.${e.key}: ${valueLabel(e.from)} → ${valueLabel(e.to)}`);
    lines.push(`      ↳ effective: ${e.effective}`);
  }
  for (const e of unchanged) lines.push(`  ${e.section}.${e.key}: already ${valueLabel(e.from)} (no change)`);
  if (wrote && fileBody) lines.push('', `${AUTONOMY_REL} now reads:`, fileBody.replace(/\n$/, ''), '', APPLY_HINT);
  if (!wrote) {
    if (!changed.length) lines.push('  no changes — nothing to write.');
    else lines.push('', `would write ${AUTONOMY_REL} — re-run with --write to apply.`);
  }
  return lines.join('\n');
};

const buildJson = ({ changed, unchanged, writtenPath, noop }) => ({
  changed: changed.map((e) => ({ section: e.section, key: e.key, from: e.from, to: e.to, effective: e.effective })),
  unchanged: unchanged.map((e) => ({ section: e.section, key: e.key, value: e.from })),
  writtenPath: writtenPath ?? null,
  noop,
});

const HELP = `set-autonomy — write the per-project autonomy policy (docs/ai/autonomy.json).

Usage:
  node set-autonomy.mjs [--set <section>.<key>=<value>]... [--unset <section>.<key>]... [--write] [--json]

  --set    <section>.<key>=<value>   pin a policy value (fully-qualified; e.g. plan-execution.autonomy=sandbox)
  --unset  <section>.<key>           return a key to its computed default
  --write                            apply the change (default: preview only — writes nothing)
  --json                             machine-readable output
  --help, -h                         this help

Sections/keys: redlines → commit|push|publish|network|credentials|fs_outside_repo (each ask|deny);
               plan-authoring.autonomy, plan-execution.autonomy (each sandbox|prompt)

Previews by default; --write applies via an atomic, symlink/TOCTOU-safe write behind a deployment gate.
Policy writer only: it NEVER renders enforcement (that is the velocity autonomy mode), NEVER runs a
backend, and NEVER commits. Hand-editing the file stays fully supported.

Exit codes: 0 success; 2 usage (bad/duplicate op, or --write with no ops);
            1 config error (malformed/unreadable policy) or a write STOP (no deployment / symlinked leaf).`;

// ── main ────────────────────────────────────────────────────────────────────────────

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const readFile = ctx.readFileSync ?? readFileSync;
  const lstat = ctx.lstatSync ?? lstatSync;
  const writeAutonomy = ctx.writeAutonomy ?? writeAutonomyFs;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const { ops, write, json } = parseArgs(argv);

    // Load the current policy first (loadAutonomy throws fail(1) loud on malformed/unreadable — a write
    // never clobbers an unparseable file; the message points the agent at the parse error to help fix it).
    const { config: current, source } = loadAutonomy(cwd, readFile, lstat);

    // No ops + no --write → show the current policy + a hint (read-only; nothing changes).
    if (ops.length === 0) {
      if (json) {
        return { code: 0, stdout: JSON.stringify(buildJson({ changed: [], unchanged: [], writtenPath: null, noop: true }), null, 2), stderr: '' };
      }
      const shown = current == null ? `(no ${AUTONOMY_REL} yet — computed defaults apply)` : serializeAutonomy(current).replace(/\n$/, '');
      const hint = `\nPass --set <section>.<key>=<value> (preview) then --write to apply. Sections: redlines, plan-authoring.autonomy, plan-execution.autonomy.`;
      return { code: 0, stdout: `${source === 'none' ? '' : `${AUTONOMY_REL}:\n`}${shown}${hint}`, stderr: '' };
    }

    const after = applyAutonomyOps(current, ops, { seedReadme: AUTONOMY_README });
    const resolved = ops.map((op) => resolveOp(op, current, after));
    const changed = resolved.filter((e) => e.from !== e.to);
    const unchanged = resolved.filter((e) => e.from === e.to);
    const noop = changed.length === 0;

    if (!write || noop) {
      const stdout = json
        ? JSON.stringify(buildJson({ changed, unchanged, writtenPath: null, noop }), null, 2)
        : formatHuman({ changed, unchanged, wrote: false });
      return { code: 0, stdout, stderr: '' };
    }

    validateAutonomy(after); // defensive re-validate immediately before the write
    const { writtenPath } = writeAutonomy(cwd, after, ctx);
    const fileBody = serializeAutonomy(after);
    const stdout = json
      ? JSON.stringify(buildJson({ changed, unchanged, writtenPath, noop: false }), null, 2)
      : formatHuman({ changed, unchanged, wrote: true, fileBody });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `set-autonomy: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  process.exit(r.code);
}

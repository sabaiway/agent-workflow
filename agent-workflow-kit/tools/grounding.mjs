#!/usr/bin/env node
// grounding.mjs — the grounded-review facts assembler behind `/agent-workflow-kit grounding`
// (AD-038). An ungrounded agy review GUESSES (AD-028); the grounding CONTRACT is mechanized
// (`agy-review --facts @f`, AD-033) but population was a manual chore — this tool emits the two
// mechanical halves of a facts payload so assembly is a command, not hand-copying:
//
//   --constraints        slice the root AGENTS.md `## 🚫 Hard Constraints` section, verbatim
//                        (exactly-one-match — 0 or >1 headings is a loud STOP, never a guess);
//   --plan <path>        extract the plan's decision-bearing canonical sections, verbatim + whole:
//                        `## Approach` (REQUIRED — its "What we are NOT doing" text rides inside;
//                        it is not a heading in canon) and `## Verification` (REQUIRED — STOP if
//                        missing), plus `## Decisions (locked)` (optional-if-absent, the engine §7
//                        heading this release adds); a DUPLICATE heading is always a STOP.
//
// Byte budget: the output honors the same AGY_MAX_PROMPT_BYTES contract the agy wrapper enforces
// (default 120000; the override may only TIGHTEN — above the OS single-argv ceiling ~131000 is
// rejected, mirroring agy-review.sh), MINUS --reserve-bytes <n> — the artifact share the caller
// expects `agy-review` to add around these facts. Overflow is TRIMMED tail-first with a loud
// in-band marker + stderr report (never a silent cut).
//
// Catalog honesty: this is a WRITER — `--out <path>` writes a file. Invariant: `--out` accepts
// only gitignored / out-of-repo scratch destinations and REFUSES a tracked path AND an in-repo
// not-ignored path (a new untracked file would itself move the review fingerprint the facts are
// about to ground). stdout is the default. It never commits and never runs a subscription CLI.
//
// Dependency-free, Node >= 18. No side effects on import (the isDirectRun idiom).

import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fail } from './orchestration-config.mjs';
// (e) --ledger-summary (BUGFREE-3 / AD-049): a computed, loop/base-SCOPED review-ledger digest for
// the facts payload. The review ledger is read-only here — grounding never writes it. ORIGINS +
// computeTelemetry give the counts; the segment filter gives the scope.
import { ORIGINS, computeTelemetry, filterSegmentRecords, readLedger, resolveLedgerPath, resolveBase } from './review-ledger.mjs';
import { plansInFlight } from './review-state.mjs';

const PLAN_EXECUTION = 'plan-execution';

// The agy single-argv byte contract (mirrors agy-review.sh — the wrapper is the enforcement home).
export const DEFAULT_MAX_PROMPT_BYTES = 120000;
export const ARGV_HARD_MAX = 131000;

export const CONSTRAINTS_HEADING = /^## .*Hard Constraints$/;
export const PLAN_SECTIONS = [
  { heading: '## Approach', optional: false },
  { heading: '## Verification', optional: false },
  { heading: '## Decisions (locked)', optional: true },
];

// ── pure section slicing (exactly-one-match; the inject-methodology discipline) ────────

// Slice ONE `## `-level section (its heading line through the line before the next `## ` heading),
// verbatim. `heading` is a string (trimmed-line equality) or a RegExp over the trimmed line.
// 0 matches → null when optional, else STOP; >1 matches → always STOP (never guess which).
export const sliceSection = (text, heading, { optional = false, label = 'document' } = {}) => {
  const lines = text.split('\n');
  const matchesAt = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (typeof heading === 'string' ? trimmed === heading : heading.test(trimmed)) matchesAt.push(i);
  }
  const shown = typeof heading === 'string' ? heading : String(heading);
  if (matchesAt.length === 0) {
    if (optional) return null;
    throw fail(1, `${label}: required section "${shown}" not found — STOP (nothing sliced)`);
  }
  if (matchesAt.length > 1) {
    throw fail(1, `${label}: section "${shown}" appears ${matchesAt.length} times — must be exactly one; STOP (never guess which)`);
  }
  const start = matchesAt[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').replace(/\n+$/, '\n');
};

// ── assembly ───────────────────────────────────────────────────────────────────────

export const assembleGrounding = ({ constraintsText = null, planText = null, planLabel = 'plan' } = {}) => {
  const parts = [];
  if (constraintsText != null) {
    parts.push(sliceSection(constraintsText, CONSTRAINTS_HEADING, { label: 'AGENTS.md' }));
  }
  if (planText != null) {
    for (const { heading, optional } of PLAN_SECTIONS) {
      const section = sliceSection(planText, heading, { optional, label: planLabel });
      if (section != null) parts.push(section);
    }
  }
  return parts.join('\n');
};

// Trim `payload` to `budget` bytes, tail-first, with a loud in-band marker. The budget is a HARD
// ceiling: when it is smaller than the marker itself, the marker is truncated too (the output may
// never exceed `budget` — a facts file over the reserved share would push the final wrapper prompt
// past the argv ceiling; codex R1 finding). Returns { text, trimmedBytes }. Never a silent cut.
export const trimToBudget = (payload, budget) => {
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes <= budget) return { text: payload, trimmedBytes: 0 };
  const marker = `\n[grounding] TRIMMED: the assembled facts exceeded the byte budget — tail dropped; tighten the sources or raise --reserve-bytes accounting.\n`;
  const keep = Math.max(0, budget - Buffer.byteLength(marker, 'utf8'));
  const joined = Buffer.from(payload, 'utf8').subarray(0, keep).toString('utf8').replace(/�+$/, '') + marker;
  // Hard-cap the final text (covers budget < marker size): byte-slice, then drop any split rune.
  const text = Buffer.from(joined, 'utf8').subarray(0, budget).toString('utf8').replace(/�+$/, '');
  return { text, trimmedBytes: bytes - keep };
};

// ── (e) --ledger-summary: a loop/base-SCOPED review-ledger digest (read-only, computed) ─────────
// `computeTelemetry` aggregates ALL loops and is not per-round-facts-shaped, so this renders the
// in-flight SEGMENT only (plan-execution, loop, base) — the telemetry COUNTS filtered to that
// segment, plus a terse per-round/triage/override render. Deliberately compact + distinct from the
// review-ledger `--status` human view (that one is indented + segment-grouped): this is a byte-
// budgeted FACTS block that agy/codex review against, so unrelated loops are excluded by construction.

const baseTag = (base) => (base === null ? '(unborn branch)' : String(base).slice(0, 12));
const countsOf = (obj) => {
  const keys = Object.keys(obj).sort();
  return keys.length === 0 ? '(none)' : keys.map((k) => `${k}:${obj[k]}`).join(' ');
};
const summaryRoundLine = (r) =>
  `round ${r.round} — ${r.backends.map((b) => `${b.backend} ${b.degraded ? `degraded(${b.reason})` : `${b.blockers}/${b.majors}/${b.minors} ${b.verdict}`}`).join(', ')}` +
  (r.findings.length ? ` [${r.findings.map((f) => `${f.findingKey}(${f.severity})`).join(', ')}]` : '');
const summaryTriageLine = (t) => `triage @round ${t.round} — ${t.classifications.map((c) => `${c.findingKey}=${c.class}`).join(', ')}`;
const summaryOverrideLine = (o) =>
  `override @round ${o.round} [${o.scope}] — ${o.scope === 'oracle-change' ? o.files.join(', ') : o.scope === 'size-cap' ? `sanctioned ${o.sanctionedLines} lines` : o.testId}: ${o.reason}`;
const summaryGateRunLine = (g) => `gate-run — status=${g.summary.status} ${g.summary.passed}/${g.summary.gates} green`;
const summaryRecordLine = (r) =>
  r.kind === 'round' ? summaryRoundLine(r) : r.kind === 'triage' ? summaryTriageLine(r) : r.kind === 'override' ? summaryOverrideLine(r) : summaryGateRunLine(r);

// renderLedgerSummary(records, { loop, base }) → the scoped facts section, or '' when the segment
// holds no records (empty/absent → nothing to ground). Pure: the caller does the I/O.
export const renderLedgerSummary = (records, { loop, base }) => {
  const segment = filterSegmentRecords(records, { activity: PLAN_EXECUTION, loop, base });
  if (segment.length === 0) return '';
  const t = computeTelemetry(segment, []).loops[0];
  const lines = [
    `## Review-ledger summary — loop ${loop} @ base ${baseTag(base)}`,
    '',
    `rounds ${t.rounds} · divergence-rounds ${t.divergenceRounds}`,
    `finding origins — ${ORIGINS.map((k) => `${k}:${t.origins[k]}`).join(' ')}`,
    `classifications — ${countsOf(t.classifications)}`,
    `backend verdicts — ${Object.keys(t.backendVerdicts).sort().map((b) => `${b}{${countsOf(t.backendVerdicts[b])}}`).join(' · ') || '(none)'}`,
    `overrides — ${countsOf(t.overrides)}`,
    '',
    ...segment.map(summaryRecordLine),
  ];
  return `${lines.join('\n')}\n`;
};

// resolveLedgerSummary({ cwd, env }) → the scoped section text for the SINGLE in-flight plan-execution
// segment. A loud STOP unless exactly one plan is in flight (the family's single-plan discipline —
// never guess which loop to ground). Reads the ledger read-only.
const gitTop = (cwd) => {
  const r = gitLine(['rev-parse', '--show-toplevel'], cwd);
  return r && r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : cwd;
};
export const resolveLedgerSummary = ({ cwd, env }) => {
  const root = gitTop(cwd);
  const plans = plansInFlight(root);
  if (plans.length !== 1) {
    throw fail(1, `--ledger-summary needs exactly one in-flight plan (in flight: ${plans.length ? plans.join(', ') : 'none'}) — resolve to one active plan`);
  }
  const loop = plans[0].replace(/\.md$/, '');
  const base = resolveBase(cwd);
  const ledgerPath = resolveLedgerPath(cwd, env);
  const { records, readError, malformed, malformedReasons } = ledgerPath ? readLedger(ledgerPath) : { records: [], malformed: 0 };
  // Fail CLOSED like every sibling ledger reader (No-silent-failures): an unreadable OR malformed
  // ledger must never silently render an empty/partial digest the reviewer then grounds against — an
  // empty section would be indistinguishable from a legitimately-empty segment.
  if (readError) throw fail(1, `--ledger-summary cannot read the ledger (${readError}) — failing closed; inspect ${ledgerPath}`);
  if (malformed > 0) throw fail(1, `--ledger-summary: the ledger has ${malformed} malformed line(s) — failing closed (a dropped line could hide a round/finding): ${malformedReasons.join('; ')}`);
  return renderLedgerSummary(records, { loop, base });
};

// ── the --out destination guard (gitignored / out-of-repo scratch ONLY) ────────────────

const gitLine = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.error || r.status == null ? null : { status: r.status, stdout: r.stdout ?? '' };
};

// STOP unless `outPath` is a safe scratch destination: outside any git work tree, or gitignored
// inside one. A TRACKED path and an in-repo NOT-ignored path are both refused (a facts file must
// never enter the tree it grounds — it would move the fingerprint and could be committed). The
// check runs on the REAL destination, never the lexical path (codex R1 finding): a symlink leaf is
// refused outright, and the parent directory is realpath-resolved first, so a gitignored or
// out-of-repo symlink can never route the write onto a tracked/in-repo file. Returns the resolved
// real path the caller must write to.
export const assertScratchDestination = (outPath, cwd) => {
  const lexical = isAbsolute(outPath) ? outPath : resolve(cwd, outPath);
  let leaf = null;
  try {
    leaf = lstatSync(lexical);
  } catch {
    leaf = null; // absent → a fresh file; the parent still gets realpath-checked below
  }
  if (leaf?.isSymbolicLink()) {
    throw fail(1, `--out refuses a symlink destination (${outPath}) — the write would follow it onto another file; name the real scratch path`);
  }
  let realParent;
  try {
    realParent = realpathSync(dirname(lexical));
  } catch {
    throw fail(1, `--out parent directory does not exist (${dirname(lexical)}) — create the scratch dir first`);
  }
  const full = join(realParent, basename(lexical));
  const top = gitLine(['rev-parse', '--show-toplevel'], cwd);
  if (top == null || top.status !== 0) return full; // no git tree → plain scratch, fine
  const root = top.stdout.replace(/\r?\n$/, '');
  const rel = relative(root, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return full; // really outside the work tree → scratch
  const tracked = gitLine(['ls-files', '--error-unmatch', '--', rel], root);
  if (tracked != null && tracked.status === 0) {
    throw fail(1, `--out refuses a TRACKED path (${rel}) — grounding output is scratch; write it to a gitignored path or outside the repo`);
  }
  const ignored = gitLine(['check-ignore', '-q', '--', rel], root);
  if (ignored == null || ignored.status !== 0) {
    throw fail(1, `--out refuses an in-repo path that is not gitignored (${rel}) — a new untracked file would move the review fingerprint; use a gitignored path or a location outside the repo`);
  }
  return full;
};

// ── CLI ────────────────────────────────────────────────────────────────────────────

const HELP = `grounding — grounded-review facts assembler for the agent-workflow family (AD-038).

Usage:
  node grounding.mjs [--constraints] [--plan <path>] [--ledger-summary] [--reserve-bytes <n>] [--out <path>]

  --constraints        slice the root AGENTS.md "Hard Constraints" section verbatim
                       (exactly one matching heading, else a loud STOP)
  --plan <path>        extract the plan's decision-bearing sections verbatim + whole:
                       "## Approach" + "## Verification" (REQUIRED — STOP if missing),
                       "## Decisions (locked)" when present; a duplicate heading is a STOP
  --ledger-summary     append a COMPUTED review-ledger digest for the SINGLE in-flight
                       plan-execution segment (rounds · origins · classifications · verdicts ·
                       overrides + a per-round render) — "computed, not remembered" facts; a
                       loud STOP unless exactly one plan is in flight
  --reserve-bytes <n>  the artifact share agy-review will add around these facts — the output
                       budget becomes AGY_MAX_PROMPT_BYTES − n (loud tail-trim on overflow)
  --out <path>         write instead of stdout — gitignored / out-of-repo scratch ONLY
                       (a tracked or in-repo not-ignored path is refused)

Feed the output to the review wrapper: agy-review code --facts @<out>. AGY_MAX_PROMPT_BYTES
honors the wrapper's contract (default ${DEFAULT_MAX_PROMPT_BYTES}; may only tighten — above the
OS argv ceiling it is rejected). Writer honesty: --out writes ONE scratch file; nothing else is
ever written; never commits, never runs a subscription CLI.

Exit codes: 0 success; 2 usage; 1 STOP (missing/duplicate section, unreadable file, refused --out).`;

const parseArgs = (argv) => {
  let constraints = false;
  let plan = null;
  let out = null;
  let reserve = 0;
  let ledgerSummary = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--constraints') constraints = true;
    else if (a === '--ledger-summary') ledgerSummary = true;
    else if (a === '--plan') {
      plan = argv[i + 1];
      if (!plan || plan.startsWith('--')) throw fail(2, '--plan requires a <path>');
      i += 1;
    } else if (a === '--out') {
      out = argv[i + 1];
      if (!out || out.startsWith('--')) throw fail(2, '--out requires a <path>');
      i += 1;
    } else if (a === '--reserve-bytes') {
      const raw = argv[i + 1];
      if (!raw || !/^\d+$/.test(raw)) throw fail(2, '--reserve-bytes requires a non-negative integer');
      reserve = Number(raw);
      i += 1;
    } else throw fail(2, `unknown argument: ${a}`);
  }
  if (!constraints && plan == null && !ledgerSummary) throw fail(2, 'nothing to assemble — pass --constraints, --plan <path>, and/or --ledger-summary');
  return { constraints, plan, out, reserve, ledgerSummary };
};

const resolveBudget = (env, reserve) => {
  const raw = env.AGY_MAX_PROMPT_BYTES ?? String(DEFAULT_MAX_PROMPT_BYTES);
  if (!/^\d+$/.test(raw)) throw fail(2, `AGY_MAX_PROMPT_BYTES='${raw}' is not a non-negative integer`);
  const max = Number(raw);
  if (max > ARGV_HARD_MAX) {
    throw fail(2, `AGY_MAX_PROMPT_BYTES=${max} exceeds the OS single-argv ceiling (~${ARGV_HARD_MAX}) — the override may only tighten (mirrors agy-review)`);
  }
  const budget = max - reserve;
  if (budget <= 0) throw fail(2, `--reserve-bytes ${reserve} leaves no budget under AGY_MAX_PROMPT_BYTES=${max}`);
  return budget;
};

export const main = (argv, ctx = {}) => {
  const cwd = ctx.cwd ?? process.cwd();
  const env = ctx.env ?? process.env;
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    const { constraints, plan, out, reserve, ledgerSummary } = parseArgs(argv);
    const budget = resolveBudget(env, reserve);

    const readOrStop = (path, label) => {
      try {
        return readFileSync(resolve(cwd, path), 'utf8');
      } catch (err) {
        throw fail(1, `${label} '${path}' is unreadable (${(err && err.code) || err}) — STOP`);
      }
    };
    const constraintsText = constraints ? readOrStop('AGENTS.md', 'root AGENTS.md') : null;
    const planText = plan != null ? readOrStop(plan, 'plan file') : null;

    const parts = [];
    const assembled = assembleGrounding({ constraintsText, planText, planLabel: plan ?? 'plan' });
    if (assembled) parts.push(assembled);
    if (ledgerSummary) {
      const summary = resolveLedgerSummary({ cwd, env });
      if (summary) parts.push(summary);
    }
    const payload = parts.join('\n');
    const { text, trimmedBytes } = trimToBudget(payload, budget);
    const stderr = trimmedBytes > 0
      ? `[grounding] TRIM: assembled ${Buffer.byteLength(payload, 'utf8')} bytes > budget ${budget} (AGY_MAX_PROMPT_BYTES minus --reserve-bytes ${reserve}) — dropped ${trimmedBytes} tail bytes; the cut is marked in-band.`
      : '';

    if (out != null) {
      const realOut = assertScratchDestination(out, cwd);
      writeFileSync(realOut, text);
      return { code: 0, stdout: `[grounding] wrote ${Buffer.byteLength(text, 'utf8')} bytes to ${out} — pass it as: agy-review code --facts @${out}`, stderr };
    }
    return { code: 0, stdout: text, stderr };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `grounding: ${err.message}` };
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const r = main(process.argv.slice(2));
  // Exact writes + a natural exit (codex R2): console.log would append a stray newline to the
  // byte-exact facts payload, and process.exit() can truncate large piped stdout before Node
  // flushes. The payload already ends with '\n' (sliceSection normalizes); only a non-payload
  // message (help / the --out report) gains the terminating newline it lacks.
  if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
  process.exitCode = r.code;
}

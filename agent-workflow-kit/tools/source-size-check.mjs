#!/usr/bin/env node
// source-size-check.mjs — the source-size practice's CLI and its writer half. The pure read core
// (config, scope, counting, the canonical gate-cmd matcher) lives in source-size-core.mjs and is
// imported here; nothing in the read graph imports THIS module, so the advisor surfaces can ask
// about the practice without ever reaching a writer (D-18).
//
// What --check judges: every in-scope file (the core's declared-scope rule) against the config's
// `defaults`. A file carrying a recorded baseline entry is RECORDED DEBT and is judged by the
// ratchet instead of by the defaults. Every refusal names the file, the actual value and the allowed
// value, and carries a SELF-SERVABLE next step — never a bare "too big".
//
// Every remedy this build prints is one a HUMAN can perform against THIS build. The writer verbs
// (--write-baseline, --adopt) arrive with the ratchet they serve, so nothing here renders them: a
// refusal that names an unimplemented command is not self-servable, it only looks it. Until then the
// servable lane is the one D-5 already blesses — hand-author the entry in the config, which the
// validator accepts, and the refusal prints the exact entry with THIS file's measured numbers.
//
// Exit codes: 0 green / 1 violation or refusal / 2 usage, config or enumeration error.
// Dependency-free, Node >= 22. No side effects on import.

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadSourceSizeConfig,
  resolveScope,
  measureFile,
  configPathFor,
  SOURCE_SIZE_CONFIG_REL,
  SOURCE_SIZE_SCHEMA,
  SOURCE_SIZE_DEFAULTS,
} from './source-size-core.mjs';

const usageFail = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { exitCode: 2 });

// The measured dimension names are the BASELINE-entry keys; `defaults` spells the line cap
// differently, so the two vocabularies are bridged in exactly one place.
const DEFAULT_KEY = Object.freeze({ lines: 'maxLines', maxLineBytes: 'maxLineBytes' });

// The authoring template (D-5): GENERIC, and INERT by construction — its roots/extensions carry
// placeholders the validator refuses, so it can never be pasted into an empty-green scope.
export const authoringTemplate = () => JSON.stringify({
  _README: 'Source-size practice: declared scope + thresholds + the recorded ratchet. Authored keys: schema, defaults, roots, exclude, extensions. Machine keys: baseline, aggregate — each recorded entry carries a reason, and a recorded size is debt, not permission. Strict JSON — unknown keys refused.',
  schema: SOURCE_SIZE_SCHEMA,
  defaults: { ...SOURCE_SIZE_DEFAULTS },
  roots: ['<a directory this practice covers>'],
  exclude: [],
  extensions: ['<.an-extension-this-practice-covers>'],
}, null, 2);

const absentRefusal = (cwd) => [
  `source-size: REFUSED — ${SOURCE_SIZE_CONFIG_REL} is absent, so the scope of this practice is undeclared.`,
  'Scope is DECLARED, never guessed: the kit ships no default root list and no default file-type list, because a fixed one would silently exempt every unlisted language. Authoring this file is the ONE manual step of the practice.',
  `Create ${configPathFor(cwd)} with this content, replacing every placeholder value:`,
  authoringTemplate(),
];

const authoredRefusal = (cwd) => [
  `source-size: REFUSED — ${configPathFor(cwd)} is AUTHORED but not yet MINTED (it carries no recorded baseline), so there is nothing for the ratchet to hold.`,
  'Add the machine keys by hand; the smallest valid form records no debt at all:',
  '  "baseline": {}',
];

// The suggested entry carries ONLY the dimensions that actually violate: an entry pinning a
// dimension that was never over the cap would make the ratchet refuse later changes nobody chose.
const suggestedEntry = (rel, over) => {
  const parts = Object.entries(over).map(([dimension, actual]) => `"${dimension}": ${actual}`);
  parts.push('"reason": "<why this size is accepted>"');
  return `  ${JSON.stringify(rel)}: { ${parts.join(', ')} }`;
};

export const runCheck = ({ cwd, deps = {} }) => {
  const { state, config } = loadSourceSizeConfig(cwd, deps);
  if (state === 'absent') return { code: 1, lines: absentRefusal(cwd) };
  if (state === 'authored') return { code: 1, lines: authoredRefusal(cwd) };
  const scope = resolveScope(cwd, config, deps);
  const baseline = config.baseline ?? {};
  const violations = new Map();
  for (const rel of scope.files) {
    // EVERY in-scope file is measured, recorded or not: D-6's fail-closed rule has no baseline
    // exception, so an unreadable or non-UTF-8 file must refuse even when its size is recorded debt.
    const measured = measureFile(cwd, rel, deps);
    // A record is debt for the dimension it NAMES and for nothing else — a lines-only entry must not
    // hide a line that grew past the byte cap, or the record becomes a blanket exemption nobody wrote.
    const recorded = baseline[rel] ?? {};
    const over = {};
    for (const dimension of ['lines', 'maxLineBytes']) {
      if (Object.hasOwn(recorded, dimension)) continue;
      if (measured[dimension] > config.defaults[DEFAULT_KEY[dimension]]) over[dimension] = measured[dimension];
    }
    if (Object.keys(over).length > 0) violations.set(rel, over);
  }
  const lines = [];
  for (const rel of scope.emptyRoots) {
    lines.push(`source-size: NOTE — the declared root "${rel}" matches no tracked file with a declared extension`);
  }
  if (violations.size === 0) {
    lines.push(`source-size: PASS — ${scope.files.length} in-scope file(s) within the declared caps`);
    return { code: 0, lines };
  }
  lines.push(`source-size: FAIL — ${violations.size} file(s) over the declared caps with no recorded baseline entry:`);
  for (const [rel, over] of violations) {
    for (const [dimension, actual] of Object.entries(over)) {
      lines.push(`  ${rel}: ${dimension} ${actual} exceeds the declared default ${config.defaults[DEFAULT_KEY[dimension]]}`);
    }
  }
  lines.push(`Either split the file(s), or RECORD each size as reasoned debt by adding its entry under "baseline" in ${configPathFor(cwd)} — the reason is required, and it is copied verbatim into the commit message and the CHANGELOG:`);
  for (const [rel, over] of violations) lines.push(suggestedEntry(rel, over));
  return { code: 1, lines };
};

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const HELP = `source-size-check — the declared source-size practice (agent-workflow family).

Usage:
  node source-size-check.mjs --check [--cwd <project-root>]

Judges every in-scope file against ${SOURCE_SIZE_CONFIG_REL}: git-tracked files under a declared
root carrying a declared extension, minus the excluded path-segment prefixes. Scope is DECLARED,
never guessed — with the config absent the check REFUSES and prints the exact file to author.
Symlinks and submodule gitlinks are skipped by kind; an unmerged index, a non-UTF-8 in-scope path,
an unverifiable in-scope file and an empty declared scope are refusals, never silent greens.

Counting: lines, and the longest line in BYTES. A terminator never counts (the CR of a CRLF
included); a last line with no final newline still counts; an empty file is 0 lines.

Every refusal names the file, the actual value, the allowed value and a self-servable next step.
A file carrying a recorded baseline entry is recorded debt and is not judged against the defaults.

Read-only: writes nothing; spawns one read-only git query.
Exit codes: 0 green; 1 violation or refusal; 2 usage, config or enumeration error.`;

export const main = (argv, ctx = {}) => {
  try {
    if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: HELP, stderr: '' };
    let cwd = ctx.cwd ?? process.cwd();
    const rest = [...argv];
    const cwdAt = rest.indexOf('--cwd');
    if (cwdAt !== -1) {
      if (rest[cwdAt + 1] === undefined) throw usageFail('--cwd needs a directory');
      // Resolved BEFORE the check and before anything is rendered: every path this run names is
      // then meaningful from any directory, not only from the one that invoked it.
      cwd = resolve(cwd, rest[cwdAt + 1]);
      rest.splice(cwdAt, 2);
    }
    const checkAt = rest.indexOf('--check');
    if (checkAt === -1) throw usageFail('nothing to do — pass --check (see --help)');
    rest.splice(checkAt, 1);
    if (rest.length > 0) throw usageFail(`unknown argument: ${rest[0]}`);
    const { code, lines } = runCheck({ cwd, deps: ctx.deps ?? {} });
    return { code, stdout: lines.join('\n'), stderr: '' };
  } catch (err) {
    return { code: err.exitCode ?? 1, stdout: '', stderr: `source-size-check: ${err.message}` };
  }
};

// Compared by REAL path, not lexically: ESM resolves a symlinked entry point to its target, so a
// lexical comparison is false whenever the tool is invoked through a link — and a gate whose cmd
// names a link would then exit 0 having run nothing, which reads as PASS.
// Exported as a test seam (the coverage-check keyFor idiom): the unresolvable arm cannot be reached
// through the CLI, where an existing entry point is a precondition of getting this far.
export const sameFile = (a, b) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};
const isDirectRun = Boolean(process.argv[1]) && sameFile(fileURLToPath(import.meta.url), process.argv[1]);
if (isDirectRun) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  process.exitCode = result.code;
}

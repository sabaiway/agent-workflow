#!/usr/bin/env node
// checker-gates.mjs — the declare verb of the kit-owned checker gates: previews the candidates the
// read leaf judges and, on --apply, writes the offered ones add-only into docs/ai/gates.json.
// Governing contract: docs/ai/specs/kit/tier/checker-gates/ (part checker-gates-verb).
// main(argv, deps) returns, never exits, never asks.
import { resolve } from 'node:path';
import { assertDocsAiDeployment, writeDocsAiFileAtomic } from './atomic-write.mjs';
import { safeLine } from './carriers.mjs';
import { CANDIDATE_STATES, judgeCheckerGates } from './checker-gates-read.mjs';
import { isDirectRun } from './direct-run.mjs';
import { GATES_REL, coverageDeclarationDefects, validateDeclaration } from './gates-declaration.mjs';
import { TRUST_CHAIN_DISCLOSURE, placeEntries } from './gates-init.mjs';

const LF = String.fromCharCode(10);
const ARGV_OFFSET = 2;
const EXIT_SUCCESS = 0;
const EXIT_REFUSAL = 1;
const EXIT_USAGE = 2;
const CWD_FLAG = '--cwd';
const APPLY_FLAG = '--apply';
const ONLY_FLAG = '--only';
const HELP_FLAGS = new Set(['--help', '-h']);
const APPLIED = 'applied';
const INDENT = '  ';
const JSON_INDENT = 2;
const NOUN = 'a gate declaration';

export const OUTCOME_LINES = Object.freeze({
  candidate: (id, word, detail) => `${id}: ${word}${detail ? ` — ${safeLine(detail)}` : ''}`,
  entry: (json) => `${INDENT}entry: ${json}`,
  disclosure: () => TRUST_CHAIN_DISCLOSURE,
  refusal: (name, detail) => `checker-gates: refused — ${name}${detail ? `: ${safeLine(detail)}` : ''}`,
  usage: (problem) => `usage: checker-gates.mjs --cwd DIR [--apply] [--only ID]... — ${safeLine(problem)}`,
  onlyNotOffered: (ids, offered) => `${ONLY_FLAG} names ids not offered: ${ids.join(', ')} (offered: ${offered.join(', ') || 'none'})`,
  help: () => [
    'checker-gates.mjs --cwd DIR [--apply] [--only ID]...',
    'Previews the kit-owned checker gates the project in DIR can declare; writes nothing by default.',
    '--apply writes the offered entries into docs/ai/gates.json, add-only; --only ID narrows the write.',
    'Exit codes: 0 done, 1 one named refusal, 2 usage.',
  ].join(LF),
});

const result = (code, stdout = '', stderr = '') => ({ code, stdout, stderr });
const refuse = (name, detail) => result(EXIT_REFUSAL, '', OUTCOME_LINES.refusal(name, detail));
const causeOf = (error) => String(error?.message ?? error);

const parseArgs = (argv) => {
  if (argv.length === 1 && HELP_FLAGS.has(argv[0])) return { help: true };
  const options = { only: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === CWD_FLAG) {
      if (options.cwd !== undefined) return { problem: `${CWD_FLAG} given twice` };
      if (value === undefined || value.startsWith('-')) return { problem: `${CWD_FLAG} needs a directory` };
      options.cwd = value;
      index += 1;
    } else if (flag === APPLY_FLAG) {
      if (options.apply) return { problem: `${APPLY_FLAG} given twice` };
      options.apply = true;
    } else if (flag === ONLY_FLAG) {
      if (value === undefined || value.startsWith('-')) return { problem: `${ONLY_FLAG} needs a gate id` };
      if (!options.only.includes(value)) options.only.push(value);
      index += 1;
    } else {
      return { problem: `unknown argument ${flag}` };
    }
  }
  if (options.cwd === undefined) return { problem: `${CWD_FLAG} is required` };
  return { cwd: options.cwd, apply: Boolean(options.apply), only: options.only };
};

export const mergeCheckerGates = (loaded, selected, root) => {
  const readme = Object.hasOwn(loaded, 'readme') ? { _README: loaded.readme } : {};
  const merged = { ...readme, gates: placeEntries(loaded.gates, selected, root) };
  validateDeclaration(merged);
  const defects = coverageDeclarationDefects(merged.gates, root);
  if (defects.length > 0) return { refusal: 'coverage-defect', detail: defects[0].message };
  return { merged, body: `${JSON.stringify(merged, null, JSON_INDENT)}${LF}` };
};

const renderLines = (candidates) => {
  const disclose = candidates.some(({ state }) => state === CANDIDATE_STATES.offered || state === APPLIED);
  const lines = candidates.flatMap(({ id, state, entry, detail }) => (state === CANDIDATE_STATES.offered
    ? [OUTCOME_LINES.candidate(id, state, detail), OUTCOME_LINES.entry(entry)]
    : [OUTCOME_LINES.candidate(id, state, detail)]));
  return disclose ? [OUTCOME_LINES.disclosure(), ...lines] : lines;
};

const writeSelected = (root, judged, selected, deps) => {
  const merge = mergeCheckerGates(judged.declaration, selected.map(({ entry }) => JSON.parse(entry)), root);
  if (merge.refusal) return { refusal: refuse(merge.refusal, merge.detail) };
  try {
    writeDocsAiFileAtomic(root, GATES_REL, merge.body, deps, { noun: NOUN, rel: GATES_REL });
  } catch (error) {
    return { refusal: refuse('write-failed', causeOf(error)) };
  }
  const written = new Set(selected.map(({ id }) => id));
  return { candidates: judged.candidates.map((item) => (written.has(item.id) ? { ...item, state: APPLIED, entry: null } : item)) };
};

const runVerb = (options, deps) => {
  const root = resolve(options.cwd);
  try {
    assertDocsAiDeployment(root, deps, { noun: NOUN, rel: GATES_REL });
  } catch (error) {
    return refuse('no-deployment', causeOf(error));
  }
  const judged = judgeCheckerGates(root, deps);
  if (judged.refusal) return refuse(judged.refusal, judged.detail);
  const offered = judged.candidates.filter(({ state }) => state === CANDIDATE_STATES.offered);
  const offeredIds = offered.map(({ id }) => id);
  const unknown = options.only.filter((id) => !offeredIds.includes(id));
  if (unknown.length > 0) return result(EXIT_USAGE, '', OUTCOME_LINES.usage(OUTCOME_LINES.onlyNotOffered(unknown, offeredIds)));
  const selected = options.only.length > 0 ? offered.filter(({ id }) => options.only.includes(id)) : offered;
  if (!options.apply || selected.length === 0) return result(EXIT_SUCCESS, renderLines(judged.candidates).join(LF));
  const written = writeSelected(root, judged, selected, deps);
  if (written.refusal) return written.refusal;
  return result(EXIT_SUCCESS, renderLines(written.candidates).join(LF));
};

export const main = (argv, deps = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.help) return result(EXIT_SUCCESS, OUTCOME_LINES.help());
  if (parsed.problem) return result(EXIT_USAGE, '', OUTCOME_LINES.usage(parsed.problem));
  return runVerb(parsed, deps);
};

if (isDirectRun(import.meta.url)) {
  const outcome = main(process.argv.slice(ARGV_OFFSET));
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exitCode = outcome.code;
}

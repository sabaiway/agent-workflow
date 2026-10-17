#!/usr/bin/env node
// attribution.mjs — the writer of the advisor's `attribution` item: when the project's AGENTS.md block
// reads off, it sets Claude Code's `attribution` setting in the project .claude/settings.json so the
// harness adds no Co-Authored-By trailer, PR text or session link. Preview by default; --apply writes.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLAUDE_DIR, EXPECTED_WORKFLOW_VERSION, SETTINGS_FILE, preflightVelocityProfile } from './velocity-profile.mjs';
import { formatJson } from './gate-hook.mjs';
import { isDirectRun } from './direct-run.mjs';

export const ATTRIBUTION_KEY = 'attribution';
export const LEGACY_ATTRIBUTION_KEY = 'includeCoAuthoredBy';
// The one form the writer writes: `false` would make a CLI older than v2.1.281 skip the whole file.
export const ATTRIBUTION_HIDDEN = Object.freeze({ commit: '', pr: '', sessionUrl: false });
export const ATTRIBUTION_MALFORMED = 'ATTRIBUTION_MALFORMED';
export const ATTRIBUTION_STAMP = 'ATTRIBUTION_STAMP';
export const ATTRIBUTION_SHARED_NOTICE = `notice: ${SETTINGS_FILE} is the project-scope settings file — in a visible deployment it is committed and shared with everyone on this project, as the AGENTS.md block is`;

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const USAGE = 'usage: attribution [--cwd <root>] [--apply]';
const CHOICE_LINE = /^> \*\*Agent attribution: ([^*\s]+)\*\*/mu;
const CHOICES = ['off', 'on'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => isObject(object) && Object.hasOwn(object, key);
const refusal = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code, exitCode: EXIT_REFUSED });
const usageError = (message) => Object.assign(new Error(message), { exitCode: EXIT_USAGE });

// off, on, or null for an absent file, an absent line or another value; any other read failure throws.
export const readAttributionChoice = (root, deps = {}) => {
  let text;
  try {
    text = String((deps.readFile ?? readFileSync)(join(root, 'AGENTS.md'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const value = text.match(CHOICE_LINE)?.[1];
  return CHOICES.includes(value) ? value : null;
};

// Per key, the local file's value while it carries the key, else the project's; an object is taken whole.
export const effectiveAttribution = (project, local) => Object.fromEntries([ATTRIBUTION_KEY, LEGACY_ATTRIBUTION_KEY]
  .map((key) => [key, hasOwn(local, key) ? local[key] : project?.[key]])
  .filter(([, value]) => value !== undefined));

export const attributionHidesText = (effective) => {
  const value = effective?.[ATTRIBUTION_KEY];
  if (value === false) return true;
  if (isObject(value) && value.commit === '' && value.pr === '') return true;
  const setsText = hasOwn(value, 'commit') || hasOwn(value, 'pr');
  return !setsText && effective?.[LEGACY_ATTRIBUTION_KEY] === false;
};

// The wrong-typed key of one settings file, or null: attribution is an object or a boolean, the legacy key a boolean.
export const wrongTypedKey = (data) => {
  if (hasOwn(data, ATTRIBUTION_KEY) && !isObject(data[ATTRIBUTION_KEY]) && typeof data[ATTRIBUTION_KEY] !== 'boolean') {
    return `${ATTRIBUTION_KEY} must be an object or a boolean`;
  }
  if (hasOwn(data, LEGACY_ATTRIBUTION_KEY) && typeof data[LEGACY_ATTRIBUTION_KEY] !== 'boolean') return `${LEGACY_ATTRIBUTION_KEY} must be a boolean`;
  return null;
};

export const writeAttribution = ({ cwd, dryRun = true } = {}, deps = {}) => {
  const root = resolve(cwd ?? deps.cwd ?? process.cwd());
  const preflight = preflightVelocityProfile({ cwd: root }, deps);
  const before = preflight.projectSettings.data ?? null;
  const malformed = wrongTypedKey(before);
  if (malformed) throw refusal(ATTRIBUTION_MALFORMED, `${SETTINGS_FILE}: ${malformed} — nothing written`);
  const planned = !attributionHidesText(effectiveAttribution(before, preflight.localSettings.data));
  const after = planned ? { ...before, [ATTRIBUTION_KEY]: { ...ATTRIBUTION_HIDDEN } } : before;
  const result = { root, planned, wrote: false, before, after, claudeDirAbsent: preflight.claudeDirAbsent };
  if (dryRun || !planned) return result;
  if (!preflight.stampOk) {
    throw refusal(ATTRIBUTION_STAMP, `not a deployed agent-workflow project at lineage ${EXPECTED_WORKFLOW_VERSION} (found ${preflight.stamp ?? 'none'}) — run /agent-workflow-kit upgrade first`);
  }
  if (preflight.claudeDirAbsent) (deps.mkdir ?? mkdirSync)(join(root, CLAUDE_DIR), { recursive: true });
  (deps.writeFile ?? writeFileSync)(join(root, SETTINGS_FILE), formatJson(after, preflight.projectSettings.eol ?? '\n'), 'utf8');
  return { ...result, wrote: true };
};

export const formatResult = (result, dryRun) => {
  if (!result.planned) return ['nothing to change: the settings already hide the trailer and the PR text'];
  const object = JSON.stringify(ATTRIBUTION_HIDDEN);
  return dryRun ? [`would set ${ATTRIBUTION_KEY} (${SETTINGS_FILE}): ${object}`, ATTRIBUTION_SHARED_NOTICE]
    : [`set ${ATTRIBUTION_KEY} (${SETTINGS_FILE}): ${object}`];
};

export const parseArgs = (argv) => {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const args = { help: false, apply: false, cwd: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--cwd') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) throw usageError('--cwd takes a value');
      args.cwd = value;
      index += 1;
    } else throw usageError(`unknown argument: ${flag}`);
  }
  return args;
};

export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      log(USAGE);
      return EXIT_OK;
    }
    args.root = resolve(deps.cwd ?? process.cwd(), args.cwd ?? '.');
    if (!statSync(args.root, { throwIfNoEntry: false })?.isDirectory()) throw usageError(`--cwd is not a directory: ${args.root}`);
  } catch (error) {
    errlog(error.message);
    errlog(USAGE);
    return EXIT_USAGE;
  }
  try {
    const result = writeAttribution({ cwd: args.root, dryRun: !args.apply }, deps);
    for (const line of formatResult(result, !args.apply)) log(line);
    return EXIT_OK;
  } catch (error) {
    errlog(error?.message ?? String(error));
    return EXIT_REFUSED;
  }
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));

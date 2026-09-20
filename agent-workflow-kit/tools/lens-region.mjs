#!/usr/bin/env node
// The only mutation of a deployed rules file the composition root runs WITHOUT a consent ask.
import { isDirectRun } from './direct-run.mjs';
import { normalizeCanonical } from './orchestration-config.mjs';
import { RULES_REGIONS, extractRegionBy, readTemplateSpan, frontmatterMaxLines, exceedsCap } from './rules-regions.mjs';

export { frontmatterMaxLines } from './rules-regions.mjs';
const [COMMUNICATION, STORY, LENS] = RULES_REGIONS;
export const LENS_HEADING_RE = LENS.headingRe;
export const COMMS_HEADING_RE = COMMUNICATION.headingRe;
export const COMMS_PRIORS = COMMUNICATION.priors;
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const CRLF = CR + LF;
const BACKSLASH = String.fromCharCode(92);
const EM_DASH = String.fromCharCode(8212);
const EXIT_OK = 0;
const EXIT_STOP = 1;
const EXIT_USAGE = 2;
const CLI_ARG_COUNT = 2;
const SCRIPT_ARG_OFFSET = 2;
const SINGLE_HEADING = 1;
const HEX_RADIX = 16;
const UNICODE_WIDTH = 4;
const UTF8 = 'utf8';
const RECONCILE_COMMAND = 'reconcile';
const USAGE = 'usage: lens-region.mjs reconcile <path/to/agent_rules.md>';
const PRIOR_START = '<!-- prior';
const PRIOR_END = '-->';
const NUMBERED_HEADING_RE = /^### 2[.][0-9]+[.]/;
const NEUTRAL_HEADING = '### 2.x.';
const NEUTRAL_LENS_RE = /^### 2[.]x[.] Planning, review & process-fidelity/;
const NEUTRAL_COMMS_RE = /^### 2[.]x[.] Communication [(]user-facing messages[)]/;
const NEUTRAL_STORY_RE = /^### 2[.]x[.] Story sessions/;
const LINE_UNSAFE = new RegExp(`[${BACKSLASH}u007f-${BACKSLASH}u009f${BACKSLASH}u2028${BACKSLASH}u2029]`, 'g');
const HUMAN_UNSAFE = new RegExp(`[${BACKSLASH}u0000-${BACKSLASH}u001f${BACKSLASH}u007f-${BACKSLASH}u009f${BACKSLASH}u2028${BACKSLASH}u2029]+`, 'g');
const INSERT_NOTE = '[lens-region] note: preview the absent section with `node <kit>/tools/rules-insert.mjs --cwd <project>`; use `--apply` only after an explicit yes.';
const OUTCOME_PREFIXES = Object.freeze({ communication: 'comms', 'story-sessions': 'story', lens: 'lens' });
const stripCr = (line) => (line.endsWith(CR) ? line.slice(0, -1) : line);
const escUnsafe = (character) => `${BACKSLASH}u${character.codePointAt(0).toString(HEX_RADIX).padStart(UNICODE_WIDTH, '0')}`;
const errorDetail = (raw) => `[lens-region] error=${JSON.stringify(String(raw)).replace(LINE_UNSAFE, escUnsafe)}`;
const oneLine = (value) => String(value).replace(HUMAN_UNSAFE, ' ');

export const parseLensPriors = (text) => {
  const entries = [];
  for (const line of String(text).split(LF)) {
    const bare = stripCr(line);
    if (bare.startsWith(PRIOR_START) && bare.endsWith(PRIOR_END)) {
      entries.push([]);
    } else if (entries.length) {
      entries.at(-1).push(line);
    }
  }
  return entries.map((entry) => normalizeCanonical(entry.join(LF))).filter((entry) => entry !== '');
};

const renderRegion = (fragment, number, headingRe) =>
  normalizeCanonical(fragment).replace(headingRe, (heading) => heading.replace('2.x', `2.${number}`));
export const renderLens = (fragment, number) => renderRegion(fragment, number, NEUTRAL_LENS_RE);
export const renderComms = (fragment, number) => renderRegion(fragment, number, NEUTRAL_COMMS_RE);
export const renderStory = (fragment, number) => renderRegion(fragment, number, NEUTRAL_STORY_RE);
export const normalizeLensBody = (body) =>
  normalizeCanonical(String(body).replace(NUMBERED_HEADING_RE, NEUTRAL_HEADING));
export const normalizeCommsBody = normalizeLensBody;
export const normalizeStoryBody = normalizeLensBody;
export const extractLensRegion = (text) => extractRegionBy(text, LENS_HEADING_RE);
export const extractCommsRegion = (text) => extractRegionBy(text, COMMS_HEADING_RE);
export const extractStoryRegion = (text) => extractRegionBy(text, STORY.headingRe);

export const replaceLensRegion = (text, region, renderedBody) => {
  const lines = String(text).split(LF);
  const crlf = String(text).includes(CRLF);
  const regionLines = lines.slice(region.start, region.end);
  const bodyEnd = regionLines.findLastIndex((line) => stripCr(line).trim() !== '') + 1;
  const trailing = regionLines.slice(bodyEnd);
  const newBody = renderedBody.split(LF).map((line) => (crlf ? line + CR : line));
  const out = [...lines.slice(0, region.start), ...newBody, ...trailing, ...lines.slice(region.end)];
  // At EOF without a newline, the final line must not gain a dangling CR.
  if (crlf && trailing.length === 0 && region.end === lines.length) {
    out[out.length - 1] = stripCr(out.at(-1));
  }
  return out.join(LF);
};

const reconcileRegionText = (text, fragment, priors, { extract, normalize, render }) => {
  const region = extract(text);
  if (!region.found) return { status: 'no-region', text };
  if (region.count > SINGLE_HEADING) return { status: 'custom', text };
  const current = normalize(region.body);
  const canon = normalize(fragment);
  if (current === canon) return { status: 'current', text };
  const known = priors.map((prior) => normalize(prior));
  if (!known.includes(current)) return { status: 'custom', text };
  return { status: 'refreshed', text: replaceLensRegion(text, region, render(fragment, region.number)) };
};
export const reconcileLensText = (text, fragment, priors) =>
  reconcileRegionText(text, fragment, priors, { extract: extractLensRegion, normalize: normalizeLensBody, render: renderLens });
export const reconcileCommsText = (text, fragment, priors) =>
  reconcileRegionText(text, fragment, priors, { extract: extractCommsRegion, normalize: normalizeCommsBody, render: renderComms });
export const reconcileStoryText = (text, fragment, priors) =>
  reconcileRegionText(text, fragment, priors, { extract: extractStoryRegion, normalize: normalizeStoryBody, render: renderStory });
const RECONCILERS = Object.freeze({ communication: reconcileCommsText, 'story-sessions': reconcileStoryText, lens: reconcileLensText });

export const OUTCOME_LINES = Object.freeze({
  errorDetail,
  targetAbsent: (target) => `[lens-region] ${oneLine(target)} is absent ${EM_DASH} skipped (nothing to update; the file is seeded at bootstrap).`,
  commsNoRegion: (target) => [
    `[lens-region] no "${COMMUNICATION.label}" section in ${oneLine(target)} ${EM_DASH} left untouched.`,
    INSERT_NOTE,
  ],
  commsCurrent: () => `[lens-region] Communication section already current ${EM_DASH} nothing to do (zero-diff).`,
  commsCustom: () => [
    `[lens-region] Communication section carries a custom edit ${EM_DASH} preserved verbatim.`,
    `[lens-region] note: the canonical Communication section has changed since this section was edited ${EM_DASH} compare it with the current template when convenient; your wording is never overwritten.`,
  ],
  capSkipNote: () => '[lens-region] note: no `maxLines` frontmatter on the target ' + EM_DASH + ' the line-cap guard is skipped.',
  commsCapRefused: (target, count, cap) => `[lens-region] refused ${EM_DASH} refreshing the Communication section would push ${oneLine(target)} to ${count} lines (cap ${cap}); trim the file and re-run. The Communication section was not changed.`,
  commsRefreshed: () => '[lens-region] refreshed the Communication section to the current canon.',
  templateCanonStop: () => `[lens-region] STOP ${EM_DASH} the kit's bundled agent_rules.md template canon is unreadable; reinstall the kit: npx @sabaiway/agent-workflow-kit@latest init`,
  storyNoRegion: (target) => [
    `[lens-region] no "${STORY.label}" section in ${oneLine(target)} ${EM_DASH} left untouched.`,
    INSERT_NOTE,
  ],
  storyCurrent: () => `[lens-region] Story sessions section already current ${EM_DASH} nothing to do (zero-diff).`,
  storyCustom: () => [
    `[lens-region] Story sessions section carries a custom edit ${EM_DASH} preserved verbatim.`,
    `[lens-region] note: this body differs from the bundled template's Story sessions section ${EM_DASH} compare the two when convenient; your wording is never overwritten.`,
  ],
  storyCapRefused: (target, count, cap) => `[lens-region] refused ${EM_DASH} refreshing the Story sessions section would push ${oneLine(target)} to ${count} lines (maxLines ${cap}); trim the file and re-run. The Story sessions section was not changed.`,
  storyRefreshed: () => '[lens-region] refreshed the Story sessions section to the current canon.',
  regionHeadingTwice: (label, target) => [
    `[lens-region] more than one "${oneLine(label)}" section in ${oneLine(target)} ${EM_DASH} preserved verbatim.`,
    '[lens-region] note: give the sections distinct headings before retrying; their wording was not changed.',
  ],
  lensNoRegion: (target) => [
    `[lens-region] no "${LENS.label}" section in ${oneLine(target)} ${EM_DASH} left untouched.`,
    `[lens-region] note: the planning/review lens section is missing or renamed ${EM_DASH} it cannot be auto-refreshed; restore the canonical heading to re-enable refresh.`,
  ],
  engineTooOld: () => '[lens-region] skipped ' + EM_DASH + ' the installed engine is too old (or incomplete) to supply the lens canon; refresh it with `npx @sabaiway/agent-workflow-engine@latest init`, then re-run.',
  engineStop: (err) => {
    const human = `[lens-region] STOP ${EM_DASH} ${oneLine(err?.stable ?? err?.message ?? String(err))}`;
    return err?.reason ? [human, errorDetail(err.reason)] : [human];
  },
  lensCurrent: () => `[lens-region] lens section already current ${EM_DASH} nothing to do (zero-diff).`,
  lensCustom: () => [
    `[lens-region] lens section carries a custom edit ${EM_DASH} preserved verbatim.`,
    `[lens-region] note: the canonical planning/review lens has changed since this section was edited ${EM_DASH} compare it with the project methodology canon when convenient; your wording is never overwritten.`,
  ],
  lensCapRefused: (target, count, cap) => `[lens-region] refused ${EM_DASH} refreshing would push ${oneLine(target)} to ${count} lines (cap ${cap}); trim the file and re-run. The planning/review lens section was not changed.`,
  lensRefreshed: () => '[lens-region] refreshed the planning/review lens section to the current canon.',
});

const readLensCanon = async (deps, log, logError) => {
  const { homedir } = await import('node:os');
  const { resolveEngineDir, detectEngine, readEngineFragment, LENS_FRAGMENT_REL, LENS_PRIORS_REL } = await import('./engine-source.mjs');
  const { dir, source } = resolveEngineDir({ env: deps.env ?? process.env, home: deps.home ?? homedir() });
  const lensPairPresent =
    detectEngine(dir, { source, rel: LENS_FRAGMENT_REL }).ok && detectEngine(dir, { source, rel: LENS_PRIORS_REL }).ok;
  if (!lensPairPresent) {
    if (detectEngine(dir, { source }).ok) {
      log(OUTCOME_LINES.engineTooOld());
      return { code: EXIT_OK };
    }
    try {
      readEngineFragment(dir, { source, rel: LENS_FRAGMENT_REL });
      return { code: EXIT_STOP };
    } catch (err) {
      for (const line of OUTCOME_LINES.engineStop(err)) logError(line);
      return { code: EXIT_STOP };
    }
  }
  try {
    const fragment = readEngineFragment(dir, { source, rel: LENS_FRAGMENT_REL, readFileSync: deps.engineRead });
    const priors = parseLensPriors(readEngineFragment(dir, { source, rel: LENS_PRIORS_REL, readFileSync: deps.engineRead }));
    return { fragment, priors };
  } catch (err) {
    for (const line of OUTCOME_LINES.engineStop(err)) logError(line);
    return { code: EXIT_STOP };
  }
};

export const runCli = async (argv, deps = {}) => {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  if (argv[0] !== RECONCILE_COMMAND || !argv[1] || argv.length > CLI_ARG_COUNT) {
    logError(USAGE);
    return EXIT_USAGE;
  }
  const fs = deps.fs ?? (await import('node:fs/promises'));
  const { dirname, basename, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const targetPath = resolve(argv[1]);
  const text = await (async () => {
    try {
      return await fs.readFile(targetPath, UTF8);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  })();
  if (text === null) {
    log(OUTCOME_LINES.targetAbsent(argv[1]));
    return EXIT_OK;
  }
  const templatePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'templates', 'agent_rules.md');
  const template = await (async () => {
    try {
      const source = await fs.readFile(templatePath, UTF8);
      const spans = RULES_REGIONS.filter((region) => region.canon === 'template')
        .map((region) => [region.id, readTemplateSpan(source, region.headingRe)]);
      return { spans: Object.fromEntries(spans), defect: spans.some(([, span]) => span.defect) };
    } catch (err) {
      return { defect: true, error: err?.message ?? String(err) };
    }
  })();
  if (template.defect) {
    logError(OUTCOME_LINES.templateCanonStop());
    if (template.error) logError(OUTCOME_LINES.errorDetail(template.error));
    return EXIT_STOP;
  }
  const atomicWrite = async (content) => {
    const tmp = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmp, content, UTF8);
      await fs.rename(tmp, targetPath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };
  const outcome = await RULES_REGIONS.reduce(async (previous, descriptor) => {
    const state = await previous;
    if (state.code !== EXIT_OK) return state;
    const region = extractRegionBy(state.text, descriptor.headingRe);
    const prefix = OUTCOME_PREFIXES[descriptor.id];
    if (region.count > SINGLE_HEADING) {
      for (const line of OUTCOME_LINES.regionHeadingTwice(descriptor.label, argv[1])) log(line);
      return state;
    }
    if (!region.found) {
      for (const line of OUTCOME_LINES[`${prefix}NoRegion`](argv[1])) log(line);
      return state;
    }
    const canon = descriptor.canon === 'template'
      ? { fragment: normalizeLensBody(template.spans[descriptor.id].span), priors: descriptor.priors }
      : await readLensCanon(deps, log, logError);
    if (canon.code !== undefined) return { text: state.text, code: canon.code };
    const result = RECONCILERS[descriptor.id](state.text, canon.fragment, canon.priors);
    if (result.status === 'current') {
      log(OUTCOME_LINES[`${prefix}Current`]());
      return state;
    }
    if (result.status === 'custom') {
      for (const line of OUTCOME_LINES[`${prefix}Custom`]()) log(line);
      return state;
    }
    const cap = frontmatterMaxLines(state.text);
    const decision = exceedsCap(result.text, cap);
    if (decision.skipped) log(OUTCOME_LINES.capSkipNote());
    if (decision.over) {
      log(OUTCOME_LINES[`${prefix}CapRefused`](argv[1], decision.count, cap));
      return state;
    }
    await atomicWrite(result.text);
    log(OUTCOME_LINES[`${prefix}Refreshed`]());
    return { text: result.text, code: EXIT_OK };
  }, Promise.resolve({ text, code: EXIT_OK }));
  return outcome.code;
};

if (isDirectRun(import.meta.url)) process.exitCode = await runCli(process.argv.slice(SCRIPT_ARG_OFFSET));

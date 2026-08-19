// worktree-prompt.mjs — the satellite session's COLD-START prompt (delegation Plan 3, Phase 2).
//
// A satellite is a fresh session in a checkout that looks like the repo and is not: the series index
// lives only in MAIN, the landing runs only from MAIN, and the one channel back is the handoff. None
// of that is derivable from inside the worktree, so `provision` ends its report with this prompt and
// `worktrees prompt <slug>` re-prints it later.
//
// PURE over its inputs (plus one injected readdir for the seeded-plan rule): it composes text and
// decides nothing. Node built-ins plus two pure leaves; no git, no writes, no CLI, no side effects
// on import. Dependency-free, Node >= 22.

import { join } from 'node:path';
import { plansInFlight, PLANS_REL } from './plan-files.mjs';
import {
  stop, handoffBasename, QUEUE_SHARED_RULE, composeLandingValue, hasControlByte, displayValue,
} from './worktrees-record.mjs';

export { WORKTREES_STOP } from './worktrees-record.mjs';

// The command grammar. Every command this prompt puts in front of a reader is a marked line naming
// WHO runs it — `    MAIN $ …` or `    HERE $ …` — so the runnable set is enumerable AND attributed.
// The actor is not decoration: the one command the prompt carries today runs from MAIN and mutates
// MAIN, which is precisely what the satellite is forbidden to do, and an unattributed `$` line reads
// as an instruction to whoever is holding the prompt.
export const PROMPT_ACTORS = Object.freeze({ main: 'MAIN', here: 'HERE' });
const COMMAND_INDENT = '    ';
const COMMAND_LINE = new RegExp(`^${COMMAND_INDENT}(MAIN|HERE) \\$ (.*)$`);

const commandLine = (actor, command) => `${COMMAND_INDENT}${actor} $ ${command}`;

// promptCommands(text) → [{ actor, command }] — the closed set of commands the prompt offers.
export const promptCommands = (text) => String(text)
  .split('\n')
  .flatMap((line) => {
    const m = line.match(COMMAND_LINE);
    return m === null ? [] : [{ actor: m[1], command: m[2] }];
  });

// D7: one writer per worktree is a BAR, not a mechanism — stated at every point of use precisely
// because nothing refuses a second writer.
export const ONE_WRITER_BAR = 'ONE writer per worktree: this session is the only agent writing in this checkout, and nothing enforces that — a second session writing here interleaves two agents into one tree, which neither this tool nor git can detect or undo. It is a bar you keep, not a lock you hold.';

// The v1 satellite contract, stated where the satellite reads rather than only in the mode doc.
export const FORBIDDEN_VERBS_BAR = 'Forbidden from this worktree: git commit, git push, git tag, git stash, any history rewrite other than the tool-printed reset of this branch, the kit lifecycle writers, version bumps and publishes, edits to MAIN files, and every write to the shared series index — the landing runs from MAIN and the commit stays a dialogue ask there.';

// The seeded plan is the ONE fact only the satellite's own directory answers, and the EXACTLY-ONE
// rule is the one the resume lane already trusts: a prompt naming the wrong plan is worse than a
// prompt that refuses to name one.
export const resolveSeededPlan = ({ wtRoot, readdir }) => {
  // plansInFlight answers [] for EVERY readdir failure, which reads as "no plan in flight" — true
  // for an absent directory and false for a denied or broken one. So the directory is read ONCE,
  // here, and that single result is what gets classified: a second read could succeed where the
  // first failed (or the reverse) and put the two answers back out of step.
  let entries;
  try {
    entries = readdir(join(wtRoot, PLANS_REL), { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw stop(`the worktree's ${PLANS_REL} could not be read (${err?.code ?? 'fs error'}) — the cold-start prompt cannot name a plan it was never able to look for`);
    }
    entries = [];
  }
  const inFlight = plansInFlight(wtRoot, () => entries);
  if (inFlight.length !== 1) {
    // The names are filesystem-provided and this message is read in a terminal, so they are
    // rendered escaped — a refusal must never be the thing that lets a hostile name forge a line.
    throw stop(
      `the worktree must hold EXACTLY ONE in-flight plan, found [${inFlight.map(displayValue).join(', ')}] — ` +
      'the cold-start prompt cannot name a plan the satellite does not uniquely hold',
    );
  }
  return inFlight[0];
};

// The prompt is LINE-oriented, exactly like the record it reads from, so a control byte in ANY value
// it interpolates forges a line — including a forged command line, which `promptCommands` would then
// report as real. The values arrive from filesystem names, from a repo path and from a hand-editable
// record, so none of them is trustworthy by provenance. Note that JSON.stringify is NOT a defence
// here: it escapes CR/LF but passes U+007F and U+2028/U+2029 through untouched.
// Fail closed: refuse to compose, never sanitize silently.
const promptValue = (name, value) => {
  if (value == null) return null;
  if (hasControlByte(value)) {
    throw stop(`the satellite cold-start prompt cannot be composed: ${name} carries a control character, which would forge a line in a line-oriented prompt`);
  }
  return String(value);
};

const required = (name, value) => {
  if (value == null || value === '') {
    throw stop(`the satellite cold-start prompt cannot be composed: ${name} is missing — a prompt short of an orientation fact reads complete and is not`);
  }
  return value;
};

// D16: an orientation value FROZEN into the provision record can go stale — MAIN moves, or a field
// is hand-edited — so the live value is what renders and the recorded one is only NAMED. An ABSENT
// field (an older kit's record) is no divergence at all: there is nothing it disagrees with.
const divergence = (label, live, recorded, cause) => (recorded == null || recorded === live ? [] : [
  `  record divergence: the provision record recorded ${label} as ${JSON.stringify(recorded)} — the live value above is what answers now, so the record is stale: ${cause}.`,
]);

const MAIN_CAUSE = 'a moved MAIN, or a hand edit';
// The install posture is NOT a MAIN fact: it is probed on this checkout, so it diverges from the
// record whenever the checkout's own dependency declaration or node_modules changes — the ordinary
// case, with no moved MAIN and no hand edit anywhere.
const INSTALL_CAUSE = 'this checkout answers differently now, most often because its dependency declaration or its node_modules changed since provision';

// live: { sharedQueue, landingRule, landingCommand, installPosture, installDescription,
// installCommand } — derived by the caller at print time. The landing pair and the checkout identity
// have no "cannot answer" state and are REQUIRED; the series index and the install trio may be
// absent and then render by omission. The install arrives in THREE parts on purpose: the posture is
// the record's field and the divergence key and is never printed, the description is its prose half,
// and the command is the runnable half — because the posture string IS a command in the ordinary
// case, and printing it as prose would offer an instruction nothing attributes. `record` is the
// parsed provision record and is required too — a caller that could not read it must say so, not
// hand in an empty object that renders as "nothing diverged".
export const composeSatellitePrompt = ({ slug, branch, worktreePath, plan, live, record }) => {
  if (live == null || typeof live !== 'object') {
    throw stop('the satellite cold-start prompt cannot be composed: the live orientation is missing — every value the prompt states is derived at print time, so there is nothing to state without it');
  }
  if (record == null || typeof record !== 'object') {
    throw stop('the satellite cold-start prompt cannot be composed: the provision record is missing — a prompt composed against no record would silently claim nothing has drifted');
  }
  const safeSlug = promptValue('slug', required('slug', slug));
  const safeBranch = promptValue('branch', required('branch', branch));
  const safePath = promptValue('worktree path', required('worktree path', worktreePath));
  const safePlan = promptValue('seeded plan', required('seeded plan', plan));
  const rule = promptValue('live.landingRule', required('live.landingRule', live.landingRule));
  const command = promptValue('live.landingCommand', required('live.landingCommand', live.landingCommand));
  const queue = promptValue('live.sharedQueue', live.sharedQueue);
  const installPosture = promptValue('live.installPosture', live.installPosture);
  const installDescription = promptValue('live.installDescription', live.installDescription);
  const installCommand = promptValue('live.installCommand', live.installCommand);
  const recorded = {
    sharedQueue: promptValue('record shared-queue', record.sharedQueue),
    landing: promptValue('record landing', record.landing),
    install: promptValue('record install', record.install),
  };

  const handoffRel = `${PLANS_REL}/${handoffBasename(safeSlug)}`;
  const lines = [
    `# Satellite session — ${safeSlug}`,
    '',
    'A linked git worktree provisioned by agent-workflow. You work HERE; MAIN lands what you produce',
    'and owns every commit.',
    '',
    '## This checkout',
    `- worktree: ${safePath}`,
    `- branch: ${safeBranch}`,
    `- seeded plan: ${PLANS_REL}/${safePlan}`,
    `- handoff: ${handoffRel}`,
    '',
    '## MAIN orientation — derived LIVE from MAIN, never replayed from the provision record',
  ];
  if (queue !== null) {
    lines.push(
      `- series index: ${queue}`,
      `  ${QUEUE_SHARED_RULE}`,
      ...divergence('shared-queue', queue, recorded.sharedQueue, MAIN_CAUSE),
    );
  }
  lines.push(
    `- landing: ${rule}`,
    commandLine(PROMPT_ACTORS.main, command),
    ...divergence('landing', composeLandingValue({ rule, command }), recorded.landing, MAIN_CAUSE),
  );
  if (installDescription !== null) {
    lines.push(
      '',
      '## This checkout is where the install posture comes from — probed here, not in MAIN',
      `- install: ${installDescription}`,
      ...(installCommand === null ? [] : [commandLine(PROMPT_ACTORS.here, installCommand)]),
      ...divergence('install', installPosture, recorded.install, INSTALL_CAUSE),
    );
  }
  lines.push(
    '',
    '## The return channel',
    `${handoffRel} is the ONE channel back to MAIN: findings for the series index, decisions taken`,
    'here, and the session records all go there. Everything outside `## Provision record` is yours and',
    `the tool preserves it byte for byte, while ${PLANS_REL} itself never lands — a note left anywhere`,
    'else in this worktree is lost at cleanup.',
    '',
    '## Bars — kept, not enforced',
    ONE_WRITER_BAR,
    FORBIDDEN_VERBS_BAR,
  );
  return lines.join('\n');
};

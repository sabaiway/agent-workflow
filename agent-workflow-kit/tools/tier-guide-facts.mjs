// spec:tier-guide — docs/ai/specs/kit/tier/tier-guide/index.md and its part guide-stages.md
import { lstatSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { resolveGitLocation } from './git-env.mjs';
import { EPICS_REL, readEpicStore } from './epic-store.mjs';
import { checkEpic } from './epic-shape.mjs';
import { QUEUE_PATH, checkClaims, judgeClose, sweepSiblings } from './epic-shape-ledger.mjs';
import { PLANS_REL, isScratchPlanName, plansInFlight, readPlanEntries } from './plan-files.mjs';
import { PIN_FILE, readStoryLine } from './plan-shape-ownership.mjs';
import { PLAN_HEADINGS, checkPlan, isSweep, parseLedger } from './plan-shape.mjs';
import { buildFacts, openRepo } from './plan-shape-facts.mjs';
import { newestCheckpoint } from './checkpoint.mjs';
import { withRepository } from './checkpoint-core.mjs';
import { parseBrief } from './task-brief.mjs';
import { escapeForDisplay, isRenderableLine, shellQuoteArg } from './repo-lex.mjs';

const WORK_TREE = 'work-tree';
const LF = '\n';
const MARKDOWN = '.md';
const INFO = 'info';
const LANDED = 'landed';
const EPIC_TYPE = /^type:\s*epic\s*$/;
const FRONT = '---';
const CR_END = /\r$/;
const SPAN = /\{\{([\s\S]*?)\}\}/g;
const PLAN_STEM = /^[A-Za-z0-9_-]+$/;
// The brief grammar's Plan field, matched one line at a time as task-brief matches it.
const PLAN_FIELD = /^Plan: (docs\/plans\/[^/]+\.md)$/;
const TASK_PREFIX = 'TASK-';
const TASK_NUMBER = /-T([1-9][0-9]*)\.md$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NO_CHECKPOINT = 'no-checkpoint';
const HEADER_CODES = new Set(['sibling-header', 'sibling-read']);
const HEAD_ARGS = ['rev-parse', '-q', '--verify', 'HEAD^{commit}'];
const STAND_IN_EPIC = 'NEW-EPIC';
const E1_CAUSE = `no epic file in ${EPICS_REL}`;
const EPIC_TEMPLATE = '../references/authoring/EPIC_TEMPLATE.md';
const TASK_TEMPLATE = '../references/authoring/TASK_TEMPLATE.md';
const TEMPLATE_VERBS = new Set(['create', 'modify']);
const READERS = Object.freeze({ store: 'readEpicStore', sweep: 'sweepSiblings', entries: 'readPlanEntries',
  plans: 'plansInFlight', plan: 'checkPlan', brief: 'parseBrief', sequence: 'newestCheckpoint', head: 'readGit' });

const q = shellQuoteArg;
const action = (kind, text, command = null) => ({ kind, text: escapeForDisplay(text), command });
const lineOf = (kind, text, parts) => (parts.every(isRenderableLine)
  ? action(kind, text, parts.join(' '))
  : action(kind, `${text} (not printed as a command: ${parts.filter((part) => !isRenderableLine(part)).map(escapeForDisplay).join(', ')} cannot stand on one line)`));
const makeTools = (toolsDir) => {
  const tool = (name) => q(`${toolsDir}/${name}`);
  const node = (kind, text, name, ...args) => lineOf(kind, text, ['node', tool(name), ...args]);
  return {
    epicCheck: (path, kind = 'run') => node(kind, `check the epic ${path}`, 'epic-shape-cli.mjs', '--check', q(path)),
    review: (path) => node('run', `read the review brief of the epic ${path}; the solo review is the reading of it`, 'epic-shape-cli.mjs', '--review-brief', q(path)),
    close: (path) => node('run', `close the epic ${path}`, 'epic-shape-cli.mjs', '--close', q(path)),
    planCheck: (plan) => node('run', `check the plan ${plan}`, 'plan-shape-cli.mjs', '--check', q(plan)),
    planVerify: (plan) => node('run', `verify the plan ${plan} against the tree`, 'plan-shape-cli.mjs', '--verify', q(plan)),
    mint: (plan) => node('run', `mint a checkpoint of the plan ${plan}`, 'checkpoint.mjs', 'mint', '--plan', q(plan)),
    prune: (plan) => node('run', `prune the checkpoints of the plan ${plan}`, 'checkpoint.mjs', 'prune', '--plan', q(plan)),
    stamp: (brief) => node('run', `stamp the brief ${brief}`, 'task-brief.mjs', 'stamp', q(brief)),
    check: (brief) => node('run', `check the brief ${brief}`, 'task-brief.mjs', 'check', q(brief)),
    reviewState: () => node('run', 'check the review state of the tree', 'review-state.mjs', '--check'),
    copy: (template, target, text) => lineOf('write', text, ['cp', q(resolve(toolsDir, template)), q(target)]),
  };
};
const state = (reader, file, cause, next = null) => ({ reader, file, cause: escapeForDisplay(cause), next });
const findSpans = (file, text) => [...text.matchAll(SPAN)].map(([, span]) => ({ file, span: escapeForDisplay(span) }));
const readText = (cwd, path) => {
  const result = readRegularFileNoFollow(resolve(cwd, path));
  return result.outcome === 'ok' ? { text: result.content } : { cause: `${result.outcome}: ${result.code ?? result.className ?? 'unreadable'}` };
};
const isPresent = (cwd, path) => lstatSync(resolve(cwd, path), { throwIfNoEntry: false }) !== undefined;
// The lines of a file as the kit's readers see them: a CRLF file reads as its LF twin.
const linesOf = (text) => text.split(LF).map((line) => line.replace(CR_END, ''));
const declaresEpic = (text) => {
  const lines = linesOf(text);
  if (lines[0] !== FRONT) return false;
  const end = lines.indexOf(FRONT, 1);
  return end > 0 && lines.slice(1, end).some((line) => EPIC_TYPE.test(line));
};
const stripPath = (finding) => (finding.message.startsWith(`${finding.path}: `) ? finding.message.slice(finding.path.length + 2) : finding.message);

const readHead = (cwd, env) => withRepository(cwd, { env }, (context) => {
  const result = context.run(HEAD_ARGS, context.top, undefined, context.env);
  const stdout = String(result.stdout ?? '').trim();
  if (result.status === 0 && OID.test(stdout)) return { ok: true, oid: stdout };
  if (result.status === 1 && stdout === '' && !result.error) return { ok: true, oid: null };
  return { ok: false, reason: String(result.stderr ?? result.error?.message ?? 'HEAD could not be read').trim() };
});

const readStore = (cwd) => {
  const store = readEpicStore(cwd);
  if (store.outcome === 'refused') return { states: [state(READERS.store, EPICS_REL, store.reason)], entries: [], epics: [], blocked: true };
  const entries = store.entries ?? [];
  const states = entries.filter((entry) => entry.outcome === 'unreadable' || entry.outcome === 'non-regular')
    .map((entry) => state(READERS.store, `${EPICS_REL}/${entry.name}`, `${entry.outcome}: ${entry.reason ?? entry.kind}`));
  const sweep = sweepSiblings(entries, EPICS_REL);
  const headerFindings = sweep.findings.filter((finding) => HEADER_CODES.has(finding.code));
  const refused = new Set(headerFindings.map((finding) => finding.path));
  const epics = entries.filter((entry) => typeof entry.text === 'string' && entry.name.endsWith(MARKDOWN)
    && !refused.has(`${EPICS_REL}/${entry.name}`) && declaresEpic(entry.text));
  const siblingStates = headerFindings.filter((finding) => finding.code !== 'sibling-read');
  return { entries, epics, headerFindings, skipped: sweep.counts.skipped, blocked: false,
    states: [...states, ...siblingStates.map((finding) => ({ finding }))] };
};

const judgeEpic = (entries, entry) => {
  const path = `${EPICS_REL}/${entry.name}`;
  const others = entries.filter((other) => other.name !== entry.name);
  const shape = checkEpic(entry.text, path);
  const sweep = sweepSiblings(others, EPICS_REL);
  const claims = shape.findings.length === 0 && sweep.ok ? checkClaims([shape.epic, ...sweep.epics]) : { findings: [] };
  const findings = [...shape.findings, ...sweep.findings, ...claims.findings];
  return { path, others, epic: shape.epic, accepted: !findings.some((finding) => finding.severity !== INFO) };
};

const planOf = (text) => linesOf(text).map((line) => PLAN_FIELD.exec(line)?.[1]).find(Boolean) ?? null;
const planShape = (row, epicId) => `The shape: the title # Plan: and a name; the five headings; under Goal and boundary the line Story: ${row.id} of ${epicId} and a governing spec path under docs/ai/specs or the words not adopted; one ledger row per file in six fields (id, verb, path, responsibility, budget, anchor) — a create or modify row an anchor that resolves to one place and, with no declared source-size cap, the budget n/a, a delete row a dash (—) in budget and anchor; the total line last, its before figure the current lines of every deleted file and of every modify row with a numeric budget, so total: 0 → 0 lines when every row is a create or modify with the budget n/a; at least one - bullet under Verification.`;

// The Story line is read under Goal and boundary alone, as plan-shape reads it.
const storyOf = (text) => {
  const { document } = parseLedger(text);
  const goal = document.headings.find((heading) => heading.text === PLAN_HEADINGS[0]);
  const end = goal && document.headings.find((heading) => heading.index > goal.index && heading.level <= 2);
  const lines = goal ? document.lines.slice(goal.index + 1, end?.index).map((line, offset) => ({ text: line, line: goal.index + 2 + offset })) : [];
  return readStoryLine(lines);
};
const readPlan = (cwd, tools, path) => {
  const read = readText(cwd, path);
  if (read.text === undefined) return { path, text: null, story: null, failure: state(READERS.plans, path, read.cause) };
  try {
    const { story, findings } = storyOf(read.text);
    if (findings.length) return { path, text: read.text, story: null, failure: state(READERS.plan, path, findings[0].message, tools.planCheck(path)) };
    return { path, text: read.text, story, failure: null };
  } catch (error) {
    return { path, text: read.text, story: null, failure: state(READERS.plan, path, error.message, tools.planCheck(path)) };
  }
};

const readPlans = (cwd, tools) => {
  try {
    const listing = readPlanEntries(cwd);
    const names = plansInFlight(cwd, () => listing);
    const plans = names.map((name) => readPlan(cwd, tools, `${PLANS_REL}/${name}`));
    const briefs = listing.filter((entry) => entry.isFile() && entry.name.startsWith(TASK_PREFIX) && entry.name.endsWith(MARKDOWN))
      .map((entry) => {
        const path = `${PLANS_REL}/${entry.name}`;
        const read = readText(cwd, path);
        return { path, name: entry.name, text: read.text ?? '', cause: read.cause ?? null, plan: planOf(read.text ?? ''),
          number: Number(TASK_NUMBER.exec(entry.name)?.[1] ?? 1) };
      });
    return { ok: true, plans, briefs, states: plans.filter((plan) => plan.failure).map((plan) => plan.failure) };
  } catch (error) {
    return { ok: false, state: state(READERS.entries, PLANS_REL, error.message) };
  }
};

const readBinding = (brief) => {
  if (brief.cause) return { refused: brief.cause };
  const parsed = parseBrief(brief.text);
  if (!parsed.ok) return { refused: parsed.reason };
  if (parsed.unclosed || parsed.blocks.length > 1) return { refused: 'binding: the block count is not one closed block', binding: true };
  if (parsed.blocks.length === 0) return { parsed, bound: false };
  const value = (() => { try { return JSON.parse(parsed.blocks[0].source); } catch { return null; } })();
  const isOid = (field) => typeof field === 'string' && OID.test(field);
  if (!isOid(value?.checkpoint) || !isOid(value?.head)) return { refused: 'binding: the block carries no checkpoint and head', binding: true };
  return { parsed, bound: true, checkpoint: value.checkpoint, head: value.head };
};

const judgeStory = (context, epicPath, epicId, row) => {
  const { cwd, tools, plans } = context;
  const own = plans.plans.filter((plan) => plan.story?.id === row.id && plan.story?.epic === epicId);
  const stateOf = (stage, actions, extra = {}) => ({ story: { id: row.id, plan: extra.plan ?? null, stage, residual: extra.residual ?? [], actions } });
  if (own.length > 1) return { state: state(READERS.plans, own[0].path, `story ${row.id} of ${epicId} has ${own.length} plans: ${own.map((plan) => plan.path).join(', ')}`) };
  if (own.length === 0) {
    if (plans.states.length) return {};
    const stem = `${epicId}-${row.id}`;
    const standIn = `${PLANS_REL}/${stem}${MARKDOWN}`;
    if (!PLAN_STEM.test(stem) || isScratchPlanName(`${stem}${MARKDOWN}`)) {
      return stateOf('S1', [tools.review(epicPath), action('write', `author the plan by hand under ${PLANS_REL} at a name of ASCII letters, digits, dashes and underscores with no EXECUTE-, FEEDBACK- or TASK- prefix and no PROMPT, prompt or handoff, since the epic id and story id make no such name. ${planShape(row, epicId)}`)]);
    }
    if (isPresent(cwd, standIn)) return { state: state(READERS.plans, standIn, `the plan stand-in path is taken by a file carrying no Story line ${row.id} of ${epicId} under Goal and boundary: move the line there, or rename or remove the file`) };
    return stateOf('S1', [tools.review(epicPath), action('write', `author the plan by hand at ${standIn}. ${planShape(row, epicId)}`)]);
  }
  const plan = own[0];
  try {
    return judgePlan(context, epicPath, row, plan, stateOf);
  } catch (error) {
    return { state: state(READERS.plan, plan.path, error.message, tools.planCheck(plan.path)) };
  }
};

const judgePlan = (context, epicPath, row, plan, stateOf) => {
  const { cwd, env, tools, plans, head, today } = context;
  const stem = posix.basename(plan.path, MARKDOWN);
  const standIn = (number) => `${PLANS_REL}/${TASK_PREFIX}${stem}-T${number}${MARKDOWN}`;
  const taken = plans.briefs.find((brief) => brief.plan !== null && brief.plan !== plan.path && brief.path === standIn(brief.number));
  if (taken) return { state: state(READERS.brief, taken.path, `the brief stand-in path is taken by a brief of ${taken.plan}: rename or remove it`) };
  const briefs = plans.briefs.filter((brief) => brief.plan === plan.path || (brief.plan === null && brief.path === standIn(brief.number)));
  const judged = briefs.map((brief) => ({ ...brief, ...readBinding(brief) }));
  const refusedBrief = judged.find((brief) => brief.refused);
  if (refusedBrief) return { state: state(READERS.brief, refusedBrief.path, refusedBrief.refused,
    refusedBrief.binding ? tools.check(refusedBrief.path) : tools.stamp(refusedBrief.path)) };
  const top = Math.max(0, ...judged.map((brief) => brief.number));
  const inHandAll = judged.filter((brief) => brief.number === top);
  if (inHandAll.length > 1) return { state: state(READERS.brief, inHandAll[0].path, `briefs ${inHandAll.map((brief) => brief.path).join(', ')} carry one task number`) };
  const inHand = inHandAll[0];
  const rows = parseLedger(plan.text).rows.filter((ledgerRow) => ledgerRow.valid);
  const briefed = new Set(judged.map((brief) => brief.parsed.rowId));
  const unbriefed = rows.find((ledgerRow) => !briefed.has(ledgerRow.id));
  const residual = judged.filter((brief) => brief.bound).flatMap((brief) => findSpans(brief.path, brief.text));
  const extra = { plan: plan.path, residual };
  const newest = newestCheckpoint(cwd, plan.path, { env });
  const noHead = () => ({ state: state(READERS.head, null, 'HEAD is unborn: no commit to compare the brief with') });
  const copyAction = (ledgerRow, number) => (ledgerRow && TEMPLATE_VERBS.has(ledgerRow.verb) && !isSweep(ledgerRow.path) && posix.basename(ledgerRow.path) !== PIN_FILE
    ? [tools.copy(TASK_TEMPLATE, standIn(number), `copy the task template to ${standIn(number)}`),
      action('write', `fill every key of the brief template's closed list in ${standIn(number)}, Row: ${ledgerRow.id}`), tools.stamp(standIn(number))]
    : [action('write', `write the brief of row ${ledgerRow?.id ?? 'none'} by hand at ${standIn(number)} per the brief grammar (checkpoint, task-brief); the task template does not fit it`), tools.stamp(standIn(number))]);
  if (!newest.ok && !String(newest.reason).startsWith(NO_CHECKPOINT)) return { state: state(READERS.sequence, plan.path, newest.reason) };
  if (!newest.ok) {
    if (!judged.some((brief) => brief.bound)) {
      const paths = rows.flatMap((ledgerRow) => [ledgerRow.path, ledgerRow.anchorPath].filter(Boolean));
      const result = checkPlan(plan.text, buildFacts(cwd, { paths, repo: openRepo(cwd) }));
      if (result.findings.length) return { state: state(READERS.plan, plan.path, result.findings[0].message, tools.planCheck(plan.path)) };
      return stateOf('S2', [tools.planCheck(plan.path), tools.mint(plan.path)], extra);
    }
    if (head.oid === null) return noHead();
    if (!unbriefed && inHand.bound && inHand.head !== head.oid) {
      return stateOf('S8', [action('write', `edit the story row ${row.id} of ${epicPath} to read state: landed ${today}`)], extra);
    }
    return { state: state(READERS.sequence, plan.path, 'the sequence was pruned before the story was done', tools.mint(plan.path)) };
  }
  if (!inHand) return stateOf('S3', copyAction(rows[0], 1), extra);
  if (!inHand.bound) return stateOf('S4', [tools.stamp(inHand.path)], extra);
  if (head.oid === null) return noHead();
  if (inHand.head !== head.oid) {
    return stateOf('S7', unbriefed ? [tools.mint(plan.path), ...copyAction(unbriefed, top + 1)]
      : [tools.planVerify(plan.path), tools.prune(plan.path)], extra);
  }
  if (inHand.checkpoint !== newest.oid) return stateOf('S5', [tools.stamp(inHand.path)], extra);
  const files = inHand.parsed.files.map((file) => file.path);
  return stateOf('S6', [tools.check(inHand.path),
    action('write', `bring the Files of ${inHand.path} to the row's post-state, the test first, until every Acceptance line is green`),
    ...inHand.parsed.acceptance.map(([command]) => lineOf('run', 'run the Acceptance command of the brief', [command])),
    tools.reviewState(),
    lineOf('run', 'stage the Files of the brief', ['git', '--literal-pathspecs', 'add', '--', ...files.map(q)]),
    lineOf('run', 'commit the Files of the brief', ['git', 'commit', '-m', q(inHand.parsed.title)])], extra);
};

const cleanupOf = (context, epicId, rows) => context.plans.plans
  .filter((plan) => plan.story?.epic === epicId && rows.some((row) => row.id === plan.story.id && row.state === LANDED))
  .flatMap((plan) => {
    const newest = newestCheckpoint(context.cwd, plan.path, { env: context.env });
    const prune = !newest.ok && String(newest.reason).startsWith(NO_CHECKPOINT) ? [] : [context.tools.prune(plan.path)];
    return [...prune, action('write', `remove the plan ${plan.path} and its briefs: the Cleanup of a landed story`)];
  });

const judgeEntry = (context, store, entry) => {
  const judged = judgeEpic(store.entries, entry);
  const { tools } = context;
  const id = posix.basename(judged.path, MARKDOWN);
  const base = { stage: 'E2', id, path: judged.path, cause: null, fact: null, residual: [], actions: [tools.epicCheck(judged.path)], stories: [] };
  if (!judged.accepted) return { entry: base, states: [] };
  const { epic } = judged;
  const residual = findSpans(judged.path, entry.text);
  const accepted = { ...base, residual };
  if (epic.fields.state === LANDED) return { entry: { ...accepted, stage: 'E5', actions: cleanupOf(context, id, epic.rows) }, states: [] };
  const landed = new Set(epic.rows.filter((row) => row.state === LANDED).map((row) => row.id));
  const inHand = epic.rows.filter((row) => row.state !== LANDED && row.dependsOn.every((dependency) => landed.has(dependency)));
  if (inHand.length === 0) {
    const queueRead = readRegularFileNoFollow(resolve(context.cwd, QUEUE_PATH));
    const queue = queueRead.outcome === 'ok' ? queueRead.content : { outcome: queueRead.outcome, reason: queueRead.code ?? queueRead.className };
    const closed = judgeClose({ epic: entry.text, path: judged.path, queue, entries: judged.others });
    const edits = closed.findings.filter((finding) => finding.severity !== INFO).map((finding) => (finding.code === 'close-result'
      ? action('write', `add the line Result line: ${context.today} under ## Acceptance of ${judged.path}`)
      : action('write', finding.code === 'close-queue' ? `delete the queue row: ${stripPath(finding)}` : stripPath(finding))));
    return { entry: { ...accepted, stage: 'E4', actions: [...edits, tools.close(judged.path), ...cleanupOf(context, id, epic.rows)] }, states: [] };
  }
  const stories = inHand.map((row) => judgeStory(context, judged.path, id, row));
  return { entry: { ...accepted, stage: 'E3', fact: tools.epicCheck(judged.path, 'fact'), actions: cleanupOf(context, id, epic.rows),
    stories: stories.filter((story) => story.story).map((story) => story.story) }, states: stories.filter((story) => story.state).map((story) => story.state) };
};

const judgeFirstEpic = (context, store) => {
  const standIn = `${EPICS_REL}/${STAND_IN_EPIC}${MARKDOWN}`;
  if (isPresent(context.cwd, standIn)) return { states: [state(READERS.store, standIn, 'the epic stand-in path is taken by a file that is not an epic: rename or remove it')], entries: [] };
  return { states: [], entries: [{ stage: 'E1', id: null, path: null, cause: E1_CAUSE, fact: null, residual: [], actions: [
    action('write', `create the epic store directory ${EPICS_REL}`, `mkdir -p ${EPICS_REL}`),
    context.tools.copy(EPIC_TEMPLATE, standIn, `copy the epic template to ${standIn}`),
    action('write', `fill every key of the epic template's closed list in ${standIn}; EPIC_ID is ${STAND_IN_EPIC}, the file stem`),
    context.tools.epicCheck(standIn)], stories: [] }] };
};

export const readTierFacts = ({ cwd, env, toolsDir, today }) => {
  const location = resolveGitLocation(cwd, { env });
  if (location.state !== WORK_TREE) return { location, states: [], entries: [], skipped: 0 };
  const store = readStore(cwd);
  const tools = makeTools(toolsDir);
  const firstEpic = store.epics[0] ? `${EPICS_REL}/${store.epics[0].name}` : null;
  const storeStates = store.states.map((item) => (item.finding
    ? state(READERS.sweep, item.finding.path, stripPath(item.finding), firstEpic ? tools.epicCheck(firstEpic) : null) : item));
  if (store.blocked) return { location, states: storeStates, entries: [], skipped: 0 };
  const plans = readPlans(cwd, tools);
  const head = readHead(cwd, env);
  const headStates = head.ok ? [] : [state(READERS.head, null, head.reason)];
  if (!plans.ok) return { location, states: [...storeStates, plans.state, ...headStates], entries: [], skipped: store.skipped };
  const context = { cwd, env, tools, plans, head: head.ok ? head : { oid: null }, today };
  if (store.epics.length === 0) {
    const first = store.headerFindings.length ? { states: [], entries: [] } : judgeFirstEpic(context, store);
    return { location, states: [...storeStates, ...plans.states, ...headStates, ...first.states], entries: first.entries, skipped: store.skipped };
  }
  const judged = store.epics.map((entry) => judgeEntry(context, store, entry));
  return { location, states: [...storeStates, ...plans.states, ...headStates, ...judged.flatMap((item) => item.states)],
    entries: judged.map((item) => item.entry), skipped: store.skipped };
};

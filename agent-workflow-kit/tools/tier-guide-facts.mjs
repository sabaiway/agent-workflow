// spec:tier-guide — docs/ai/specs/kit/tier/tier-guide/index.md and its part guide-stages.md
import { lstatSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { resolveGitLocation } from './git-env.mjs';
import { EPICS_REL, readEpicStore } from './epic-store.mjs';
import { checkEpic } from './epic-shape.mjs';
import { QUEUE_PATH, checkClaims, judgeClose, sweepSiblings } from './epic-shape-ledger.mjs';
import { PLANS_REL, isScratchPlanName, plansInFlight, readPlanEntries } from './plan-files.mjs';
import { readStoryLine } from './plan-shape-ownership.mjs';
import { PLAN_HEADINGS, isSweep, parseLedger } from './plan-shape.mjs';
import { expandSweepPaths } from './plan-shape-facts.mjs';
import { withRepository } from './checkpoint-core.mjs';
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
const PLAN_TITLE = /^# Plan: (.+)$/;
const DOCS_AI = 'docs/ai/';
const PROMPT_PREFIX = `${PLANS_REL}/EXECUTE-PROMPT-`;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEADER_CODES = new Set(['sibling-header', 'sibling-read']);
const HEAD_ARGS = ['rev-parse', '-q', '--verify', 'HEAD^{commit}'];
const INDEX_ARGS = ['diff-index', '--cached', '--quiet', 'HEAD', '--'];
const INDEX_EQUAL = 0;
const INDEX_DIFFERS = 1;
const STAND_IN_EPIC = 'NEW-EPIC';
const E1_CAUSE = `no epic file in ${EPICS_REL}`;
const EPIC_TEMPLATE = '../references/authoring/EPIC_TEMPLATE.md';
const TASK_TEMPLATE = '../references/authoring/TASK_TEMPLATE.md';
const READERS = Object.freeze({ store: 'readEpicStore', sweep: 'sweepSiblings', entries: 'readPlanEntries',
  plans: 'plansInFlight', ledger: 'parseLedger', story: 'readStoryLine', prompt: 'readRegularFileNoFollow',
  head: 'readGit', index: 'diff-index' });

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
    planCheck: (plan, text = `check the plan ${plan}`) => node('run', text, 'plan-shape-cli.mjs', '--check', q(plan)),
    planVerify: (plan) => node('run', `verify the plan ${plan} against the tree`, 'plan-shape-cli.mjs', '--verify', q(plan)),
    reviewState: () => node('run', 'check the review state of the tree: the commit gate', 'review-state.mjs', '--check'),
    diff: () => lineOf('run', 'read the staged diff: the diff review reads it, in the solo walk you read it yourself', ['git', 'diff', '--cached']),
    commit: (plan) => lineOf('run', `commit every staged change once, titled as the plan ${plan.path}`, ['git', 'commit', '-m', q(plan.title)]),
    stage: (row, expansion) => (isSweep(row.path)
      ? action('write', `stage every path the sweep row ${row.id} (${row.path}) expands to: ${expansion()}`)
      : lineOf('run', `stage the path of the row ${row.id}`, ['git', '--literal-pathspecs', 'add', '--', q(row.path)])),
    copy: (template, target, text) => lineOf('write', text, ['cp', q(resolve(toolsDir, template)), q(target)]),
  };
};
const state = (reader, file, cause, next = null) => ({ reader, file, cause: escapeForDisplay(cause), next });
const findSpans = (file, text) => [...text.matchAll(SPAN)].map(([, span]) => ({ file, span: escapeForDisplay(span) }));
const readText = (cwd, path) => {
  const result = readRegularFileNoFollow(resolve(cwd, path));
  return result.outcome === 'ok' ? { text: result.content }
    : { absent: result.outcome === 'absent', cause: `${result.outcome}: ${result.code ?? result.className ?? 'unreadable'}` };
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

const askGit = (cwd, env, args) => withRepository(cwd, { env }, (context) => {
  const result = context.run(args, context.top, undefined, context.env);
  return { status: result.error ? null : result.status, stdout: String(result.stdout ?? '').trim(),
    reason: String(result.stderr ?? '').trim() || (result.error?.message ?? `git ${args[0]} exited ${result.status}`) };
});
const readHead = (cwd, env) => {
  const answer = askGit(cwd, env, HEAD_ARGS);
  if (answer.status === 0 && OID.test(answer.stdout)) return { ok: true, oid: answer.stdout };
  if (answer.status === 1 && answer.stdout === '') return { ok: true, oid: null };
  return { ok: false, reason: answer.reason };
};

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

const planShape = (row, epicId) => `The shape: the title # Plan: and a name; the five headings; under Goal and boundary the line Story: ${row.id} of ${epicId} and a governing spec path under docs/ai/specs or the words not adopted; one ledger row per file in six fields (id, verb, path, responsibility, budget, anchor) — a create or modify row an anchor that resolves to one place and, with no declared source-size cap, the budget n/a, a delete row a dash (—) in budget and anchor; the total line last, its before figure the current lines of every deleted file and of every modify row with a numeric budget, so total: 0 → 0 lines when every row is a create or modify with the budget n/a; at least one - bullet under Verification.`;

// The Story line is read under Goal and boundary alone, as plan-shape reads it.
const storyOf = ({ document }) => {
  const goal = document.headings.find((heading) => heading.text === PLAN_HEADINGS[0]);
  const end = goal && document.headings.find((heading) => heading.index > goal.index && heading.level <= 2);
  const lines = goal ? document.lines.slice(goal.index + 1, end?.index).map((line, offset) => ({ text: line, line: goal.index + 2 + offset })) : [];
  return readStoryLine(lines);
};
// A plan's LEDGER ROWS are its valid rows outside docs/ai/, each with its prompt's canonical name.
const readPlan = (cwd, tools, path) => {
  const read = readText(cwd, path);
  if (read.text === undefined) return { path, story: null, failure: state(READERS.plans, path, read.cause) };
  const refused = (reader, cause) => ({ path, story: null, failure: state(reader, path, cause, tools.planCheck(path)) });
  try {
    const parsed = parseLedger(read.text);
    const { story, findings } = storyOf(parsed);
    if (findings.length) return refused(READERS.story, findings[0].message);
    const stem = posix.basename(path, MARKDOWN);
    const rows = parsed.rows.filter((row) => row.valid);
    const ledger = rows.filter((row) => !row.path.startsWith(DOCS_AI)).map((row) => ({ ...row, prompt: `${PROMPT_PREFIX}${stem}-${row.id}${MARKDOWN}` }));
    const title = linesOf(read.text).map((line) => PLAN_TITLE.exec(line)?.[1]).find(Boolean) ?? null;
    return { path, story, hasRow: rows.length > 0, ledger, title, failure: null };
  } catch (error) {
    return refused(READERS.ledger, error.message);
  }
};

const readPlans = (cwd, tools) => {
  try {
    const listing = readPlanEntries(cwd);
    const plans = plansInFlight(cwd, () => listing).map((name) => readPlan(cwd, tools, `${PLANS_REL}/${name}`));
    const owners = plans.flatMap((plan) => (plan.ledger ?? []).map((row) => ({ prompt: row.prompt, path: plan.path })));
    const shared = [...new Set(owners.map(({ prompt }) => prompt))]
      .map((prompt) => ({ prompt, paths: [...new Set(owners.filter((owner) => owner.prompt === prompt).map(({ path }) => path))] }))
      .filter(({ paths }) => paths.length > 1);
    const sharing = new Set(shared.flatMap(({ paths }) => paths));
    return { ok: true, plans: plans.map((plan) => ({ ...plan, shared: sharing.has(plan.path) })),
      states: plans.filter((plan) => plan.failure).map((plan) => plan.failure),
      shared: shared.map(({ prompt, paths }) => state(READERS.ledger, prompt, `the prompt name is derived by ${paths.join(', ')}: rename a row or a plan so every prompt has one name`)) };
  } catch (error) {
    return { ok: false, state: state(READERS.entries, PLANS_REL, error.message) };
  }
};

const judgeStory = (context, epicPath, epicId, row) => {
  const { cwd, tools, plans, today } = context;
  const own = plans.plans.filter((plan) => plan.story?.id === row.id && plan.story?.epic === epicId);
  const stateOf = (stage, actions, plan = null, residual = []) => ({ story: { id: row.id, plan, stage, residual, actions } });
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
  const [plan] = own;
  if (plan.shared) return {};
  if (!plan.hasRow) return { state: state(READERS.ledger, plan.path, 'the plan has no valid row in its Module ledger', tools.planCheck(plan.path, `add a ledger row to ${plan.path}, then check the plan`)) };
  const prompts = plan.ledger.map((ledgerRow) => ({ row: ledgerRow, ...readText(cwd, ledgerRow.prompt) }));
  const refused = prompts.find((prompt) => prompt.text === undefined && !prompt.absent);
  if (refused) return { state: state(READERS.prompt, refused.row.prompt, refused.cause) };
  const handed = ((gap) => (gap < 0 ? prompts.length : gap))(prompts.findIndex((prompt) => prompt.absent));
  const stray = prompts.slice(handed).filter((prompt) => !prompt.absent).map((prompt) => prompt.row);
  const next = plan.ledger[handed];
  if (stray.length) {
    return { state: state(READERS.prompt, stray[0].prompt, `row ${stray[0].id} has a prompt after row ${next.id}, which has none`,
      action('write', `remove the prompts after the first gap (${stray.map((ledgerRow) => ledgerRow.prompt).join(', ')}), then copy and fill the prompt of row ${next.id}`)) };
  }
  const residual = prompts.slice(0, handed).flatMap((prompt) => findSpans(prompt.row.prompt, prompt.text));
  const copyFill = (ledgerRow) => [tools.copy(TASK_TEMPLATE, ledgerRow.prompt, `copy the task template to ${ledgerRow.prompt}, the prompt of row ${ledgerRow.id}`),
    action('write', `fill every key of the task template's closed list in ${ledgerRow.prompt}; ROW_LINE is the row ${ledgerRow.id}, copied verbatim`)];
  const carry = (ledgerRow) => [
    action('write', `carry the row ${ledgerRow.id}: write its Files yourself in the solo walk, else hand ${ledgerRow.prompt} to the carrier task.execute resolves to, a bridge only for new tests or code and with the contract block the engine's The task names; a file you already wrote you lay down yourself`),
    action('run', `run every command under ## Run in ${ledgerRow.prompt}; the guide prints no line of a prompt`), tools.stage(ledgerRow, () => {
      try { return expandSweepPaths(cwd, [ledgerRow.path])[ledgerRow.path].join(', ') || 'no path on disk'; } catch (error) { return `not expanded (${error.message})`; }
    })];
  if (handed === 0 && next) return stateOf('S2', [tools.planCheck(plan.path), ...copyFill(next)], plan.path, residual);
  const last = handed > 0 ? carry(plan.ledger[handed - 1]) : [];
  if (next) return stateOf('S3', [...last, ...copyFill(next)], plan.path, residual);
  return stateOf('S4', [...last, tools.planVerify(plan.path), action('write', `edit the story row ${row.id} of ${epicPath} to read state: landed ${today} before the diff review, and stage it with the story's changes where git tracks ${EPICS_REL}`)], plan.path, residual);
};

const judgeEpic = (context, entries, entry) => {
  const path = `${EPICS_REL}/${entry.name}`;
  const id = posix.basename(path, MARKDOWN);
  const others = entries.filter((other) => other.name !== entry.name);
  const shape = checkEpic(entry.text, path);
  const sweep = sweepSiblings(others, EPICS_REL);
  const claims = shape.findings.length === 0 && sweep.ok ? checkClaims([shape.epic, ...sweep.epics]) : { findings: [] };
  const accepted = ![...shape.findings, ...sweep.findings, ...claims.findings].some((finding) => finding.severity !== INFO);
  // The leftover: the plans in flight naming a landed row, in ledger order.
  const leftover = accepted ? shape.epic.rows.filter((row) => row.state === LANDED)
    .flatMap((row) => context.plans.plans.filter((plan) => plan.story?.epic === id && plan.story.id === row.id)) : [];
  return { entry, path, id, others, epic: shape.epic, accepted, leftover };
};

const readIndex = (context, held) => {
  const paths = held.flatMap((judged) => judged.leftover.map((plan) => plan.path));
  if (context.head.oid === null) return { ok: false, state: state(READERS.head, paths[0], `HEAD is unborn: the index of the leftover of ${paths.join(', ')} has no commit to be read against`) };
  const answer = askGit(context.cwd, context.env, INDEX_ARGS);
  if (answer.status !== INDEX_EQUAL && answer.status !== INDEX_DIFFERS) return { ok: false, state: state(READERS.index, paths[0], answer.reason) };
  if (answer.status === INDEX_DIFFERS && held.length > 1) {
    return { ok: false, state: state(READERS.index, paths[0], `the index differs from HEAD while ${held.length} epics have a landed plan in flight (${paths.join(', ')}): one commit cannot keep their stories apart`) };
  }
  return { ok: true, differs: answer.status === INDEX_DIFFERS };
};

const leftoverActions = (context, plans) => {
  if (!context.index.ok || plans.some((plan) => plan.shared)) return [];
  const removals = plans.map((plan) => {
    const prompts = plan.ledger.map((row) => row.prompt).filter((prompt) => isPresent(context.cwd, prompt));
    return action('write', `remove the plan ${plan.path} and its prompts (${prompts.length ? prompts.join(', ') : 'none on disk'}): the Cleanup of a landed story`);
  });
  if (!context.index.differs) return removals;
  const { tools } = context;
  const commit = plans[0].title === null ? action('write', `commit every staged change once: the plan ${plans[0].path} carries no # Plan: title to name it`) : tools.commit(plans[0]);
  return [tools.diff(), tools.reviewState(), commit, ...removals];
};

const closeActions = (context, judged) => {
  const queueRead = readRegularFileNoFollow(resolve(context.cwd, QUEUE_PATH));
  const queue = queueRead.outcome === 'ok' ? queueRead.content : { outcome: queueRead.outcome, reason: queueRead.code ?? queueRead.className };
  const closed = judgeClose({ epic: judged.entry.text, path: judged.path, queue, entries: judged.others });
  const edits = closed.findings.filter((finding) => finding.severity !== INFO).map((finding) => (finding.code === 'close-result'
    ? action('write', `add the line Result line: ${context.today} under ## Acceptance of ${judged.path}`)
    : action('write', finding.code === 'close-queue' ? `delete the queue row: ${stripPath(finding)}` : stripPath(finding))));
  return [...edits, context.tools.close(judged.path),
    action('write', `commit the close's edits (the header, the Result line, the queue row) where git tracks them: the epic's own change after its last story's commit`)];
};

const judgeEntry = (context, judged) => {
  const { tools } = context;
  const { path, id, epic } = judged;
  const base = { stage: 'E2', id, path, cause: null, fact: null, residual: [], actions: [tools.epicCheck(path)], stories: [] };
  if (!judged.accepted) return { entry: base, states: [] };
  const accepted = { ...base, residual: findSpans(path, judged.entry.text) };
  const leftover = judged.leftover.length ? leftoverActions(context, judged.leftover) : null;
  if (epic.fields.state === LANDED) return { entry: { ...accepted, stage: 'E5', actions: leftover ?? [] }, states: [] };
  const landed = new Set(epic.rows.filter((row) => row.state === LANDED).map((row) => row.id));
  const inHand = epic.rows.filter((row) => row.state !== LANDED && row.dependsOn.every((dependency) => landed.has(dependency)));
  if (inHand.length === 0) return { entry: { ...accepted, stage: 'E4', actions: leftover ?? (context.index === null ? closeActions(context, judged) : []) }, states: [] };
  const held = { ...accepted, stage: 'E3', fact: tools.epicCheck(path, 'fact'), actions: leftover ?? [] };
  if (context.index !== null) return { entry: held, states: [] };
  const stories = inHand.map((row) => judgeStory(context, path, id, row));
  return { entry: { ...held, stories: stories.filter((story) => story.story).map((story) => story.story) },
    states: stories.filter((story) => story.state).map((story) => story.state) };
};

const judgeFirstEpic = (context) => {
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
  const planStates = [...storeStates, ...plans.states, ...plans.shared, ...headStates];
  if (!head.ok) return { location, states: planStates, entries: [], skipped: store.skipped };
  const context = { cwd, env, tools, plans, head, today, index: null };
  if (store.epics.length === 0) {
    const first = store.headerFindings.length ? { states: [], entries: [] } : judgeFirstEpic(context);
    return { location, states: [...planStates, ...first.states], entries: first.entries, skipped: store.skipped };
  }
  const judged = store.epics.map((entry) => judgeEpic(context, store.entries, entry));
  const held = judged.filter((item) => item.leftover.length);
  const index = held.length ? readIndex(context, held) : null;
  const rendered = judged.map((item) => judgeEntry({ ...context, index }, item));
  return { location, states: [...planStates, ...(index?.state ? [index.state] : []), ...rendered.flatMap((item) => item.states)],
    entries: rendered.map((item) => item.entry), skipped: store.skipped };
};

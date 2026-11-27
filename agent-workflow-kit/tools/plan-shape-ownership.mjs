import { posix } from 'node:path';
import { hasPathOverlap } from './claim-relation.mjs';

const STORY_LINE = /^Story: (S[1-9]\d*) of ([^\s/]+)$/;
const STORY_FIELDS = 'stories';
export const PIN_FILE = 'package-content.test.mjs';
const MARKDOWN_SUFFIX = '.md';
const FIRST_LINE = 1;
const LANDED = 'landed';
const OWNS = 'owns';
const SHARED = 'shared';
const STRING_TYPE = 'string';
export const PIN_VERBS = new Set(['create', 'delete']);
const CODES = Object.freeze({ line: 'story-line', store: 'story-store', landed: 'story-epic-landed',
  unknown: 'story-unknown', owns: 'story-owns', shared: 'story-shared', scope: 'story-scope' });
const ONE_STORY = 'the plan names its story with one line';
const NAME_STORY = 'name the story that carries the file';
const ORDER_STORIES = 'declare a transitive depends-on order between the stories';
const NARROW_CLAIM = 'narrow the claim if the story does not need the path';
const makeFinding = (line, code, message, rowId = null) => ({ line, code, message, rowId });
const sortFindings = (findings, story = null) => ({ findings: findings.sort((left, right) => left.line - right.line), story });
export const getStoryIdentity = (record) => record ? { epic: posix.basename(record.path, MARKDOWN_SUFFIX), id: record.id } : null;
const hasIdentity = (record, identity) => Boolean(identity && record.id === identity.id && getStoryIdentity(record).epic === identity.epic);
const getStoryName = (record) => `${getStoryIdentity(record).epic} ${record.id}`;
const getWaitStep = (plan) => `wait for ${plan.identity}'s Cleanup`;
const hasSharedExemption = (own, other) => Boolean(own && other &&
  (other.path !== own.path || own.reachable.has(other.id) || other.reachable.has(own.id)));
const hasClaimCover = (claim, path) => claim.ground.some((ground) => hasPathOverlap(path, ground));
const hasOwnCover = (own, path) => own.claims.some((claim) => hasClaimCover(claim, posix.normalize(path)));

export const readStoryLine = (lines) => {
  const [story = null, second] = lines.flatMap(({ text, line }) => {
    const match = STORY_LINE.exec(text.trim());
    if (!match) return [];
    const [, id, epic] = match;
    return [{ id, epic, line }];
  });
  return { story, findings: second ? [makeFinding(second.line, CODES.line, ONE_STORY)] : [] };
};

const findOwnStory = (story, facts) => {
  if (!story) return { own: null, findings: [] };
  const epics = facts.stories.filter((record) => getStoryIdentity(record).epic === story.epic);
  const own = epics.find((record) => record.id === story.id) ?? null;
  if (facts.landedEpics?.includes(story.epic)) {
    return { own: null, findings: [makeFinding(story.line, CODES.landed, `${story.epic} is landed; name a story of an open epic`)] };
  }
  if (!own) {
    const name = epics.length ? `${story.epic} ${story.id}` : story.epic;
    return { own: null, findings: [makeFinding(story.line, CODES.unknown, `${name} is unknown; name a story present in an open epic`)] };
  }
  return { own, findings: [] };
};

const checkCollision = (row, path, record, claim, own, plan) => {
  if (!hasClaimCover(claim, posix.normalize(path))) return [];
  const message = `${row.id} path ${path} overlaps ${record.path} ${record.id} ${claim.field} ${claim.path}; ${getWaitStep(plan)}, or `;
  if (claim.field === OWNS) return [makeFinding(row.line, CODES.owns,
    `${message}carry the change in ${getStoryName(record)} (revise its plan; the yes is asked again)`, row.id)];
  if (claim.field !== SHARED || hasSharedExemption(own, record)) return [];
  return [makeFinding(row.line, CODES.shared, `${message}${own ? ORDER_STORIES : NAME_STORY}`, row.id)];
};

const checkClaimStart = (own, claim, plan, other) => {
  if (claim.field === SHARED && hasSharedExemption(own, other)) return [];
  const orderStep = claim.field === SHARED && other?.path === own.path ? `, or ${ORDER_STORIES}` : '';
  return plan.paths.filter((path) => hasClaimCover(claim, posix.normalize(path))).map((path) => ({
    plan: plan.identity,
    message: `${getStoryName(own)} ${claim.field} ${claim.path} meets ${plan.identity} path ${path}; ${getWaitStep(plan)}, or ${NARROW_CLAIM}${orderStep}`,
  }));
};

export const checkStoryStart = ({ own, otherPlans, stories = [], sameStoryOnly = false }) => {
  if (!own || !otherPlans) return { waits: [] };
  const waits = otherPlans.filter(({ held }) => held).flatMap((plan) => {
    if (hasIdentity(own, plan.story)) return [{
      plan: plan.identity,
      message: `${getStoryName(own)} is held by ${plan.identity}; carry the change in ${plan.identity} (revise it; the yes is asked again)`,
    }];
    if (sameStoryOnly) return [];
    const other = stories.find((record) => hasIdentity(record, plan.story));
    return own.claims.flatMap((claim) => checkClaimStart(own, claim, plan, other));
  });
  return { waits };
};

const hasPinCover = (path, rows, facts, own) => posix.basename(path) === PIN_FILE && rows.some((row) => {
  const fact = facts.pathFacts?.[row.path];
  return PIN_VERBS.has(row.verb) && fact?.shipped === true && fact.pinTest === path && hasOwnCover(own, row.path);
});
const checkScope = (row, path, rows, facts, own) => {
  if (!own || facts.pathFacts?.[path]?.inScope !== true || hasOwnCover(own, path) || hasPinCover(path, rows, facts, own)) return [];
  return [makeFinding(row.line, CODES.scope,
    `${row.id} path ${path} is in the declared practice and no claim of ${own.id} covers it; claim the path in ${getStoryName(own)}'s row`, row.id)];
};

export const checkStoryOwnership = ({ rows, goalLines, facts, getConcretePaths }) => {
  const { story, findings } = readStoryLine(goalLines);
  if (!Object.hasOwn(facts, STORY_FIELDS)) return { findings, story: null };
  if (typeof facts.storeRefusal === STRING_TYPE) {
    return sortFindings([...findings, makeFinding(FIRST_LINE, CODES.store, facts.storeRefusal)]);
  }
  const resolved = findOwnStory(story, facts);
  const own = resolved.own;
  const others = (facts.otherPlans ?? []).filter(({ held }) => held).flatMap((plan) => facts.stories
    .filter((record) => record.state !== LANDED && hasIdentity(record, plan.story) && (!own || !hasIdentity(own, plan.story)))
    .map((record) => ({ record, plan })));
  const validRows = rows.filter((row) => row.valid);
  const relation = validRows.flatMap((row) => getConcretePaths(row, facts).flatMap((path) => [
    ...others.flatMap(({ record, plan }) => record.claims.flatMap((claim) => checkCollision(row, path, record, claim, own, plan))),
    ...checkScope(row, path, validRows, facts, own),
  ]));
  return sortFindings([...findings, ...resolved.findings, ...relation], own);
};

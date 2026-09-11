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
const makeFinding = (line, code, message, rowId = null) => ({ line, code, message, rowId });
const sortFindings = (findings) => ({ findings: findings.sort((left, right) => left.line - right.line) });
const hasIdentity = (left, right) => left.path === right.path && left.id === right.id;
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
  const epics = facts.stories.filter((record) => posix.basename(record.path, MARKDOWN_SUFFIX) === story.epic);
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

const checkCollision = (row, path, record, claim, own) => {
  if (!hasClaimCover(claim, posix.normalize(path))) return [];
  const message = `${row.id} path ${path} overlaps ${record.path} ${record.id} ${claim.field} ${claim.path}`;
  if (claim.field === OWNS) return [makeFinding(row.line, CODES.owns, message, row.id)];
  if (claim.field !== SHARED) return [];
  if (own && (record.path !== own.path || own.reachable.has(record.id) || record.reachable.has(own.id))) return [];
  return [makeFinding(row.line, CODES.shared, `${message}; ${own ? ORDER_STORIES : NAME_STORY}`, row.id)];
};

const hasPinCover = (path, rows, facts, own) => posix.basename(path) === PIN_FILE && rows.some((row) => {
  const fact = facts.pathFacts?.[row.path];
  return PIN_VERBS.has(row.verb) && fact?.shipped === true && fact.pinTest === path && hasOwnCover(own, row.path);
});
const checkScope = (row, path, rows, facts, own) => {
  if (!own || facts.pathFacts?.[path]?.inScope !== true || hasOwnCover(own, path) || hasPinCover(path, rows, facts, own)) return [];
  return [makeFinding(row.line, CODES.scope,
    `${row.id} path ${path} is in the declared practice and no claim of ${own.id} covers it`, row.id)];
};

export const checkStoryOwnership = ({ rows, goalLines, facts, getConcretePaths }) => {
  const { story, findings } = readStoryLine(goalLines);
  if (!Object.hasOwn(facts, STORY_FIELDS)) return { findings };
  if (typeof facts.storeRefusal === STRING_TYPE) {
    return sortFindings([...findings, makeFinding(FIRST_LINE, CODES.store, facts.storeRefusal)]);
  }
  const resolved = findOwnStory(story, facts);
  const own = resolved.own;
  const others = facts.stories.filter((record) => record.state !== LANDED && (!own || !hasIdentity(record, own)));
  const validRows = rows.filter((row) => row.valid);
  const relation = validRows.flatMap((row) => getConcretePaths(row, facts).flatMap((path) => [
    ...others.flatMap((record) => record.claims.flatMap((claim) => checkCollision(row, path, record, claim, own))),
    ...checkScope(row, path, validRows, facts, own),
  ]));
  return sortFindings([...findings, ...resolved.findings, ...relation]);
};

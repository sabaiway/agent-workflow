const OPEN = 'open';
const CLAIM_FIELDS = Object.freeze(['owns', 'shared']);
const TRAILING_SLASH = /\/$/;
const SOURCE_EXTENSION = /^(.*[^/])(\.[^./]+)$/;
const TEST_FILE = /\.test\.[^/]+$/;
const TEST_SUFFIX = '.test';

export const unique = (items) => [...new Set(items)];

export const expandClaim = (path) => {
  const source = SOURCE_EXTENSION.exec(path);
  return source && !TEST_FILE.test(path)
    ? [path, `${source[1]}${TEST_SUFFIX}${source[2]}`, `${source[1]}${TEST_SUFFIX}/`] : [path];
};
export const hasPathOverlap = (left, right) => {
  const a = left.replace(TRAILING_SLASH, '');
  const b = right.replace(TRAILING_SLASH, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
export const findReachable = (graph, pending, visited = new Set()) => {
  const unseen = unique(pending.filter((id) => !visited.has(id)));
  if (unseen.length === 0) return visited;
  return findReachable(graph, unseen.flatMap((id) => graph.get(id) ?? []), new Set([...visited, ...unseen]));
};
const getClaims = (row) => CLAIM_FIELDS.flatMap((field) => row[field].map((path) => ({ field, path, ground: expandClaim(path) })));

export const listStories = (epics) => epics.filter((epic) => epic.state === OPEN).flatMap((epic) => {
  const graph = new Map(epic.rows.map((row) => [row.id, row.dependsOn]));
  return epic.rows.filter((row) => row.valid).map((row) => ({
    path: epic.path, id: row.id, line: row.line, state: row.state,
    claims: getClaims(row), reachable: findReachable(graph, row.dependsOn),
  }));
});

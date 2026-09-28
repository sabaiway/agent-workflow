// mount-masks.mjs — the mount-table judge of the sandbox-masks lane (spec kit/review-domain/sandbox-masks).
// A pure read-only leaf: it parses /proc/self/mountinfo TEXT (the caller reads it) and answers which
// work-tree paths are FOREIGN mount targets — the second arm of the mask predicate beside the lstat
// class. Library-only: no import effect, no direct-run dispatch.

import { realpathSync } from 'node:fs';

const ESCAPES = new Map([['\\040', ' '], ['\\011', '\t'], ['\\012', '\n'], ['\\134', '\\']]);

const malformed = (why) => new Error(`malformed mountinfo: ${why}`);

// Root and mount point decode the kernel's four octal escapes; any other backslash sequence is malformed.
const decode = (field, lineNo) => field.replace(/\\.{0,3}/gs, (seq) => {
  if (ESCAPES.has(seq)) return ESCAPES.get(seq);
  throw malformed(`line ${lineNo} carries the backslash sequence ${JSON.stringify(seq)}`);
});

// One entry per line: split on SINGLE spaces (an empty field is a field); nothing after the source is read.
const parseLine = (line, lineNo) => {
  const fields = line.split(' ');
  const dash = fields.indexOf('-');
  if (dash === -1) throw malformed(`line ${lineNo} has no - field`);
  if (dash < 6) throw malformed(`line ${lineNo} has fewer than six fields before the - field`);
  if (fields.length - dash - 1 < 2) throw malformed(`line ${lineNo} has fewer than two fields after the - field`);
  const [id, parent, dev, root, point] = fields;
  return { id, parent, dev, root: decode(root, lineNo), point: decode(point, lineNo) };
};

const parseTable = (text) => {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // the empty tail after the last newline is not a line
  return lines.map((line, i) => parseLine(line, i + 1));
};

const parentPath = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
const below = (path, point) => (point === '/' ? path : path.slice(point.length));
const joinRoot = (root, rest) => (rest === '' ? root : root === '/' ? rest : `${root}${rest}`);

// The judge follows PARENT IDS, never list order, and resolves visibility from the root mount down.
const buildJudge = (entries) => {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const atPoint = new Map();
  for (const e of entries) atPoint.set(e.point, [...(atPoint.get(e.point) ?? []), e]);
  const roots = (atPoint.get('/') ?? []).filter((e) => e.parent === e.id || !byId.has(e.parent));
  if (roots.length !== 1) throw malformed(`${roots.length} root mounts at / (exactly one entry at / has an unlisted or its own parent)`);
  const rootMount = roots[0];
  // The BASE of an entry at P: follow parent ids down through the entries at P.
  const baseOf = (entry, point) => {
    const seen = new Set();
    let cur = entry;
    while (cur.point === point && cur !== rootMount) {
      if (seen.has(cur.id)) throw malformed(`a parent cycle at ${point}`);
      seen.add(cur.id);
      const next = byId.get(cur.parent);
      if (next == null) throw malformed(`parent id ${cur.parent} of mount ${cur.id} is not listed`);
      cur = next;
    }
    return cur;
  };
  const memo = new Map();
  // → { visible, served }: the visible entry serving the path (itself or an ancestor's) and, when
  // the path has its own visible entry, the H it sits on.
  const serve = (point) => {
    if (memo.has(point)) return memo.get(point);
    let ancestor = point === '/' ? null : parentPath(point);
    while (ancestor != null && !atPoint.has(ancestor)) ancestor = parentPath(ancestor);
    const H = ancestor == null ? rootMount : serve(ancestor).visible;
    const here = atPoint.get(point);
    const named = new Set(here.filter((e) => e.parent !== e.id).map((e) => e.parent));
    const tops = here.filter((e) => !named.has(e.id) && baseOf(e, point) === H);
    if (tops.length > 1) throw malformed(`${tops.length} tops over one base at ${point}`);
    const answer = tops.length === 1 ? { visible: tops[0], H, own: true } : { visible: H, H, own: false };
    memo.set(point, answer);
    return answer;
  };
  return { atPoint, serve };
};

// A SELF bind shares H's device and names H's root joined with P's path below H's mount point.
const isSelfBind = (M, H, point) => M.dev === H.dev && joinRoot(H.root, below(point, H.point)) === M.root;

// foreignMountTargets(root, text) → Set of work-tree-relative paths ('/'-separated) whose visible
// mount is FOREIGN. Only an EXACT mount target strictly below the realpath of `root` counts; a path
// whose entries are all hidden layers is left to lstat. A malformed table throws.
export const foreignMountTargets = (root, text) => {
  const top = realpathSync(root);
  const { atPoint, serve } = buildJudge(parseTable(text));
  serve('/');
  const foreign = new Set();
  for (const point of atPoint.keys()) {
    if (!point.startsWith(`${top}/`)) continue;
    const { visible, H, own } = serve(point);
    if (own && !isSelfBind(visible, H, point)) foreign.add(point.slice(top.length + 1));
  }
  return foreign;
};

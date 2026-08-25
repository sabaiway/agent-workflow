// spec-check.mjs — the structural checker of the feature-spec layer (spec layer 2b), ADVISORY.
//
// It answers ONE question per document: given what the session says it changed, does the store on
// disk say the same thing? The change source is EXPLICIT (parsed ops, never git), and "well-formed"
// has no second definition here — every per-document verdict is RELAYED from the ONE reader
// (references/scripts/spec-schema.mjs) and its 2a `structure` extraction. This module adds only what
// text alone cannot decide: does the post-state on disk match the declared op, is the document
// listed by its parent, does its scenario marker really occur once in the file it names, and — under
// --all — the five invariants that span documents.
//
// Two lanes:
//   session   the closure of the declared ops (targets + their listing parents), judged per document.
//   --all     every document under the store, plus: unlisted child (DISTINCT from orphan),
//             acyclicity, store-wide slug uniqueness, module overlap. An ABSENT store root refuses.
//
// FAIL-CLOSED before every read. Containment is judged lexically AND by realpath over each
// path-bearing field, and the parents of a leaf are judged BEFORE the leaf is opened. The LEAF read
// itself is descriptor-bound and no-follow (the CLI half passes fs-read-nofollow.mjs in), so a
// pathname swapped after the probe cannot change the bytes judged. A mid-run PARENT swap is a
// STATED non-goal: this is an advisory checker, not a custody mechanism.
//
// No IO of its own: { read, probe, realpath, list } are injected. Dependency-free, Node >= 22.

import { dirname as pathDirname, isAbsolute, relative, sep } from 'node:path';
import { SPEC_SCHEMA, readSpecDocument, classifyPath } from '../references/scripts/spec-schema.mjs';
import { SPEC_OPS_GRAMMAR, buildClosure, listingParentOf, slugOf } from './spec-check-ops.mjs';

const STORE = SPEC_OPS_GRAMMAR.storePrefix;
const NAV = SPEC_OPS_GRAMMAR.navigator;
const STORE_ROOT = SPEC_OPS_GRAMMAR.storeRoot;
const STORE_DIR = STORE.slice(0, -1);

// The post-state each role declares. A listing parent declares NONE — it was not changed, it is read
// because something else was. `present` DOES declare one: the census already OBSERVED that document
// as a regular file, so a state that has changed underneath since is a fact to state, never a
// document to drop quietly from a store the run would otherwise call clean.
const DECLARED_STATE = Object.freeze({ add: 'file', modify: 'file', 'rename-to': 'file', remove: 'absent', 'rename-from': 'absent', present: 'file' });
const missing = () => {
  throw new Error('spec-check: an IO dependency was not injected — this module owns no filesystem of its own');
};

const dirOf = (rel) => rel.slice(0, rel.lastIndexOf('/'));
const leafOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const bare = (rel) => (rel.endsWith('/') ? rel.slice(0, -1) : rel);
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;
const occurrences = (text, needle) => text.split(needle).length - 1;
// Containment is a question about path COMPONENTS, and only the platform's own path model answers
// it. A textual prefix test reads "/repo\outside" as a child of "/repo" on a POSIX host — where the
// backslash is an ordinary filename character — and it mis-reads a filesystem root ("/" or "C:\")
// in both directions. `..` is compared as a whole SEGMENT, so a child named "..keep" stays inside.
const contained = (rootReal, real) => {
  const rel = relative(rootReal, real);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

// The link string a parent must carry for this child — verbatim, so `./x.md` and `./x/index.md`
// stay the distinct targets the 2a extraction froze them as.
const expectedLink = (rel, parent) => `./${rel.slice(parent.length - NAV.length)}`;

const verdictOf = (findings, documents, lane) => {
  if (findings.length === 0) {
    return { verdict: 'ACCEPT', exit: 0, findings, documents, lines: [`spec-check: ACCEPT — ${documents} document(s) clean (${lane})`] };
  }
  return {
    verdict: 'REFUSE',
    exit: 1,
    findings,
    documents,
    lines: [
      `spec-check: REFUSE — ${findings.length} finding(s) over ${documents} document(s) (${lane})`,
      ...findings.map((f) => `  ${f.path}: ${f.rule} — ${f.message}`),
    ],
  };
};
const refusal = (message) => ({ verdict: 'REFUSE', exit: 2, findings: [], documents: 0, lines: [`spec-check: REFUSE — ${message}`] });

// Every document of the closure, read ONCE: probe, then (only for a regular file) the descriptor-
// bound read and the reader verdict. Containment of the containing directory is decided BEFORE the
// read, so a directory that resolves outside the root is never opened through.
const readClosure = (closure, ctx) => {
  const { io, at, rootReal, add } = ctx;
  const docs = new Map();
  for (const { path, roles } of closure) {
    if (classifyPath(path) !== 'file' || !path.startsWith(STORE)) {
      add('contained', path, 'the path is not a repo-relative file inside the store');
      continue;
    }
    const dirReal = io.realpath(at(dirOf(path)));
    const dirContained = dirReal !== null && contained(rootReal, dirReal);
    if (dirReal !== null && !dirContained) {
      add('contained', path, `its directory ${dirOf(path)} resolves outside the root (${dirReal})`);
      continue;
    }
    const state = io.probe(at(path));
    const doc = { path, roles, state, verdict: null, lines: 0, ground: [], edges: [] };
    docs.set(path, doc);
    const declared = roles.map((role) => DECLARED_STATE[role]).find(Boolean);
    if (declared && state !== declared) {
      const source = roles.includes('present')
        ? 'the census observed this document as a regular file'
        : `the op declares this document ${declared === 'absent' ? 'gone' : 'present as a regular file'}`;
      add('post-state', path, `${source}, the store now says "${state}"`);
    }
    if (state !== 'file') continue;
    // Fail-closed is PROVEN contained, not "not proven to escape": a directory whose realpath does
    // not resolve was never observed, so the leaf inside it is never opened.
    if (!dirContained) {
      add('contained', path, `its directory ${dirOf(path)} does not resolve, so the read is refused (fail closed)`);
      continue;
    }
    const read = io.read(at(path));
    if (read.outcome !== 'ok') {
      add('unreadable', path, `the descriptor-bound read says ${read.outcome}${read.className ? ` (${read.className})` : ''}${read.code ? ` (${read.code})` : ''} — the probe is not what is judged`);
      continue;
    }
    doc.lines = lineCount(read.content);
    doc.verdict = readSpecDocument(read.content, path.slice(STORE.length));
  }
  return docs;
};

const linkTargetsOf = (doc) => [...(doc?.verdict?.structure?.children ?? []), ...(doc?.verdict?.structure?.parts ?? [])].map((link) => link.target);

// Every LISTED edge is a claim about another document, and an unchecked claim is what lets a broken
// or escaping target ride into the reachability graph as if it were reached. Each edge is resolved,
// contained (lexically AND by realpath) and PROBED; only an observed regular file becomes an edge.
const judgeEdges = (doc, ctx) => {
  const { io, at, rootReal, add } = ctx;
  for (const target of linkTargetsOf(doc)) {
    const child = `${dirOf(doc.path)}/${target.slice(2)}`;
    if (classifyPath(child) !== 'file' || !child.startsWith(STORE)) {
      add('link', doc.path, `it lists ${target}, which is not a document inside the store`);
      continue;
    }
    const real = io.realpath(at(child));
    if (real === null || !contained(rootReal, real)) {
      add('link', doc.path, `it lists ${target}, which ${real === null ? 'does not resolve' : `resolves outside the root (${real})`}`);
      continue;
    }
    const state = io.probe(at(child));
    if (state !== 'file') {
      add('link', doc.path, `it lists ${target}, which the store reports as "${state}" — a listed child is a regular file`);
      continue;
    }
    doc.edges.push(child);
  }
};

// The per-document judgement, identical in both lanes: the relayed reader rules, the kind's own
// line cap, the listed edges, the D4 scenario bindings and the containment of every path it names.
const judgeDocument = (doc, ctx) => {
  const { io, at, rootReal, add } = ctx;
  const { path, verdict } = doc;
  if (verdict === null) return;
  for (const error of verdict.errors) add('reader', path, `${error.rule}: ${error.message}`, { readerRule: error.rule });
  const cap = SPEC_SCHEMA.maxLines[verdict.kind];
  if (cap !== undefined && doc.lines > cap) {
    add('threshold', path, `${doc.lines} lines over the ${verdict.kind} cap of ${cap} — promote it to <slug>/index.md + parts`);
  }
  const structure = verdict.structure;
  if (structure === null) return;
  // A module names the code the contract governs. Ground that is absent, unreadable or of the OTHER
  // kind is a claim about code that is not there — and only a PROVEN canonical path is kept, so the
  // store-wide overlap comparison never mixes observed ground with a lexical guess.
  for (const claimed of structure.module?.paths ?? []) {
    const wantDir = claimed.endsWith('/');
    const target = bare(claimed);
    const real = io.realpath(at(target));
    if (real === null) {
      add('module', path, `the module path ${claimed} names ground that is not there`);
      continue;
    }
    if (!contained(rootReal, real)) {
      add('contained', path, `the module path ${claimed} resolves outside the root (${real})`);
      continue;
    }
    const state = io.probe(at(target));
    if (state !== (wantDir ? 'dir' : 'file')) {
      add('module', path, `the module path ${claimed} is "${state}", not the ${wantDir ? 'directory' : 'file'} it declares`);
      continue;
    }
    doc.ground.push(real);
  }
  judgeEdges(doc, ctx);
  for (const scenario of structure.scenarios) {
    if (scenario.binding === null) continue;
    const { file, marker } = scenario.binding;
    if (classifyPath(file) !== 'file') {
      add('binding', path, `S${scenario.ordinal} names "${file}", which is not a repo-relative file`);
      continue;
    }
    const real = io.realpath(at(file));
    if (real === null) {
      add('binding', path, `S${scenario.ordinal} binds ${file}, which does not resolve — an unobserved path is never opened`);
      continue;
    }
    if (!contained(rootReal, real)) {
      add('contained', path, `the S${scenario.ordinal} binding ${file} resolves outside the root (${real})`);
      continue;
    }
    const state = io.probe(at(file));
    if (state !== 'file') {
      add('binding', path, `S${scenario.ordinal} binds ${file}, which the store reports as "${state}"`);
      continue;
    }
    const read = io.read(at(file));
    if (read.outcome !== 'ok') {
      add('binding', path, `S${scenario.ordinal} binds ${file}, which cannot be read (${read.outcome})`);
      continue;
    }
    const found = occurrences(read.content, marker);
    if (found !== 1) add('binding', path, `the marker ${marker} occurs ${found} time(s) in ${file} — exactly once binds a scenario`);
  }
};

// The listing judgement — a SESSION-lane rule: the document the ops touched must be listed by its
// parent exactly once after an add/modify/rename-to, and not at all after a remove/rename-from.
// Under --all the reachability invariants below own this ground instead, so it never doubles up.
const judgeListing = (doc, docs, add) => {
  const declared = doc.roles.map((role) => DECLARED_STATE[role]).find(Boolean);
  if (!declared) return;
  const parent = listingParentOf(doc.path);
  if (parent === null) return;
  const holder = docs.get(parent);
  const link = expectedLink(doc.path, parent);
  if (!holder || holder.state !== 'file' || holder.verdict === null) {
    add('listed', doc.path, `its listing parent ${parent} cannot be read, so nothing states whether ${link} is listed`);
    return;
  }
  const found = linkTargetsOf(holder).filter((target) => target === link).length;
  if (declared === 'file' && found !== 1) add('listed', doc.path, `${parent} lists ${link} ${found} time(s) — a present document is listed exactly once`);
  if (declared === 'absent' && found !== 0) add('listed', doc.path, `${parent} still lists ${link} — a removed document is listed by nobody`);
};

// Every `.md` document under the store, found by LISTING rather than by trusting any index. The walk
// is what makes "unlisted" and "orphan" observable at all — so a branch it could not observe is a
// FINDING, never an empty directory quietly walked past: an incomplete census that reported a clean
// store would be the one answer this lane must never give. A directory is contained BEFORE it is
// listed, and a non-regular `.md` sitting in the store is stated rather than skipped.
const walkStore = (ctx) => {
  const { io, at, rootReal, add } = ctx;
  const found = [];
  const stack = [STORE_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    const dirReal = io.realpath(at(dir));
    if (dirReal === null || !contained(rootReal, dirReal)) {
      add('census', dir, `the store directory ${dirReal === null ? 'does not resolve' : `resolves outside the root (${dirReal})`}, so what it holds was never observed`);
      continue;
    }
    const names = io.list(at(dir));
    if (names === null) {
      add('census', dir, 'the store directory cannot be listed, so this branch of the census is unobserved');
      continue;
    }
    for (const name of names) {
      const rel = `${dir}/${name}`;
      const state = io.probe(at(rel));
      if (state === 'dir') stack.push(rel);
      else if (state === 'file' && name.endsWith(SPEC_OPS_GRAMMAR.suffix)) found.push(rel);
      // Every OTHER entry is stated, `.md` or not. A symlinked DIRECTORY is the hole a `.md`-only
      // census leaves: an edge can be resolved THROUGH it while the documents behind it were never
      // observed, read or judged — and --all would then accept a store it never fully saw.
      else add('census', rel, `a ${state} sits inside the store — it holds regular ${SPEC_OPS_GRAMMAR.suffix} documents and plain directories only`);
    }
  }
  return found.sort();
};

// Reachability from the store root over the extracted child/part links. Identity is the realpath of
// the containing DIRECTORY plus the leaf name — that is what makes a symlinked folder pointing at an
// ancestor a cycle rather than an infinite walk, and it is judged on the trail, not on the visited
// set, so a diamond (two indexes listing one document) is not mistaken for a loop.
const reachStore = (docs, ctx) => {
  const { io, at } = ctx;
  const reached = new Set();
  const cycles = [];
  const identity = (rel) => `${io.realpath(at(dirOf(rel))) ?? dirOf(rel)}/${leafOf(rel)}`;
  const visit = (rel, trail) => {
    const id = identity(rel);
    if (trail.has(id)) {
      cycles.push(rel);
      return;
    }
    if (reached.has(rel)) return;
    reached.add(rel);
    const next = new Set([...trail, id]);
    // PROVEN edges only (judgeEdges): a phantom target would launder an orphan into a reached
    // document and hide exactly what this lane exists to find.
    for (const child of docs.get(rel)?.edges ?? []) visit(child, next);
  };
  visit(STORE_ROOT, new Set());
  return { reached, cycles };
};

// The four cross-document invariants (the fifth — an absent store root — refuses the run before any
// of them can be asked). Each is a question no single document can answer about itself.
const judgeStore = (docs, ctx) => {
  const { add } = ctx;
  const { reached, cycles } = reachStore(docs, ctx);
  for (const rel of cycles) add('acyclic', rel, 'the child graph reaches this document from inside itself — a cycle, not a tree');
  for (const [rel, doc] of docs) {
    if (reached.has(rel) || doc.state !== 'file') continue;
    const parent = listingParentOf(rel);
    if (parent !== null && reached.has(parent)) {
      add('unlisted-child', rel, `${parent} is reached from the store root but does not list ${expectedLink(rel, parent)}`);
    } else {
      add('orphan', rel, 'no index reaches this document — it is not an unlisted child, it is outside the tree entirely');
    }
  }
  const bySlug = new Map();
  for (const [rel, doc] of docs) {
    const slug = doc.state === 'file' ? slugOf(rel) : null;
    if (slug === null || rel === STORE_ROOT) continue;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), rel]);
  }
  for (const [slug, paths] of bySlug) {
    if (paths.length > 1) for (const rel of paths) add('slug-unique', rel, `the slug "${slug}" is claimed by ${paths.length} documents (${paths.join(', ')}) — a slug is store-wide`);
  }
  // PROVEN canonical ground only (judgeDocument) — a path that never resolved is not compared as if
  // it had. Nesting is asked with the platform's own path model — `dirname` walked upward, never a
  // hand-rolled separator rule — and it is asked ONCE PER PATH rather than once per pair: the store
  // this lane exists for holds a thousand specs, and a pairwise sweep would spend the whole D-scale
  // budget re-deciding the same question a million times.
  const owners = new Map();
  for (const doc of docs.values()) {
    for (const claimed of doc.ground) owners.set(claimed, new Set([...(owners.get(claimed) ?? []), doc.path]));
  }
  // The index accumulates unique conflicting PAIRS, which is the granularity a pairwise sweep
  // reported: one finding per document per pair. Counting per ground path instead would repeat a
  // pair once per descendant it shares, and a three-level chain would fuse unrelated pairs into one
  // lumped message.
  const pairs = new Map();
  // The key is JSON, not a joined string: the census lists what is ON DISK, so a document path can
  // carry any byte a filesystem allows — a space included — long before the reader refuses its slug.
  // Any separator those paths might themselves contain makes the key non-injective, and the pair
  // that collides would be dropped in silence.
  const note = (one, other, claimed) => {
    if (one === other) return;
    const [a, b] = [one, other].sort();
    const key = JSON.stringify([a, b]);
    if (!pairs.has(key)) pairs.set(key, { a, b, claimed });
  };
  for (const [claimed, held] of owners) {
    const owned = [...held];
    for (const [i, one] of owned.entries()) for (const other of owned.slice(i + 1)) note(one, other, claimed);
    for (let up = pathDirname(claimed), below = claimed; up !== below; below = up, up = pathDirname(up)) {
      for (const above of owners.get(up) ?? []) for (const one of owned) note(one, above, claimed);
    }
  }
  for (const { a, b, claimed } of pairs.values()) {
    add('overlap', a, `its module ground overlaps ${claimed}, also claimed by ${b} — two contracts, one piece of code`);
    add('overlap', b, `its module ground overlaps ${claimed}, also claimed by ${a} — two contracts, one piece of code`);
  }
};

// checkSpecs({ root, ops, all }, deps) -> { verdict, exit, findings, documents, lines }.
// Exit 0 ACCEPT · 1 one or more findings · 2 a refusal about the RUN itself (an unresolvable root,
// an absent store root under --all) — the CLI prints the lines and returns the code.
export const checkSpecs = ({ root, ops = [], all = false } = {}, deps = {}) => {
  const io = { read: missing, probe: missing, realpath: missing, list: missing, ...deps };
  const at = (rel) => (rel === '' ? root : `${root}/${rel}`);
  const rootReal = io.realpath(root);
  if (rootReal === null) return refusal(`--root "${root}" does not resolve to a directory — nothing can be judged against it`);
  const findings = [];
  const add = (rule, path, message, extra = {}) => findings.push({ rule, path, message, ...extra });
  const ctx = { io, at, rootReal, add };
  if (all && io.probe(at(STORE_ROOT)) !== 'file') {
    return refusal(`the store root ${STORE_ROOT} is not a regular file — an --all run over no store would report an empty clean store, so it refuses instead`);
  }
  const closure = all ? walkStore(ctx).map((path) => ({ path, roles: ['present'] })) : buildClosure(ops);
  // A census that observed nothing still established one fact: its own refusal. Collapsing that into
  // the empty-closure usage error would throw away the only thing the run learned, so the usage
  // refusal is the SESSION lane's alone.
  if (closure.length === 0 && findings.length === 0) return refusal('no document to judge — the op closure is empty');
  const docs = readClosure(closure, ctx);
  for (const doc of docs.values()) judgeDocument(doc, ctx);
  if (all) judgeStore(docs, ctx);
  else for (const doc of docs.values()) judgeListing(doc, docs, add);
  return verdictOf(findings, closure.length, all ? 'the whole store' : `${ops.length} op(s)`);
};

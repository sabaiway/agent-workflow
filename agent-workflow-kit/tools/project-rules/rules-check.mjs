// The read-only check: one verdict per registry theme, judged only against the record. It imports no
// writer and reads every file through readUnder, so no symlink inside the root is followed. Contract:
// docs/ai/specs/kit/project-rules/rules-check.md.

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from '../../references/scripts/docs-size/index.mjs';
import { tokenizeMarkdown } from '../../references/scripts/shared/index.mjs';
import { readFileBytesNoFollow } from '../fs-read-nofollow.mjs';
import { RECORD_PATH, THEMES, themePaths } from './themes.mjs';

const UPGRADE = 'run /agent-workflow-kit upgrade';
const EDIT_NOTE = 'move your edit to local/, a rebuild drops it';
const DIGEST = /^[0-9a-f]{64}$/;
const ROLES = ['kit', 'local', 'effective'];
const LABELS = { kit: 'K', local: 'L', effective: 'E' };
const LIST_ITEM = /^(?:[-*+]|[0-9]+[.)]) /;
const INDENTED = /^[ \t]/;
const OPENING_WORDS = 8;
const LEGACY_SCHEMA = 1;
export const RECORD_SCHEMA = 2;
const REPLACED_BY = 'replaced-by';
const REWRITTEN_AS = 'rewritten-as';
const FOLDED_INTO = 'folded-into';
const FATE_PATTERN = /^(?:K[1-9][0-9]* replaced-by L[1-9][0-9]*|K[1-9][0-9]* rewritten-as E[1-9][0-9]* because-of L[1-9][0-9]*|L[1-9][0-9]* folded-into E[1-9][0-9]*)$/;
export const FATE_FORMS = 'K<n> replaced-by L<m>; K<n> rewritten-as E<m> because-of L<k>; L<n> folded-into E<m>';
const LABEL_NOTE = 'the labels number the three files as they stand when the command runs, and a merged file changed after this refusal takes its new sha256 and its new labels';

const normalizeFate = (fate) => typeof fate === 'string' ? fate.trim().replace(/[ \t]+/g, ' ') : '';
const isFate = (text) => typeof text === 'string' && text === normalizeFate(text) && FATE_PATTERN.test(text);

const readRuleDocument = (text, label) => {
  try {
    const { frontmatter, frontLines, lines, headings, fencedLines } = tokenizeMarkdown(text, label);
    const headingIndexes = new Set(headings.map(({ index }) => index));
    const ranges = [];
    const state = { active: null, previous: null };
    for (const [index, line] of lines.entries()) {
      if (headingIndexes.has(index)) {
        state.active = null;
        state.previous = null;
      } else if (!fencedLines.has(index) && line.trim() === '') {
        state.active = null;
      } else {
        const item = !fencedLines.has(index) && LIST_ITEM.test(line);
        if (!state.active && !item && INDENTED.test(line)) state.active = state.previous;
        if (!state.active || item) {
          state.active = { start: index, end: index };
          ranges.push(state.active);
        }
        state.active.end = index;
        state.previous = state.active;
      }
    }
    return {
      ok: true,
      frontmatter,
      units: ranges.map(({ start, end }, index) => ({
        label: label + (index + 1), line: frontLines + start + 1, text: lines.slice(start, end + 1).join('\n'),
      })),
      headings: headings.map(({ index, raw, level }, order) => ({
        label: label === 'K' ? 'KH' + (order + 1) : null, line: frontLines + index + 1, text: raw, level,
      })),
    };
  } catch (error) {
    return { ok: false, label, reason: error.message };
  }
};

export const readRuleUnits = (text, label) => {
  const result = readRuleDocument(text, label);
  if (!result.ok) return result;
  const { units, headings } = result;
  return { ok: true, units, headings };
};

const findParent = (headings, line, level = Infinity) =>
  headings.findLast((heading) => heading.line < line && heading.level < level) ?? null;

const claimInOrder = (sources, targets, matches) => {
  const claims = new Map();
  for (const source of sources) {
    const previous = [...claims.values()].at(-1);
    const target = targets.find((candidate) => candidate.line > (previous?.line ?? 0)
      && candidate.text === source.text && matches(source, candidate, claims));
    if (target) claims.set(source, target);
  }
  return claims;
};

const claimSkeleton = (kit, effective) =>
  claimInOrder(kit.headings, effective.headings, (source, target, claims) => {
    const parent = findParent(kit.headings, source.line, source.level);
    const expected = parent === null ? null : claims.get(parent);
    return findParent(effective.headings, target.line, target.level) === expected;
  });

const claimKitUnits = (kit, effective, standing, skeleton) =>
  claimInOrder(kit.units.filter(standing), effective.units, (source, target) => {
    const heading = findParent(kit.headings, source.line);
    const expected = heading === null ? null : skeleton.get(heading);
    return findParent(effective.headings, target.line) === expected;
  });

const claimLocalUnits = (local, effective, standing, kitClaims) => {
  const claimed = new Set(kitClaims.values());
  const localClaims = new Map();
  for (const unit of local.units.filter(standing)) {
    const target = effective.units.find((candidate) => candidate.text === unit.text && !claimed.has(candidate));
    if (target) {
      localClaims.set(unit, target);
      claimed.add(target);
    }
  }
  return { localClaims, claimed };
};

const readFate = (raw) => {
  const text = normalizeFate(raw);
  if (!isFate(text)) return { raw, text, valid: false };
  const [subject, kind, target, , reason] = text.split(' ');
  return { raw, text, valid: true, subject, kind, target, reason, labels: [subject, target, reason].filter(Boolean) };
};

const opening = ({ text }) => text.split('\n')[0].trim().split(/\s+/).slice(0, OPENING_WORDS).join(' ');
const describeUnit = (unit) => `${unit.label} ${opening(unit)}`;
const describeChanges = (fates, units) => {
  if (fates.length === 0) return ['every kit and local rule stands word for word'];
  const describe = (label) => describeUnit(units.get(label));
  const replacements = new Set();
  return fates.flatMap(({ subject, kind, target, reason }) => {
    if (kind === REPLACED_BY) {
      if (replacements.has(target)) return [];
      replacements.add(target);
      const replaced = fates.filter((fate) => fate.kind === kind && fate.target === target).map((fate) => describe(fate.subject));
      return [`${replaced.join('; ')} replaced by ${describe(target)}`];
    }
    if (kind === FOLDED_INTO) return [`${describe(subject)} folded into ${describe(target)}`];
    const verb = units.get(subject).text === units.get(target).text ? 'moved to' : 'rewritten as';
    return [`${describe(subject)} ${verb} ${describe(target)} because of ${describe(reason)}`];
  });
};

const validFrame = (text, document) => parseFrontmatter(text) !== null && Boolean(document.frontmatter)
  && !document.frontmatter.trimEnd().split('\n').slice(1, -1).some((line) => line.startsWith('---'));

const describeLocation = (unit, role) => `${unit.label ?? unit.text} (${role}:${unit.line})`;
const describeLocatedUnit = (unit, role) => `${describeLocation(unit, role)} ${opening(unit)}`;

const refuseProof = (failures, documents) => {
  const lines = [...failures.map(({ row, detail }) => `${row}: ${detail}`)];
  lines.push('kit headings:');
  for (const heading of documents.kit.headings ?? []) lines.push(`${describeLocation(heading, 'kit')} ${heading.text}`);
  for (const role of ROLES) {
    lines.push(`${role} units:`);
    for (const unit of documents[role].units ?? []) lines.push(describeLocatedUnit(unit, role));
  }
  lines.push(FATE_FORMS, LABEL_NOTE);
  return { ok: false, failures: failures.map(({ row, subject }) => ({ row, subject })), lines };
};

export const proveMerge = ({ kit, local, effective, fates = [] }) => {
  const texts = { kit, local, effective };
  const documents = Object.fromEntries(ROLES.map((role) => [role, readRuleDocument(texts[role], LABELS[role])]));
  const failures = [];
  const fail = (row, subject, detail = subject) => failures.push({ row, subject, detail });
  const units = new Map();
  for (const role of ROLES) {
    const document = documents[role];
    if (!document.ok) fail('reader', role, `${role}: ${document.reason.split(/ Separate them:| Close it with/)[0]}`);
    for (const unit of document.units ?? []) units.set(unit.label, unit);
  }
  const roleOf = (label) => ROLES.find((role) => label.startsWith(LABELS[role]));
  if (!Array.isArray(fates)) fail('form', String(fates), `not an array of fates: ${String(fates)}`);
  const parsed = Array.isArray(fates) ? Array.from(fates, readFate) : [];
  const valid = parsed.filter((fate) => {
    if (!fate.valid) fail('form', String(fate.raw));
    return fate.valid;
  });
  for (const fate of valid) {
    const missing = fate.labels.filter((label) => documents[roleOf(label)].ok && !units.has(label));
    if (missing.length) fail('labels', fate.text, `${fate.text} — missing ${missing.join(', ')}`);
  }
  if (!validFrame(effective, documents.effective)) fail('frame', 'effective');
  const standing = (unit) => !valid.some(({ subject }) => subject === unit.label);
  for (const subject of new Set(valid.map((fate) => fate.subject))) {
    const own = valid.filter((fate) => fate.subject === subject);
    if (own.length > 1) {
      const unit = units.get(subject);
      const role = roleOf(subject);
      const description = unit ? describeLocatedUnit(unit, role) : subject;
      fail('one fate', subject, `${description}: ${own.map(({ text }) => text).join('; ')}`);
    }
  }
  for (const fate of valid) {
    if (fate.kind === REPLACED_BY && valid.some(({ subject }) => subject === fate.target)) fail('replaced-by', fate.text);
  }
  const kitReadable = documents.kit.ok && documents.effective.ok;
  const allReadable = kitReadable && documents.local.ok;
  const skeleton = kitReadable ? claimSkeleton(documents.kit, documents.effective) : new Map();
  const kitClaims = kitReadable ? claimKitUnits(documents.kit, documents.effective, standing, skeleton) : new Map();
  const { localClaims, claimed } = allReadable
    ? claimLocalUnits(documents.local, documents.effective, standing, kitClaims)
    : { localClaims: new Map(), claimed: new Set(kitClaims.values()) };
  const failUnit = (row, unit, role) => fail(row, unit.label, describeLocatedUnit(unit, role));
  if (kitReadable) {
    for (const fate of valid) {
      if (fate.kind !== REWRITTEN_AS) continue;
      const claimant = [...kitClaims, ...localClaims].find(([, target]) => target.label === fate.target);
      if (claimant) {
        const unit = claimant[0];
        const role = kitClaims.has(unit) ? 'kit' : 'local';
        fail('rewritten-as', fate.text, `${fate.text} — claimed by ${describeLocatedUnit(unit, role)}`);
      }
    }
    for (const heading of documents.kit.headings) {
      if (!skeleton.has(heading)) fail('skeleton', heading.label, describeLocation(heading, 'kit'));
    }
    for (const unit of documents.kit.units.filter(standing)) {
      if (!kitClaims.has(unit)) failUnit('kit order', unit, 'kit');
    }
  }
  if (allReadable) {
    for (const unit of documents.local.units.filter(standing)) {
      if (!localClaims.has(unit)) failUnit('local', unit, 'local');
    }
    const targets = new Set(valid.filter(({ kind }) => kind !== REPLACED_BY).map(({ target }) => target));
    for (const unit of documents.effective.units) {
      if (!claimed.has(unit) && !targets.has(unit.label)) failUnit('accounted', unit, 'effective');
    }
    for (const heading of documents.effective.headings) {
      if (![...skeleton.values()].includes(heading) && !documents.local.headings.some(({ text }) => text === heading.text)) {
        fail('headings', heading.text, describeLocation(heading, 'effective'));
      }
    }
  }
  return failures.length === 0
    ? { ok: true, fates: valid.map(({ text }) => text), changes: describeChanges(valid, units) }
    : refuseProof(failures, documents);
};

export const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

const isDigest = (value) => typeof value === 'string' && DIGEST.test(value);

// readUnder(root, rel, deps?) → a readFileBytesNoFollow outcome for root/rel, or foreign or error
// without a read when a directory on rel's path inside root is a symlink, not a directory, or cannot be
// inspected; a missing directory ends the walk and the leaf then reads absent.
export const readUnder = (root, rel, deps = {}) => {
  const lstat = deps.lstat ?? lstatSync;
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    let st;
    try {
      st = lstat(join(root, prefix));
    } catch (err) {
      if (err && err.code === 'ENOENT') break;
      return { outcome: 'error', code: `${prefix} cannot be inspected (${err?.code ?? err})` };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { outcome: 'foreign', code: `${prefix} is a symlink or not a directory` };
  }
  return (deps.read ?? readFileBytesNoFollow)(join(root, rel));
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

// parseRecord(text, themes?) → { ok: true, record } | { ok: false, reason }: the record's one schema reader.
export const parseRecord = (text, themes = THEMES) => {
  const bad = (reason) => ({ ok: false, reason });
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return bad('not JSON');
  }
  if (!isObject(record) || !sameKeys(record, ['schema', 'themes'])) return bad('the keys are not exactly schema and themes');
  if (![LEGACY_SCHEMA, RECORD_SCHEMA].includes(record.schema)) return bad(`schema ${JSON.stringify(record.schema)} is neither 1 nor 2`);
  if (!isObject(record.themes)) return bad('themes is not an object');
  const names = new Set(themes.map((theme) => theme.name));
  for (const [name, entry] of Object.entries(record.themes)) {
    if (!names.has(name)) return bad(`theme ${name} is not in the registry`);
    if (!isObject(entry)) return bad(`the entry of ${name} is not an object`);
    const proved = record.schema === RECORD_SCHEMA && sameKeys(entry, [...ROLES, 'fates']);
    if (!proved && !sameKeys(entry, ROLES)) return bad(`the entry of ${name} has unknown or missing keys`);
    if (!isDigest(entry.kit) || !isDigest(entry.effective)) return bad(`the entry of ${name} holds a value that is not a sha256`);
    if (entry.local !== 'absent' && !isDigest(entry.local)) return bad(`the local of ${name} is neither a sha256 nor absent`);
    if (proved && (!Array.isArray(entry.fates) || !entry.fates.every(isFate)
      || (entry.local === 'absent' && entry.fates.length !== 0))) return bad(`the fates of ${name} are unreadable`);
  }
  return { ok: true, record };
};

// readRecord(outcome, themes) → { ok: true, themes } | { ok: false, reason }: an absent record holds no entry.
export const readRecord = (outcome, themes = THEMES) => {
  if (outcome.outcome === 'absent') return { ok: true, themes: {} };
  if (outcome.outcome !== 'ok') return { ok: false, reason: 'it is not a regular file this check can read' };
  const parsed = parseRecord(outcome.bytes.toString('utf8'), themes);
  return parsed.ok ? { ok: true, schema: parsed.record.schema, themes: parsed.record.themes } : parsed;
};

const recordVerdict = (theme, state, detail) =>
  ({ theme, verdict: 'record', state, line: `${theme}: record (${state}) — ${detail} — ${UPGRADE}` });

const judgeTheme = ({ name: theme, home }, paths, files, record) => {
  if (!record.ok) return recordVerdict(theme, 'unreadable-record', `${paths.record} is unreadable: ${record.reason}`);
  const unreadable = ROLES.find((role) => !['ok', 'absent'].includes(files[role].outcome));
  if (unreadable) return recordVerdict(theme, 'unreadable-file', `${paths[unreadable]} is not a regular file this check can read`);
  const present = (role) => files[role].outcome === 'ok';
  const entry = record.themes[theme];
  if (entry === undefined) {
    const existing = ROLES.find(present);
    if (existing === undefined) return home === 'engine'
      ? { theme, verdict: 'absent', line: `${theme}: absent` }
      : recordVerdict(theme, 'not-laid', 'no kit, local or effective file and no record entry');
    return recordVerdict(theme, 'no-entry', `no record entry while ${paths[existing]} exists`);
  }
  const missing = ['kit', 'effective'].find((role) => !present(role));
  if (missing) return recordVerdict(theme, 'missing-file', `${paths[missing]} is missing under its record entry`);
  const differs = {
    kit: digestOf(files.kit.bytes) !== entry.kit,
    local: present('local') ? digestOf(files.local.bytes) !== entry.local : entry.local !== 'absent',
    effective: digestOf(files.effective.bytes) !== entry.effective,
  };
  const moved = ROLES.filter((role) => differs[role])
    .map((role) => (role === 'effective' ? { role, file: paths[role], note: EDIT_NOTE } : { role, file: paths[role] }));
  if (moved.length > 0) {
    const named = moved.map(({ file, note }) => (note ? `${file} (${note})` : file)).join('; ');
    return { theme, verdict: 'drift', moved, line: `${theme}: drift — moved ${named} — ${UPGRADE}` };
  }
  if (!present('local') && !files.kit.bytes.equals(files.effective.bytes)) {
    return recordVerdict(theme, 'kit-effective-differ', `no local file, yet ${paths.effective} differs from ${paths.kit}`);
  }
  if (Object.hasOwn(entry, 'fates')) {
    const effective = files.effective.bytes.toString('utf8');
    if (present('local')) {
      const proof = proveMerge({ kit: files.kit.bytes.toString('utf8'), local: files.local.bytes.toString('utf8'), effective, fates: entry.fates });
      if (!proof.ok) return recordVerdict(theme, 'unproved-merge', proof.lines.slice(0, proof.failures.length).join('; '));
    } else if (parseFrontmatter(effective) === null) {
      return recordVerdict(theme, 'unproved-merge', `${paths.effective} carries no frontmatter`);
    }
  }
  return { theme, verdict: 'current', line: `${theme}: current` };
};

// checkRules(root, deps?) → [{ theme, verdict, line, moved?, state? }] in registry order; writes nothing.
export const checkRules = (root, deps = {}) => {
  const themes = deps.themes ?? THEMES;
  const record = readRecord(readUnder(root, RECORD_PATH, deps), themes);
  return themes.map((theme) => {
    const paths = themePaths(theme.name);
    const files = Object.fromEntries(ROLES.map((role) => [role, readUnder(root, paths[role], deps)]));
    return judgeTheme(theme, paths, files, record);
  });
};

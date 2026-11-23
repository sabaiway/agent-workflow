import { posix } from 'node:path';
import { SPEC_SCHEMA } from '../../references/scripts/spec-schema/index.mjs';
import { PLANS_REL } from '../plan-files.mjs';
import { parseRobustTag } from '../robustness-literals.mjs';
import { getRevisionHomePath, SPEC_OPS_GRAMMAR } from '../spec-check-ops.mjs';

export const AMENDMENT_LINE = 'amendments:';

const AMENDMENT_LINE_CODE = 'amendment-line';
const AMENDMENT_PATH_CODE = 'amendment-path';
const ROBUST_CLASS_CODE = 'robust-class';
const AMENDMENT_LINE_MESSAGE = `use one ${AMENDMENT_LINE} line between approved rows and amendment entries`;
const AMENDMENT_PATH_MESSAGE = 'must name a literal path outside the spec store and revision homes';
const ROBUST_TAG_LABEL = 'robust tag:';
const ASCII_UPPERCASE = /[A-Z]/g;
const PLANS_PREFIX = `${PLANS_REL}${posix.sep}`;
const STORE_ROOT = SPEC_SCHEMA.storePrefix.slice(0, -posix.sep.length);
const REVISION_HOME_SUFFIX = getRevisionHomePath(SPEC_OPS_GRAMMAR.suffix);

const refusesAmendmentPath = (path, isSweep) => {
  if (isSweep(path)) return true;
  const foldedPath = path.replace(ASCII_UPPERCASE, (letter) => letter.toLowerCase());
  if (foldedPath === STORE_ROOT || foldedPath.startsWith(SPEC_SCHEMA.storePrefix)) return true;
  if (!foldedPath.startsWith(PLANS_PREFIX)) return false;
  const [home] = foldedPath.slice(PLANS_PREFIX.length).split(posix.sep);
  return home.length > REVISION_HOME_SUFFIX.length && home.endsWith(REVISION_HOME_SUFFIX);
};

export const relateAmendments = ({ parsed, makeFinding, isSweep }) => {
  const separators = parsed.entries.filter(({ raw }) => raw === AMENDMENT_LINE);
  const [separator, extraSeparator] = separators;
  const unsplit = { approved: parsed.rows, entries: [], amendmentLines: [], findings: [] };
  if (!separator) return unsplit;

  const approved = parsed.rows.filter(({ line }) => line < separator.line);
  const entries = parsed.rows.filter(({ line }) => line > separator.line);
  if (extraSeparator || !approved.length || !entries.length) {
    return {
      ...unsplit,
      findings: separators.map(({ line }) => makeFinding(line, AMENDMENT_LINE_CODE, AMENDMENT_LINE_MESSAGE, null)),
    };
  }

  const amendmentLines = parsed.entries.filter(({ line }) => line >= separator.line)
    .map(({ line }) => line);
  const refusedEntries = entries.filter(({ path }) => path && refusesAmendmentPath(path, isSweep));
  const findings = refusedEntries.map(({ line, id }) =>
    makeFinding(line, AMENDMENT_PATH_CODE, `${id} ${AMENDMENT_PATH_MESSAGE}`, id));
  return { approved, entries, amendmentLines, findings };
};

const describeRobustRefusal = (refusal) => `tag grammar refused ${refusal}`;
const describeUnknownRobustClass = (classId) => `class ${classId} is not in the shipped list`;

export const checkRobustTags = ({ rows, facts, makeFinding }) => {
  const taggedRows = rows.map((row) => ({ row, tag: parseRobustTag(row.responsibility) }))
    .filter(({ tag }) => tag.refusal || tag.classes?.length);
  if (!taggedRows.length) return [];

  const robustClasses = new Set(facts.robustClasses ?? []);
  return taggedRows.flatMap(({ row, tag }) => {
    const unknownClass = tag.classes?.find((classId) => !robustClasses.has(classId));
    if (!tag.refusal && unknownClass === undefined) return [];
    const reason = tag.refusal ? describeRobustRefusal(tag.refusal) : describeUnknownRobustClass(unknownClass);
    return [makeFinding(row.line, ROBUST_CLASS_CODE, `${row.id} ${ROBUST_TAG_LABEL} ${reason}`, row.id)];
  });
};

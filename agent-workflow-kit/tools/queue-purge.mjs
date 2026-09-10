import { auditQueue, authorisesRemoval, canonicalHeading } from './queue-audit.mjs';
import { EXIT, frameBlock, hashBytes, judgeIntact, readArchive, renderTitle, sliceSection } from './queue-purge-archive.mjs';
import { fail } from '../references/scripts/markdown-blocks.mjs';

const readInputs = ({ queueBytes, section, archiveBytes = Buffer.alloc(0) }) => {
  if (!canonicalHeading(section)) throw fail(EXIT.usage, '--section is required');
  const audit = auditQueue(queueBytes.toString('utf8'), { range: section });
  const rows = audit.rows.filter(({ line }) => line >= audit.range.from && line < audit.range.to);
  const problems = [];
  const keys = new Map();
  for (const row of audit.rows) {
    if (!row.id) continue;
    const earlier = keys.get(row.id);
    if (earlier) problems.push(`key defect: doubled id ${row.id} at file lines ${earlier.line} and ${row.line}`);
    else keys.set(row.id, row);
  }
  const archive = readArchive(archiveBytes);
  if (archive.cause === 'foreign') throw fail(EXIT.usage, archive.problem);
  return { rows, problems, archive, section: canonicalHeading(section), sectionBytes: sliceSection(queueBytes, audit.range) };
};

const selectBlock = (archive, section) => archive.blocks.findLast((block) => canonicalHeading(block.section) === section);
const makeResult = (problems, notes = [], block) => ({ ok: problems.length === 0, problems, notes,
  ...(block === undefined ? {} : { block }) });

export const snapshotQueue = (options) => {
  const { rows, problems, archive, section, sectionBytes } = readInputs(options);
  const keyless = rows.filter(({ id }) => !id);
  const notes = keyless.length ? [`${keyless.length} keyless rows archived in ${section}`] : [];
  if (!judgeIntact(archive)) problems.push(archive.problem);
  if (problems.length) return makeResult(problems, [], null);
  const previous = selectBlock(archive, section);
  if (previous?.sectionDigest.equals(hashBytes(sectionBytes))) {
    return makeResult([`same section digest as the last block for ${section}`], [], null);
  }
  const block = frameBlock({ date: options.date, section, queuePath: options.queuePath, sectionBytes, indexEntries: rows });
  return makeResult(problems, notes, block);
};

export const checkPurge = (options) => {
  const { rows, problems, archive, section, sectionBytes } = readInputs(options);
  for (const row of rows.filter(({ id }) => !id)) {
    problems.push(`key defect: no id at current file line ${row.line}: ${renderTitle(row.title)}`);
  }
  if (!judgeIntact(archive)) return makeResult([...problems, archive.problem]);
  const block = selectBlock(archive, section);
  if (!block) {
    const recorded = [...new Set(archive.blocks.map(({ section: heading }) => heading))];
    throw fail(EXIT.usage, `no archive block for ${section}; recorded headings: ${recorded.join(', ') || '(none)'}`);
  }
  if (block.sectionDigest.equals(hashBytes(sectionBytes))) problems.push(`section not moved: ${section}`);
  const recordedKeys = new Set(block.indexEntries.filter(({ id }) => id).map(({ id }) => id));
  const currentKeys = new Set(rows.filter(({ id }) => id).map(({ id }) => id));
  for (const row of rows) {
    if (row.id && !recordedKeys.has(row.id)) {
      problems.push(`addition: ${row.id} at current file line ${row.line}: ${renderTitle(row.title)}`);
    }
  }
  for (const entry of block.indexEntries) {
    if (!entry.id) problems.push(`keyless entry at archived line ${entry.line}: ${entry.title}`);
    else if (!currentKeys.has(entry.id) && !authorisesRemoval(entry.klass)) {
      problems.push(`unauthorised absence: ${entry.id} at archived line ${entry.line}: ${entry.title} (recorded class ${entry.klass})`);
    }
  }
  return makeResult(problems);
};

import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, fsyncSync, readFileSync, writeFileSync, writeSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalHeading } from './queue-audit.mjs';
import { fail } from '../references/scripts/markdown-blocks.mjs';

export const EXIT = Object.freeze({ accept: 0, refuse: 1, usage: 2 });
const MAGIC = 'queue-purge: 1';
const HEADER_FIELDS = ['date', 'section', 'queue-path', 'section-bytes', 'index-bytes', 'section-sha256', 'block-sha256', 'rows'];
const BLOCK_DIGEST_FIELD = 'block-sha256';
const TITLE_WIDTH = 80;
const KEYLESS = '<keyless>';
const LF = 0x0a;
const HASH = 'sha256';
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const COUNT = /^(0|[1-9][0-9]*)$/;
const INDEX_COLUMNS = 4;
const PRIVATE_MODE = 0o600;

export const hashBytes = (bytes) => createHash(HASH).update(bytes).digest();
export const renderTitle = (title) => String(title).replace(/\s+/g, ' ').trim().slice(0, TITLE_WIDTH);

export const sliceSection = (bytes, range) => {
  const starts = [0];
  bytes.forEach((byte, offset) => { if (byte === LF) starts.push(offset + 1); });
  const start = starts[range.headingLine - 1];
  const end = starts[range.to - 1] ?? bytes.length;
  if (start === undefined || end < start) throw fail(EXIT.usage, 'invalid section byte range');
  return bytes.subarray(start, end);
};

const renderHeader = (fields, includeDigest = true) => Buffer.from([
  MAGIC, ...HEADER_FIELDS.filter((field) => includeDigest || field !== BLOCK_DIGEST_FIELD)
    .map((field) => `${field}: ${fields[field]}`), '', '',
].join('\n'));

const sealBlock = (headerBytes, body) => createHash(HASH).update(headerBytes).update(body).digest();

export const frameBlock = ({ date, section, queuePath, sectionBytes, indexEntries }) => {
  const indexBytes = Buffer.from(indexEntries.map(({ line, klass, id, title }) =>
    `${line}\t${klass}\t${id ?? KEYLESS}\t${renderTitle(title)}\n`).join(''));
  const body = Buffer.concat([sectionBytes, indexBytes]);
  const fields = {
    date, section: JSON.stringify(canonicalHeading(section)), 'queue-path': JSON.stringify(queuePath),
    'section-bytes': sectionBytes.length, 'index-bytes': indexBytes.length,
    'section-sha256': hashBytes(sectionBytes).toString('hex'), rows: indexEntries.length,
  };
  fields[BLOCK_DIGEST_FIELD] = sealBlock(renderHeader(fields, false), body).toString('hex');
  return Buffer.concat([renderHeader(fields), body]);
};

const readHeader = (bytes, offset) => {
  const state = { at: offset, line: 1 };
  const readLine = () => {
    const end = bytes.indexOf(LF, state.at);
    if (end < 0) throw { line: state.line, truncated: true };
    const line = bytes.subarray(state.at, end).toString('utf8');
    state.at = end + 1;
    state.line += 1;
    return line;
  };
  const opening = readLine();
  if (opening !== MAGIC) throw { line: 1 };
  const fields = {};
  const sealedParts = [bytes.subarray(offset, state.at)];
  for (const field of HEADER_FIELDS) {
    const start = state.at;
    const line = readLine();
    const prefix = `${field}: `;
    if (!line.startsWith(prefix)) throw { line: state.line - 1 };
    fields[field] = line.slice(prefix.length);
    if (field !== BLOCK_DIGEST_FIELD) sealedParts.push(bytes.subarray(start, state.at));
  }
  const separator = state.at;
  if (readLine() !== '') throw { line: state.line - 1 };
  sealedParts.push(bytes.subarray(separator, state.at));
  for (const field of ['section-bytes', 'index-bytes', 'rows']) {
    if (!COUNT.test(fields[field]) || !Number.isSafeInteger(Number(fields[field]))) {
      throw { line: HEADER_FIELDS.indexOf(field) + 2 };
    }
  }
  for (const field of ['section-sha256', BLOCK_DIGEST_FIELD]) {
    if (!HEX_DIGEST.test(fields[field])) throw { line: HEADER_FIELDS.indexOf(field) + 2 };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) throw { line: 2 };
  const readString = (field) => {
    try {
      const value = JSON.parse(fields[field]);
      if (typeof value === 'string') return value;
    } catch { /* The field's line is reported below. */ }
    throw { line: HEADER_FIELDS.indexOf(field) + 2 };
  };
  return { fields, bodyStart: state.at, sealedHeader: Buffer.concat(sealedParts),
    section: readString('section'), queuePath: readString('queue-path') };
};

const readIndex = (bytes) => {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== LF) return null;
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  const entries = lines.map((text) => {
    const cells = text.split('\t');
    if (cells.length !== INDEX_COLUMNS) return null;
    const [line, klass, key, title] = cells;
    if (!COUNT.test(line) || Number(line) < 1 || !Number.isSafeInteger(Number(line)) || !klass || !key || /\r/.test(text)) return null;
    return { line: Number(line), klass, id: key === KEYLESS ? null : key, title };
  });
  return entries.includes(null) ? null : entries;
};

const judgeBlock = (block) => Boolean(block.indexEntries
  && block.rowCount === block.indexEntries.length
  && hashBytes(block.sectionBytes).equals(block.sectionDigest)
  && sealBlock(block.sealedHeader, block.body).equals(block.blockDigest));

export const readArchive = (bytes) => {
  const archive = { bytes, blocks: [], intact: true, offset: 0, cause: null };
  const refuse = (cause, line) => Object.assign(archive, {
    intact: false, cause, line,
    problem: cause === 'foreign' ? `foreign archive grammar at line ${line}`
      : `archive not intact: block ${archive.blocks.length + 1} at byte offset ${archive.offset}; no key comparison performed`,
  });
  while (archive.offset < bytes.length) {
    const offset = archive.offset;
    const parsed = (() => {
      try { return readHeader(bytes, offset); }
      catch (error) {
        const recognised = bytes.subarray(offset, offset + Buffer.byteLength(MAGIC)).equals(Buffer.from(MAGIC));
        refuse(offset === 0 && !(recognised && error.truncated) ? 'foreign' : 'not-intact', error.line);
        return null;
      }
    })();
    if (!parsed) return archive;
    const { fields, bodyStart, sealedHeader, section, queuePath } = parsed;
    const sectionEnd = bodyStart + Number(fields['section-bytes']);
    const end = sectionEnd + Number(fields['index-bytes']);
    if (!Number.isSafeInteger(end) || end > bytes.length) return refuse('not-intact');
    const block = {
      date: fields.date, section, queuePath, offset, end, sealedHeader,
      sectionBytes: bytes.subarray(bodyStart, sectionEnd), indexBytes: bytes.subarray(sectionEnd, end),
      sectionDigest: Buffer.from(fields['section-sha256'], 'hex'),
      blockDigest: Buffer.from(fields[BLOCK_DIGEST_FIELD], 'hex'),
      rowCount: Number(fields.rows), body: bytes.subarray(bodyStart, end),
      indexEntries: readIndex(bytes.subarray(sectionEnd, end)),
    };
    if (!judgeBlock(block)) return refuse('not-intact');
    archive.blocks.push(block);
    archive.offset = end;
  }
  return archive;
};

export const judgeIntact = (archive) => archive.intact && archive.offset === archive.bytes.length
  && archive.blocks.every(judgeBlock);

export const appendBlock = (path, blockBytes) => {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const staged = openSync(temporary, 'wx', PRIVATE_MODE);
  try {
    writeFileSync(staged, blockBytes);
    fsyncSync(staged);
    const complete = readFileSync(temporary);
    if (!complete.equals(blockBytes)) throw fail(EXIT.refuse, `incomplete staged block for ${path}`);
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
      | constants.O_NOFOLLOW | constants.O_NONBLOCK, PRIVATE_MODE);
    try {
      if (!fstatSync(descriptor).isFile()) throw fail(EXIT.usage, `${path}: archive is not a regular file`);
      const written = writeSync(descriptor, complete);
      fsyncSync(descriptor);
      if (written !== complete.length) throw fail(EXIT.refuse, `${path}: partial archive append (${written} of ${complete.length} bytes)`);
    } finally { closeSync(descriptor); }
  } finally {
    try { closeSync(staged); }
    finally { unlinkSync(temporary); }
  }
};

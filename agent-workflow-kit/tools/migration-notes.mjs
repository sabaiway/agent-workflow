import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION } from './cheap-agents-read.mjs';
import { isDirectRun } from './direct-run.mjs';

const NOTES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const STAMP_PATH = 'docs/ai/.workflow-version';
const VERSION_PATTERN = /^[0-9]+[.][0-9]+[.][0-9]+$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const NOTE_SUFFIX = '.md';
const README_NAME = 'README.md';
const HEADLINE_PREFIX = '# ';
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const EXIT_ACCEPTED = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const formatDetail = (value) => String(value).replace(CONTROL_PATTERN, ' ');
const makeRefusal = (name, detail) => ({
  code: EXIT_REFUSED,
  stdout: '',
  stderr: `${name}: ${formatDetail(detail)}`,
});
const matchesEntire = (text, pattern) => text.match(pattern)?.[0] === text;
const parseVersion = (version) => version.split('.').map((field) => BigInt(field));
const compareVersions = (left, right) => {
  const rightFields = parseVersion(right);
  for (const [index, field] of parseVersion(left).entries()) {
    if (field < rightFields[index]) {
      return -1;
    }
    if (field > rightFields[index]) {
      return 1;
    }
  }
  return 0;
};

const judgeStamp = (stamp, head) => {
  if (!matchesEntire(stamp, VERSION_PATTERN)) {
    return makeRefusal('stamp-unparseable', 'expected one major.minor.patch version');
  }
  if (compareVersions(stamp, head) > 0) {
    return makeRefusal('stamp-above-head', `${stamp} is newer than ${head}; never downgrade`);
  }
  return null;
};

const shouldIgnore = (name) => name.startsWith('.') || !name.endsWith(NOTE_SUFFIX);
const parseNote = (entry) => {
  const stem = entry.name.slice(0, -NOTE_SUFFIX.length);
  const separator = stem.indexOf('-');
  const version = stem.slice(0, separator);
  const slug = stem.slice(separator + 1);
  const valid = separator > 0 && matchesEntire(version, VERSION_PATTERN) && matchesEntire(slug, SLUG_PATTERN);
  return { ...entry, version, valid };
};

const readHeadline = (text) => {
  const line = text.split(LF).find((candidate) => candidate.startsWith(HEADLINE_PREFIX));
  if (line === undefined) {
    return null;
  }
  const content = (line.endsWith(CR) ? line.slice(0, -CR.length) : line).slice(HEADLINE_PREFIX.length);
  return content.search(CONTROL_PATTERN) < 0 && content.trim() !== '' ? content.trim() : null;
};

const findDuplicate = (notes) => {
  const versions = new Set();
  for (const note of notes) {
    const key = parseVersion(note.version).join('.');
    if (versions.has(key)) {
      return note;
    }
    versions.add(key);
  }
  return null;
};

// The caller has trimmed and judged the stamp; main judges every stamp cell before reading the notes directory.
export const selectNotes = (stamp, entries, head) => {
  const candidates = entries.filter(({ name }) => !shouldIgnore(name));
  const unreadable = candidates.find(({ kind }) => kind === 'unreadable');
  if (unreadable) {
    return makeRefusal('notes-unreadable', `${unreadable.name}: ${unreadable.detail}`);
  }
  const parsed = candidates.map(parseNote);
  const invalid = parsed.find(({ kind, name, valid }) => kind !== 'file' || (name !== README_NAME && !valid));
  if (invalid) {
    return makeRefusal('notes-entry', invalid.name);
  }
  const notes = parsed.filter(({ name }) => name !== README_NAME);
  const aboveHead = notes.find(({ version }) => compareVersions(version, head) > 0);
  if (aboveHead) {
    return makeRefusal('note-above-head', `${aboveHead.name} is newer than ${head}`);
  }
  const duplicate = findDuplicate(notes);
  if (duplicate) {
    return makeRefusal('note-version-twice', duplicate.version);
  }
  const titled = notes.map((note) => ({ ...note, headline: readHeadline(note.text) }));
  const untitled = titled.find(({ headline }) => headline === null);
  if (untitled) {
    return makeRefusal('note-headline', untitled.name);
  }
  const selected = titled
    .filter(({ version }) => compareVersions(version, stamp) > 0 && compareVersions(version, head) <= 0)
    .sort((left, right) => compareVersions(left.version, right.version));
  const none = compareVersions(stamp, head) === 0
    ? `none: stamp ${stamp} equals head ${head}; no note applies`
    : `none: no notes newer than stamp ${stamp} through head ${head}`;
  const lines = selected.map(({ version, path, headline }) => `note ${version} ${path} :: ${headline}`);
  const ignored = entries.filter(({ name }) => shouldIgnore(name)).map(({ name }) => `ignored: ${formatDetail(name)}`);
  return {
    code: EXIT_ACCEPTED,
    stdout: lines.length > 0 ? lines.join(LF) : none,
    stderr: ignored.join(LF),
  };
};

const probePath = (path, fs) => {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) {
      return { kind: 'symlink' };
    }
    if (stat.isFile()) {
      return { kind: 'file' };
    }
    return { kind: stat.isDirectory() ? 'directory' : 'other' };
  } catch (error) {
    return { kind: error.code === 'ENOENT' ? 'absent' : 'unreadable', detail: error.message };
  }
};

const readStamp = (path, fs) => {
  const probe = probePath(path, fs);
  if (probe.kind === 'absent') {
    return { refusal: makeRefusal('stamp-absent', `${path}; use step 1 conservative re-bootstrap`) };
  }
  if (probe.kind !== 'file') {
    return { refusal: makeRefusal('stamp-unreadable', `${path}: ${probe.detail ?? probe.kind}`) };
  }
  try {
    return { text: fs.readFileSync(path, 'utf8') };
  } catch (error) {
    return { refusal: makeRefusal('stamp-unreadable', `${path}: ${error.message}`) };
  }
};

const readEntry = (notesDir, name, fs) => {
  const path = join(notesDir, name);
  if (shouldIgnore(name)) {
    return { name, path };
  }
  const probe = probePath(path, fs);
  if (probe.kind !== 'file' || name === README_NAME) {
    return { name, path, ...probe };
  }
  try {
    return { name, path, kind: 'file', text: fs.readFileSync(path, 'utf8') };
  } catch (error) {
    return { name, path, kind: 'unreadable', detail: error.message };
  }
};

const readNotes = (notesDir, fs) => {
  const probe = probePath(notesDir, fs);
  if (probe.kind === 'absent') {
    return { refusal: makeRefusal('notes-absent', notesDir) };
  }
  if (probe.kind !== 'directory') {
    return { refusal: makeRefusal('notes-unreadable', `${notesDir}: ${probe.detail ?? probe.kind}`) };
  }
  try {
    return { entries: fs.readdirSync(notesDir).map((name) => readEntry(notesDir, name, fs)) };
  } catch (error) {
    return { refusal: makeRefusal('notes-unreadable', `${notesDir}: ${error.message}`) };
  }
};

export const main = (argv, deps = {}) => {
  const validUsage = argv.length === 2 && argv[0] === '--cwd'
    && typeof argv[1] === 'string' && argv[1].trim() !== '' && !argv[1].startsWith('--');
  if (!validUsage) {
    return { code: EXIT_USAGE, stdout: '', stderr: 'usage: migration-notes.mjs --cwd <project>' };
  }
  const fs = {
    lstatSync: deps.lstatSync ?? lstatSync,
    readFileSync: deps.readFileSync ?? readFileSync,
    readdirSync: deps.readdirSync ?? readdirSync,
  };
  const stamp = readStamp(resolve(argv[1], STAMP_PATH), fs);
  if (stamp.refusal) {
    return stamp.refusal;
  }
  const stampText = stamp.text.trim();
  const stampRefusal = judgeStamp(stampText, EXPECTED_WORKFLOW_VERSION);
  if (stampRefusal) {
    return stampRefusal;
  }
  const notes = readNotes(resolve(deps.notesDir ?? NOTES_DIR), fs);
  return notes.refusal ?? selectNotes(stampText, notes.entries, EXPECTED_WORKFLOW_VERSION);
};

if (isDirectRun(import.meta.url)) {
  const result = await main(process.argv.slice(2));
  if (result.stdout) {
    console.log(result.stdout);
  }
  if (result.stderr) {
    console.error(result.stderr);
  }
  process.exit(result.code);
}

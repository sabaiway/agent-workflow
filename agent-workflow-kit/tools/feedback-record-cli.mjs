#!/usr/bin/env node
// Feedback-record filesystem and argv shell. Governing contract:
// docs/ai/specs/kit/feedback-triage.md.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { readFileBytesNoFollowCapped } from './fs-read-nofollow.mjs';
import { GIT_MAX_BUFFER, resolveGitLocation, stripGitLocationEnv, withGitPath } from './git-env.mjs';
import { assertScratchDestination, DEFAULT_MAX_PROMPT_BYTES, trimToBudget } from './grounding.mjs';
import { judgeAnchors, parseRecord, ratchetLine, REFUSALS, renderExcerpts, renderRows } from './feedback-record.mjs';

const RECORD_MAX_BYTES = 1024 * 1024;
export const EXCERPTS_FRAMING_RESERVE_BYTES = 4096;
const GATES_REL = 'docs/ai/gates.json';
const QUEUE_GATE_TOKEN = 'queue-audit-cli.mjs';
const MODE_FLAGS = Object.freeze(['--check', '--rows']);
const FATAL_PARSE_REFUSALS = Object.freeze(REFUSALS.slice(0, 4));
const FINDING_NAMES = Object.freeze({
  anchorPath: 'anchor-path', anchorDirty: 'anchor-dirty', gitLocation: 'git-location',
  headMismatch: 'head-mismatch', excerptsDestination: 'excerpts-destination',
  excerptsBudget: 'excerpts-budget', excerptsWrite: 'excerpts-write', exists: 'EEXIST',
});
const GIT_ENV_LOCALE = 'C';
const GIT_OPTIONAL_LOCKS_DISABLED = '0';
const EXCLUSIVE_CREATE_FLAG = 'wx';
const EMPTY_ANSWER_OK = new Set(['status', 'ls-files']);
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const readValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (value === undefined || value === '' || value.startsWith('--')) throw fail(2, `${flag} takes a value`);
  return value;
};

const parseArgv = (argv) => {
  const options = { mode: null, record: null, excerpts: null };
  const seen = new Set();
  for (const [index, arg] of argv.entries()) {
    if (seen.has(index)) continue;
    if (MODE_FLAGS.includes(arg)) {
      if (options.mode !== null) throw fail(2, 'name exactly one of --check or --rows');
      options.mode = arg.slice(2);
      options.record = readValue(argv, index, arg);
      seen.add(index + 1);
    } else if (arg === '--excerpts') {
      if (options.excerpts !== null) throw fail(2, '--excerpts was given twice');
      options.excerpts = readValue(argv, index, arg);
      seen.add(index + 1);
    } else throw fail(2, `unknown argument: ${arg}`);
  }
  if (options.mode === null) throw fail(2, 'one of --check or --rows is required');
  if (options.excerpts !== null && options.mode !== 'check') throw fail(2, '--excerpts is available only with --check');
  return options;
};

const decodeBytes = (bytes) => {
  try { return FATAL_UTF8.decode(bytes); }
  catch { return null; }
};
const countLines = (text) => text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const getHeadLine = (text) => Math.max(1, text.split('\n').findIndex((line) => line.replace(/\r$/u, '').startsWith('Head: ')) + 1);
const formatFinding = (record, finding) =>
  `${String(record).replace(/[\r\n]+/gu, ' ')}:${finding.line}: ${finding.name}: ${String(finding.message).replace(/[\r\n]+/gu, ' ')}`;
const reportFindings = (record, findings, error) => {
  for (const finding of findings) error(formatFinding(record, finding));
  return findings.length === 0 ? 0 : 1;
};

const readRecord = (recordPath, io) => {
  const result = readFileBytesNoFollowCapped(recordPath, RECORD_MAX_BYTES, io);
  if (result.outcome !== 'ok') {
    const reason = result.outcome === 'over-cap' ? `over the ${RECORD_MAX_BYTES}-byte cap` : result.code ?? result.className ?? result.outcome;
    throw fail(2, `cannot read regular feedback record ${recordPath}: ${reason}`);
  }
  const text = decodeBytes(result.bytes);
  if (text === null) throw fail(2, `cannot read regular feedback record ${recordPath}: invalid UTF-8`);
  return { bytes: result.bytes, text };
};

const isContained = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const inspectAnchors = (claims, cwd, io) => {
  const anchors = claims.flatMap((claim) => claim.anchors);
  const paths = [...new Set(anchors.map((anchor) => anchor.path))];
  const facts = Object.create(null);
  const texts = Object.create(null);
  const targets = Object.create(null);
  const findings = [];
  const resolvedRoot = (() => {
    try { return { root: realpathSync(cwd), reason: null }; }
    catch (err) { return { root: null, reason: err?.code ?? err?.message ?? String(err) }; }
  })();
  if (paths.length === 0) return { anchors, facts, texts, targets, paths, findings, root: resolvedRoot.root };
  if (resolvedRoot.root === null) {
    for (const path of paths) {
      facts[path] = { kind: 'regular', lines: Number.MAX_SAFE_INTEGER };
      for (const anchor of anchors.filter((candidate) => candidate.path === path)) {
        findings.push({ name: FINDING_NAMES.anchorPath, line: anchor.line, path, message: `the working directory cannot be resolved (${resolvedRoot.reason})` });
      }
    }
    return { anchors, facts, texts, targets, paths, findings, root: resolvedRoot.root };
  }
  for (const path of paths) {
    const occurrences = anchors.filter((anchor) => anchor.path === path);
    const full = resolve(cwd, path);
    const parent = (() => {
      try { return realpathSync(dirname(full)); }
      catch { return null; }
    })();
    if (parent === null) {
      facts[path] = { kind: 'absent' };
      continue;
    }
    const target = join(parent, basename(full));
    if (!isContained(resolvedRoot.root, target)) {
      facts[path] = { kind: 'regular', lines: Number.MAX_SAFE_INTEGER };
      for (const anchor of occurrences) findings.push({ name: FINDING_NAMES.anchorPath, line: anchor.line, path, message: `anchor resolves outside the working tree: ${path}` });
      continue;
    }
    const result = readFileBytesNoFollowCapped(target, RECORD_MAX_BYTES, io);
    if (result.outcome === 'absent' || result.outcome === 'foreign') {
      facts[path] = { kind: result.outcome === 'absent' ? 'absent' : 'other' };
    } else if (result.outcome === 'over-cap' || result.outcome === 'error') {
      const reason = result.outcome === 'over-cap' ? `over the ${RECORD_MAX_BYTES}-byte cap` : result.code ?? 'read failed';
      facts[path] = { kind: 'unreadable', reason };
    } else {
      const text = decodeBytes(result.bytes);
      if (text === null) facts[path] = { kind: 'unreadable', reason: 'invalid UTF-8' };
      else {
        facts[path] = { kind: 'regular', lines: countLines(text) };
        texts[path] = text;
        targets[path] = target;
      }
    }
  }
  return { anchors, facts, texts, targets, paths, findings, root: resolvedRoot.root };
};

const runGit = (spawn, cwd, env, args) => {
  const options = {
    cwd, env: withGitPath({
      ...stripGitLocationEnv(env), LC_ALL: GIT_ENV_LOCALE, GIT_OPTIONAL_LOCKS: GIT_OPTIONAL_LOCKS_DISABLED,
    }),
    encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
  };
  const attempted = (() => {
    try { return { result: spawn('git', args, options), error: null }; }
    catch (err) { return { result: null, error: `git threw synchronously (${err?.message ?? err})` }; }
  })();
  if (attempted.error !== null) return { error: attempted.error };
  const result = attempted.result;
  if (result == null || typeof result !== 'object') return { error: 'the git runner returned no result' };
  if (result.error) return { error: `git could not run (${result.error.code ?? result.error.message ?? result.error})` };
  if (result.signal) return { error: `git ${args[0]} was killed by ${result.signal}` };
  const stderr = String(result.stderr ?? '').trim();
  if (result.status !== 0) return { error: `git ${args[0]} exited ${result.status}${stderr ? ` (${stderr})` : ''}` };
  const stdout = String(result.stdout ?? '');
  if (stdout.length === 0 && !EMPTY_ANSWER_OK.has(args[0])) return { error: `git ${args[0]} answered nothing` };
  return { stdout };
};

const parseDirtyPaths = (stdout) => stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3));

const inspectGit = ({ cwd, env, spawn, head, headLine, anchors }) => {
  const findings = [];
  const location = resolveGitLocation(cwd, { spawn, env });
  if (location.state !== 'work-tree') {
    return { findings: [{ name: FINDING_NAMES.gitLocation, line: headLine, message: `${location.state}: "${location.cause ?? 'unknown cause'}"` }], top: null };
  }
  const checkout = runGit(spawn, cwd, env, ['rev-parse', 'HEAD']);
  if (checkout.error) return { findings: [{ name: FINDING_NAMES.gitLocation, line: headLine, message: checkout.error }], top: null };
  const actualHead = checkout.stdout.trim();
  if (actualHead === '') findings.push({ name: FINDING_NAMES.gitLocation, line: headLine, message: 'git rev-parse HEAD answered nothing' });
  else if (actualHead.toLowerCase() !== head.toLowerCase()) findings.push({ name: FINDING_NAMES.headMismatch, line: headLine, message: `record head ${head} does not match checkout head ${actualHead}` });
  const resolvedTop = (() => {
    try { return { value: realpathSync(location.top), error: null }; }
    catch (err) { return { value: null, error: err?.code ?? err?.message ?? String(err) }; }
  })();
  if (resolvedTop.error !== null) {
    return { findings: [...findings, { name: FINDING_NAMES.gitLocation, line: headLine, message: `the work-tree top cannot be resolved (${resolvedTop.error})` }], top: location.top };
  }
  const top = resolvedTop.value;
  const rels = Object.fromEntries(Object.keys(anchors.targets).map((path) => [
    path, relative(top, resolve(anchors.root, path)).split(sep).join('/'),
  ]));
  if (Object.keys(rels).length === 0) return { findings, top: location.top };
  const pathspecs = Object.values(rels).map((rel) => `:(literal)${rel}`);
  const status = runGit(spawn, location.top, env, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=traditional', '--', ...pathspecs]);
  if (status.error) return { findings: [...findings, { name: FINDING_NAMES.gitLocation, line: headLine, message: `${FINDING_NAMES.anchorDirty} cannot be judged: ${status.error}` }], top: location.top };
  const dirty = new Set(parseDirtyPaths(status.stdout));
  const listing = runGit(spawn, location.top, env, ['ls-files', '-v', '-z', '--', ...pathspecs]);
  if (listing.error) return { findings: [...findings, { name: FINDING_NAMES.gitLocation, line: headLine, message: `${FINDING_NAMES.anchorDirty} cannot be judged: ${listing.error}` }], top: location.top };
  const listed = new Map();
  for (const entry of listing.stdout.split('\0').filter(Boolean)) {
    listed.set(entry.slice(2), entry[0]);
  }
  for (const path of Object.keys(rels)) {
    const rel = rels[path];
    const tag = listed.get(rel);
    const message = tag === undefined
      ? `anchor is not tracked at the stamped HEAD: ${path}`
      : tag !== 'H'
        ? `the index conceals the working tree for ${path} (ls-files tag ${tag})`
        : dirty.has(rel)
          ? `anchor differs from the stamped HEAD: ${path}`
          : null;
    if (message === null) continue;
    for (const anchor of anchors.anchors.filter((candidate) => candidate.path === path)) {
      findings.push({ name: FINDING_NAMES.anchorDirty, line: anchor.line, path, message });
    }
  }
  return { findings, top: location.top };
};

const readRatchet = (cwd, rows) => {
  const path = join(cwd, GATES_REL);
  const parsed = (() => {
    try { return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }; }
    catch (err) { return { value: null, error: err }; }
  })();
  if (parsed.error?.code === 'ENOENT') return `ratchet: ${GATES_REL} is absent`;
  if (parsed.error) return `ratchet: ${GATES_REL} cannot be read (${parsed.error.message})`;
  const gate = Array.isArray(parsed.value?.gates)
    ? parsed.value.gates.find((entry) => typeof entry?.cmd === 'string' && entry.cmd.includes(QUEUE_GATE_TOKEN))
    : null;
  return gate ? ratchetLine(gate.cmd, rows) : `ratchet: gate carrying ${QUEUE_GATE_TOKEN} is absent`;
};

const writeExcerpts = ({ options, cwd, recordBytes, anchors, error }) => {
  const destination = (() => {
    try { return { value: assertScratchDestination(options.excerpts, cwd), error: null }; }
    catch (err) { return { value: null, error: err }; }
  })();
  if (destination.error) {
    error(`${FINDING_NAMES.excerptsDestination}: ${String(destination.error.message ?? destination.error).replace(/^--out/u, '--excerpts')}`);
    return 2;
  }
  const budget = DEFAULT_MAX_PROMPT_BYTES - recordBytes - EXCERPTS_FRAMING_RESERVE_BYTES;
  if (budget <= 0) return reportFindings(options.record, [{ name: FINDING_NAMES.excerptsBudget, line: 1, message: 'the record leaves no byte budget for excerpts' }], error);
  const payload = renderExcerpts(anchors.anchors, anchors.texts, budget);
  const trimmed = trimToBudget(payload, budget);
  if (trimmed.trimmedBytes > 0 && !/^[^\n]/u.test(trimmed.text)) {
    return reportFindings(options.record, [{ name: FINDING_NAMES.excerptsBudget, line: 1, message: `the ${budget}-byte budget leaves no excerpt line beside the trim marker` }], error);
  }
  const written = (() => {
    try { writeFileSync(destination.value.path, trimmed.text, { flag: EXCLUSIVE_CREATE_FLAG }); return null; }
    catch (err) { return err; }
  })();
  if (written === null) return 0;
  const name = written.code === FINDING_NAMES.exists ? FINDING_NAMES.exists : FINDING_NAMES.excerptsWrite;
  return reportFindings(options.record, [{ name, line: 1, message: written.message ?? String(written) }], error);
};

export const main = (argv, deps = {}) => {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? spawnSync;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const io = deps.io ?? {};
  const now = deps.now ?? (() => new Date());
  const options = (() => {
    try { return { value: parseArgv(argv), error: null }; }
    catch (err) { return { value: null, error: err }; }
  })();
  if (options.error) { error(options.error.message); return options.error.exitCode ?? 2; }
  const loaded = (() => {
    try { return { value: readRecord(resolve(cwd, options.value.record), io), error: null }; }
    catch (err) { return { value: null, error: err }; }
  })();
  if (loaded.error) { error(loaded.error.message); return loaded.error.exitCode ?? 2; }
  const parsed = parseRecord(loaded.value.text);
  if (parsed.refusals.some((finding) => FATAL_PARSE_REFUSALS.includes(finding.name))) {
    return reportFindings(options.value.record, parsed.refusals, error);
  }
  const anchors = inspectAnchors(parsed.claims, cwd, io);
  const git = inspectGit({ cwd, env, spawn, head: parsed.head, headLine: getHeadLine(loaded.value.text), anchors });
  const findings = [
    ...parsed.refusals,
    ...anchors.findings,
    ...judgeAnchors(parsed.claims, anchors.facts),
    ...git.findings,
  ];
  if (reportFindings(options.value.record, findings, error) !== 0) return 1;
  if (options.value.mode === 'rows') {
    const rows = renderRows(parsed, { date: now().toISOString().slice(0, 10), recordPath: options.value.record });
    for (const row of rows) log(row);
    log(readRatchet(git.top, rows));
  }
  if (options.value.excerpts !== null) {
    return writeExcerpts({ options: options.value, cwd, recordBytes: loaded.value.bytes.length, anchors, error });
  }
  return 0;
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));

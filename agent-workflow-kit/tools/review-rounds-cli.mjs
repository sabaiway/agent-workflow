#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDirectRun } from './direct-run.mjs';
import { readReceipts, resolveReceiptsPath } from './core-evidence.mjs';
import { loadConfig } from './orchestration-config.mjs';
import { ACTIVITIES, composeReadiness, requiredBackendsForConfiguredRecipe } from './recipes.mjs';
import { groupRounds, renderRounds } from './review-rounds.mjs';

const REVIEW_ACTIVITIES = new Set(Object.entries(ACTIVITIES).filter(([, def]) => Object.hasOwn(def.slots, 'review')).map(([name]) => name));

const assertArtifactPathCarryable = (value) => {
  if (value.includes('"')) throw new Error('artifact path contains a double quote byte, which the receipt encoder cannot carry');
  if (value.includes('\\')) throw new Error('artifact path contains a backslash byte, which the receipt encoder cannot carry');
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('artifact path contains a control byte, which the receipt encoder cannot carry');
};

const gitTopLevel = (cwd, run = spawnSync) => {
  const result = run('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.replace(/\r?\n$/u, '') : null;
};

export const normalizeArtifactPath = (path, { cwd = process.cwd(), run = spawnSync, realpath = realpathSync } = {}) => {
  assertArtifactPathCarryable(path);
  const absolute = realpath(resolve(cwd, path));
  const top = gitTopLevel(cwd, run);
  const root = top === null ? null : realpath(top);
  const rel = root === null ? null : relative(root, absolute);
  const contained = rel !== null && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const normalized = contained ? rel.split(sep).join('/') : absolute.split(sep).join('/');
  assertArtifactPathCarryable(normalized);
  return normalized;
};

const parseArgs = (argv) => {
  const values = { activity: 'plan-authoring', artifact: null };
  for (const [index, arg] of argv.entries()) {
    if (arg === '--artifact' || arg === '--activity') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--artifact') values.artifact = value;
      else values.activity = value;
      continue;
    }
    if (index > 0 && (argv[index - 1] === '--artifact' || argv[index - 1] === '--activity')) continue;
    throw new Error(`unknown argument: ${arg}`);
  }
  if (values.artifact === null) throw new Error('--artifact needs a <path>');
  if (!REVIEW_ACTIVITIES.has(values.activity)) throw new Error(`--activity must be one of ${[...REVIEW_ACTIVITIES].join(', ')}, got ${values.activity}`);
  return values;
};

// Every refusal exits 2: usage, an unreadable store, a malformed config, a detection failure.
export const main = (argv, deps = {}) => {
  try {
    const cwd = deps.cwd ?? process.cwd();
    const env = deps.env ?? process.env;
    const { artifact, activity } = parseArgs(argv);
    const artifactPath = normalizeArtifactPath(artifact, { cwd });
    const root = gitTopLevel(cwd) ?? cwd;
    const { config } = loadConfig(root);
    const detection = { failed: false };
    const readiness = config?.[activity]?.review == null
      ? composeReadiness(root, { onDetectError: () => { detection.failed = true; }, ...(deps.readinessDeps ?? {}) })
      : [];
    const obligation = requiredBackendsForConfiguredRecipe({ config, readiness, detectionFailed: detection.failed, activity });
    if (obligation.unknowable) throw new Error('backend detection failed — the review obligation is unknowable');
    const receiptsPath = resolveReceiptsPath(root, env);
    if (receiptsPath === null) throw new Error('the review receipts store cannot be resolved (not a git work tree and AW_REVIEW_RECEIPTS is unset)');
    const read = readReceipts(receiptsPath);
    if (read.readError !== undefined) throw new Error(`the review receipts store is unreadable: ${read.readError}`);
    const selected = read.receipts.filter((receipt) => receipt.artifactPath === artifactPath);
    const pathless = read.receipts.filter((receipt) => ['plan', 'diff'].includes(receipt.artifact) && !Object.hasOwn(receipt, 'artifactPath')).length;
    const grouped = groupRounds(selected, obligation);
    return {
      code: 0,
      stdout: renderRounds({ ...grouped, obligation, artifactPath, pathless, malformed: read.malformed }),
      stderr: '',
    };
  } catch (err) {
    return { code: 2, stdout: '', stderr: `review-rounds: ${err.message}` };
  }
};

if (isDirectRun(import.meta.url)) {
  const result = main(process.argv.slice(2));
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.code;
}

#!/usr/bin/env node
// specs-scale-probe.mjs — the D-scale gate of the spec layer (repo-only tooling, never shipped).
//
// Builds a VALID 30-per-folder spec tree of N specs under a temp root, runs the deployed navigator
// generator once untimed (--write-index), then times BOTH pre-commit hook runs (check-docs-size.mjs
// + --check-index) per trial and judges the MEDIAN of the per-trial sums against the budget.
//
//   node scripts/testing/specs-scale-probe.mjs --n 1000 --budget-ms 1500 [--trials 3]
//
// Exit 0 within budget · 1 over budget (blocks the release) · 2 usage, or a child run that did not
// exit 0 (a tree the hook refuses measures nothing).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHECKER = resolve(HERE, '..', 'check-docs-size.mjs');
export const FAN_OUT = 30;
export const STORE_REL = join('docs', 'ai', 'specs');
const DEFAULT_TRIALS = 3;
const USAGE = 'usage: specs-scale-probe.mjs --n <specs> --budget-ms <ms> [--trials <k>]';

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

const pad = (n, width) => String(n).padStart(width, '0');
const range = (n) => Array.from({ length: n }, (_, i) => i);
const frontmatter = (kind, maxLines, extra = '') =>
  `---\ntype: spec\nlastUpdated: 2026-08-23\nscope: permanent\nstaleAfter: 90d\nowner: none\nmaxLines: ${maxLines}\nkind: ${kind}\n${extra}---\n`;
const indexDoc = (title, children, preamble = '') => `${frontmatter('index', 80)}\n# ${title}\n${preamble}\n## Children\n\n${children.join('\n')}\n`;
const specDoc = (slug) =>
  `${frontmatter('spec', 150, 'status: live\nrevision: 1\n')}\n# Spec: ${slug}\n\n## Contract\n\nA synthetic contract for scale measurement.\n\n## Scenarios\n\n- S1 happy path :: test/${slug}.test.mjs :: spec:${slug}/S1\n\n## Out of scope\n\n- Everything else\n\n## Module\n\n- src/${slug}/\n`;
const UPLINK = '\n> Up: [technical_specification.md](../technical_specification.md)\n';

// The tree plan: leaves hold up to FAN_OUT specs, groups up to FAN_OUT leaves, the root lists the
// groups — every index stays within the fan-out rule for N <= FAN_OUT^3.
export const planTree = (n) => {
  const leafCount = Math.ceil(n / FAN_OUT);
  const groupCount = Math.ceil(leafCount / FAN_OUT);
  if (!Number.isInteger(n) || n < 1 || groupCount > FAN_OUT) throw fail(2, `--n must be 1..${FAN_OUT ** 3} (got ${n})`);
  const specName = (i) => `s${pad(i + 1, 5)}`;
  const leafName = (l) => `leaf-${pad(l + 1, 3)}`;
  const groupName = (g) => `group-${pad(g + 1, 2)}`;
  const files = [{ rel: 'index.md', text: indexDoc('Specs', range(groupCount).map((g) => `- [${groupName(g)}](./${groupName(g)}/index.md)`), UPLINK) }];
  for (const g of range(groupCount)) {
    const leaves = range(leafCount).slice(g * FAN_OUT, (g + 1) * FAN_OUT);
    files.push({ rel: `${groupName(g)}/index.md`, text: indexDoc(groupName(g), leaves.map((l) => `- [${leafName(l)}](./${leafName(l)}/index.md)`)) });
    for (const l of leaves) {
      const specs = range(n).slice(l * FAN_OUT, (l + 1) * FAN_OUT);
      files.push({ rel: `${groupName(g)}/${leafName(l)}/index.md`, text: indexDoc(leafName(l), specs.map((i) => `- [${specName(i)}](./${specName(i)}.md)`)) });
      for (const i of specs) files.push({ rel: `${groupName(g)}/${leafName(l)}/${specName(i)}.md`, text: specDoc(specName(i)) });
    }
  }
  return files;
};

export const buildTree = (root, n) => {
  const files = planTree(n);
  for (const { rel, text } of files) {
    const path = join(root, STORE_REL, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return files.length;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const runChild = (spawn, checker, args, label) => {
  const result = spawn(process.execPath, [checker, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw fail(2, `${label} exited ${result.status ?? 'null'} — nothing measured\n${(result.stderr ?? '').trim()}`);
  }
};

// The measurement: build, one untimed --write-index, then `trials` timed trials of both hook runs.
export const runProbe = ({ n, budgetMs, trials = DEFAULT_TRIALS, checker = CHECKER, spawn = spawnSync, now = performance.now.bind(performance) }) => {
  const root = mkdtempSync(join(tmpdir(), 'specs-scale-'));
  try {
    const files = buildTree(root, n);
    const rootArg = `--root=${root}`;
    runChild(spawn, checker, ['--write-index', rootArg], '--write-index');
    const trialsMs = range(trials).map(() => {
      const start = now();
      runChild(spawn, checker, [rootArg], 'check-docs-size');
      runChild(spawn, checker, ['--check-index', rootArg], '--check-index');
      return now() - start;
    });
    const medianMs = median(trialsMs);
    return { n, files, trialsMs, medianMs, budgetMs, withinBudget: medianMs <= budgetMs };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const parseArgs = (argv) => {
  const opts = { n: null, budgetMs: null, trials: DEFAULT_TRIALS };
  const take = (i, name) => {
    const value = Number(argv[i + 1]);
    if (!Number.isFinite(value)) throw fail(2, `${name} needs a number\n${USAGE}`);
    return value;
  };
  for (const [i, arg] of argv.entries()) {
    if (arg === '--n') opts.n = take(i, arg);
    else if (arg === '--budget-ms') opts.budgetMs = take(i, arg);
    else if (arg === '--trials') opts.trials = take(i, arg);
    else if (arg.startsWith('--')) throw fail(2, `unknown argument "${arg}"\n${USAGE}`);
  }
  if (opts.n === null || opts.budgetMs === null) throw fail(2, USAGE);
  if (!Number.isInteger(opts.trials) || opts.trials < 1) throw fail(2, '--trials must be a positive integer');
  return opts;
};

export const main = (argv, deps = {}) => {
  const { log = console.log, logError = console.error, ...probeDeps } = deps;
  try {
    const opts = parseArgs(argv);
    const result = runProbe({ ...opts, ...probeDeps });
    const verdict = result.withinBudget ? 'OK' : 'OVER BUDGET';
    log(`specs-scale-probe: n=${result.n} files=${result.files} trials=${result.trialsMs.map((ms) => Math.round(ms)).join('/')}ms median=${Math.round(result.medianMs)}ms budget=${result.budgetMs}ms -> ${verdict}`);
    return result.withinBudget ? 0 : 1;
  } catch (err) {
    logError(`[specs-scale-probe] ${err.message}`);
    return err.exitCode ?? 2;
  }
};

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exitCode = main(process.argv.slice(2));

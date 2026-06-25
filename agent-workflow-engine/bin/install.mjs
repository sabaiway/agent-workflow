#!/usr/bin/env node
// One-shot installer for @sabaiway/agent-workflow-engine.
//
//   npx @sabaiway/agent-workflow-engine init
//
// Copies the methodology canon into the canonical skill home
// (~/.claude/skills/agent-workflow-engine, override with --dir or
// AGENT_WORKFLOW_ENGINE_DIR). Re-running refreshes the canon to this package's
// version — that is how you update the installed canon:
//
//   npx @sabaiway/agent-workflow-engine@latest init
//
// The engine is the methodology canon the family kit builds on; it is content,
// not a project deploy and not a model-invoked skill — there is nothing to "run"
// inside an agent.
//
// No telemetry, no phone-home. Dependency-free, Node >= 18.

import { readFile, mkdir, readdir, copyFile, lstat, readlink, symlink } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

// The deployable skill = everything except the npm wrapper (package.json, bin/).
// Enumerated explicitly (mirrors package.json "files") so a missing payload entry
// is a loud failure, not a silent partial install.
const PAYLOAD = [
  'SKILL.md',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'capability.json',
  'references',
];

const tildify = (path) => path.replace(homedir(), '~');

const readVersion = async () => {
  try {
    const pkg = JSON.parse(await readFile(resolve(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

// lstat without following symlinks; null when the path does not exist. Using lstat (not
// existsSync, which FOLLOWS symlinks and so reports a *dangling* symlink as absent) is what
// makes the guard below catch a dangling destination symlink too.
const lstatNoFollow = (path) => {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err; // EACCES/EIO etc. must NOT fail open (be read as "not a symlink")
  }
};

// Symlink-traversal guard: refuse to write *through* any symlink at or above `dest`
// within `root`. Walks `root` plus each existing path component down to `dest`; if the
// root, an intermediate dir, or the leaf is a symlink (including a dangling one), a copy
// could escape the target — STOP rather than follow it. Also refuses a dest outside `root`.
const assertContainedRealPath = (root, dest) => {
  const rel = relative(root, dest);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`[agent-workflow-engine] refusing to write outside the target dir: ${dest}`);
  }
  if (lstatNoFollow(root)?.isSymbolicLink()) {
    throw new Error(`[agent-workflow-engine] refusing to install into a symlinked target dir: ${root}`);
  }
  const walk = (acc, part) => {
    const cur = join(acc, part);
    if (lstatNoFollow(cur)?.isSymbolicLink()) {
      throw new Error(
        `[agent-workflow-engine] refusing to write through a symlink at ${cur} (would escape ${root}).`,
      );
    }
    return cur;
  };
  rel.split(sep).filter(Boolean).reduce(walk, root);
};

const copyRecursive = async (src, dest, root) => {
  assertContainedRealPath(root, dest); // never write through a dest symlink (root/intermediate/leaf)
  const stat = await lstat(src);
  if (stat.isSymbolicLink()) {
    if (existsSync(dest)) return; // additive: never delete/replace an existing entry
    const linkTarget = await readlink(src);
    await symlink(linkTarget, dest);
  } else if (stat.isDirectory()) {
    await mkdir(dest, { recursive: true });
    const entries = await readdir(src);
    await Promise.all(entries.map((entry) => copyRecursive(join(src, entry), join(dest, entry), root)));
  } else {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
};

const parseArgs = (argv) => {
  const dirFlag = argv.indexOf('--dir');
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    dir: dirFlag >= 0 ? argv[dirFlag + 1] : undefined,
  };
};

const resolveTarget = (dirArg) => {
  if (dirArg) return resolve(dirArg);
  if (process.env.AGENT_WORKFLOW_ENGINE_DIR) return resolve(process.env.AGENT_WORKFLOW_ENGINE_DIR);
  return resolve(homedir(), '.claude/skills/agent-workflow-engine');
};

const printHelp = (version) => {
  console.log(`agent-workflow-engine ${version}

Usage:
  npx @sabaiway/agent-workflow-engine init [--dir <path>]
  npx @sabaiway/agent-workflow-engine --version
  npx @sabaiway/agent-workflow-engine --help

Installs/refreshes the methodology canon at ~/.claude/skills/agent-workflow-engine
  (override with --dir <path> or AGENT_WORKFLOW_ENGINE_DIR). init is additive —
  it never deletes your files and never writes through a symlink.

The engine is the methodology canon the family kit builds on — it is content, not a
project deploy and not a model-invoked skill, so there is nothing to run inside an agent.
Re-run this command to update the installed canon:
  npx @sabaiway/agent-workflow-engine@latest init`);
};

const main = async () => {
  const version = await readVersion();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return printHelp(version);
  if (args.version) return console.log(version);

  const missing = PAYLOAD.filter((entry) => !existsSync(resolve(PKG_ROOT, entry)));
  if (missing.includes('SKILL.md')) {
    console.error('[agent-workflow-engine] package payload missing (no SKILL.md) — corrupt install?');
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`[agent-workflow-engine] package payload incomplete — missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  const target = resolveTarget(args.dir);
  const wasPresent = existsSync(resolve(target, 'SKILL.md'));
  // If the target dir itself is a symlink (incl. dangling), refuse before writing through it.
  // (copyRecursive re-checks per entry; this fails fast with a clear message.)
  if (lstatNoFollow(target)?.isSymbolicLink()) {
    console.error(`[agent-workflow-engine] target dir is a symlink — refusing to write through it: ${tildify(target)}`);
    process.exit(1);
  }
  await mkdir(target, { recursive: true });
  await Promise.all(
    PAYLOAD.map((entry) => copyRecursive(resolve(PKG_ROOT, entry), resolve(target, entry), target)),
  );
  console.log(
    `[agent-workflow-engine] ${wasPresent ? 'updated the canon to' : 'installed'} v${version} -> ${tildify(target)}`,
  );

  console.log(`
This installed the methodology canon at ${tildify(target)}. The engine is content the
family kit builds on — there is nothing to run inside an agent.
To update it later, re-run:  npx @sabaiway/agent-workflow-engine@latest init`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

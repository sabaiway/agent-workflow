#!/usr/bin/env node
// One-shot installer for @sabaiway/agent-workflow-memory.
//
//   npx @sabaiway/agent-workflow-memory init
//
// Copies the memory substrate into the canonical skill home
// (~/.claude/skills/agent-workflow-memory, override with --dir or
// AGENT_WORKFLOW_MEMORY_DIR). Re-running refreshes the skill to this package's
// version — that is how you upgrade the *skill files* themselves:
//
//   npx @sabaiway/agent-workflow-memory@latest init
//
// That is distinct from `/agent-workflow-memory upgrade`, which migrates a
// *project's* docs/ai deployment — see README "Use".
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
  'scripts',
  'migrations',
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
    throw new Error(`[agent-workflow-memory] refusing to write outside the target dir: ${dest}`);
  }
  if (lstatNoFollow(root)?.isSymbolicLink()) {
    throw new Error(`[agent-workflow-memory] refusing to install into a symlinked target dir: ${root}`);
  }
  const walk = (acc, part) => {
    const cur = join(acc, part);
    if (lstatNoFollow(cur)?.isSymbolicLink()) {
      throw new Error(
        `[agent-workflow-memory] refusing to write through a symlink at ${cur} (would escape ${root}).`,
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
  if (process.env.AGENT_WORKFLOW_MEMORY_DIR) return resolve(process.env.AGENT_WORKFLOW_MEMORY_DIR);
  return resolve(homedir(), '.claude/skills/agent-workflow-memory');
};

const printHelp = (version) => {
  console.log(`agent-workflow-memory ${version}

Usage:
  npx @sabaiway/agent-workflow-memory init [--dir <path>]
  npx @sabaiway/agent-workflow-memory --version
  npx @sabaiway/agent-workflow-memory --help

Installs/refreshes the memory substrate at ~/.claude/skills/agent-workflow-memory
  (override with --dir <path> or AGENT_WORKFLOW_MEMORY_DIR). init is additive —
  it never deletes your settings and never writes through a symlink.

After install, invoke the skill in your agent, inside a project:
  first time in the project  ->  /agent-workflow-memory
  project already has it     ->  /agent-workflow-memory upgrade

Re-running this npx command updates the skill's own files; /agent-workflow-memory
upgrade then migrates a project's deployment to that version.`);
};

const main = async () => {
  const version = await readVersion();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return printHelp(version);
  if (args.version) return console.log(version);

  const missing = PAYLOAD.filter((entry) => !existsSync(resolve(PKG_ROOT, entry)));
  if (missing.includes('SKILL.md')) {
    console.error('[agent-workflow-memory] package payload missing (no SKILL.md) — corrupt install?');
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`[agent-workflow-memory] package payload incomplete — missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  const target = resolveTarget(args.dir);
  const wasPresent = existsSync(resolve(target, 'SKILL.md'));
  // If the target dir itself is a symlink (incl. dangling), refuse before writing through it.
  // (copyRecursive re-checks per entry; this fails fast with a clear message.)
  if (lstatNoFollow(target)?.isSymbolicLink()) {
    console.error(`[agent-workflow-memory] target dir is a symlink — refusing to write through it: ${tildify(target)}`);
    process.exit(1);
  }
  await mkdir(target, { recursive: true });
  await Promise.all(
    PAYLOAD.map((entry) => copyRecursive(resolve(PKG_ROOT, entry), resolve(target, entry), target)),
  );
  console.log(
    `[agent-workflow-memory] ${wasPresent ? 'updated the substrate to' : 'installed'} v${version} -> ${tildify(target)}`,
  );

  console.log(`
Next — open your agent inside a project and run the skill:
  • first time in this project  ->  /agent-workflow-memory
  • project already has it       ->  /agent-workflow-memory upgrade

This command only installs/updates the skill itself (in ${tildify(target)}).
To update it later, re-run:  npx @sabaiway/agent-workflow-memory@latest init`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

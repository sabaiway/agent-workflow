#!/usr/bin/env node
// One-shot installer for @sabaiway/agent-workflow-engine.
//
//   npx @sabaiway/agent-workflow-engine@latest init
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
import { existsSync, lstatSync, realpathSync } from 'node:fs';
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

// Collapse only a LEADING homedir() to "~" — anchored at the string start (boundary-checked with
// `sep`), never a mid-path occurrence. A naive `path.replace(homedir(), '~')` would rewrite the
// first match anywhere in the path (Issue-004). Exported so the regression can pin it in-process.
export const tildify = (path) =>
  path === homedir() ? '~' : path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path;

const readVersion = async () => {
  try {
    const pkg = JSON.parse(await readFile(resolve(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

// Never-downgrade gate helpers (D3 / AD-012) — cloned from the kit installer so a bare `npx … init`
// serving an OLDER cached build cannot overwrite a NEWER installed canon. Dependency-free semver:
// parse the leading x.y.z (prerelease/build ignored). compareSemver → -1 | 0 | 1, or null when
// either side is unparseable (a legacy install predating any stamp → no gate).
const parseSemver = (str) => {
  const m = typeof str === 'string' ? str.trim().match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const compareSemver = (a, b) => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  const firstDiff = [0, 1, 2].map((i) => (pa[i] === pb[i] ? 0 : pa[i] < pb[i] ? -1 : 1)).find((c) => c !== 0);
  return firstDiff ?? 0;
};

// Extract the version that is a DIRECT child of the top-level `metadata:` key — never a top-level or
// deeper-nested decoy `version:` (mirrors the manifest validator + the kit installer). Pure walk.
const metadataVersion = (frontmatter) => {
  const lines = frontmatter.split(/\r?\n/);
  const metaIdx = lines.findIndex((l) => /^metadata:[ \t]*$/.test(l));
  if (metaIdx === -1) return null;
  const after = lines.slice(metaIdx + 1);
  const dedent = after.findIndex((l) => /^[^ \t]/.test(l)); // a column-0 line closes the metadata block
  const block = dedent === -1 ? after : after.slice(0, dedent);
  const baseIndent = block.length ? (block[0].match(/^[ \t]*/)?.[0] ?? '') : '';
  const verLine = block.find((l) => l.startsWith(`${baseIndent}version:`));
  return verLine?.match(/version:[ \t]*['"]?(\d+\.\d+\.\d+)['"]?/)?.[1] ?? null;
};

// The installed version is read from the target's SKILL.md frontmatter metadata.version (the engine's
// detect.installed.file). Returns the semver string, or null when ABSENT / unstamped (legacy → no
// gate). A SKILL.md that EXISTS but cannot be read is NOT swallowed as "legacy": fail closed (throw)
// so the gate can never be silently bypassed (AGENTS.md: no silent failures).
const readInstalledVersion = async (target) => {
  const skill = resolve(target, 'SKILL.md');
  if (!existsSync(skill)) return null; // absent → new/legacy install, nothing to compare
  const text = await readFile(skill, 'utf8').catch((err) => {
    throw new Error(
      `[agent-workflow-engine] cannot read the installed SKILL.md (${tildify(skill)}): ${err.message}. ` +
        `Refusing to install over an unreadable canon — fix permissions/contents or remove it, then re-run.`,
    );
  });
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm ? metadataVersion(fm[1]) : null;
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
export const assertContainedRealPath = (root, dest) => {
  const rel = relative(root, dest);
  // A true escape is `..` exactly or a `..`-prefixed PATH SEGMENT (`../x`) — NOT any string starting
  // with the two chars "..": a legitimately-contained child literally named `..foo` has rel `..foo`,
  // which the old `rel.startsWith('..')` wrongly rejected (Issue-004).
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
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
    allowDowngrade: argv.includes('--allow-downgrade'),
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
  npx @sabaiway/agent-workflow-engine@latest init [--dir <path>] [--allow-downgrade]
  npx @sabaiway/agent-workflow-engine --version
  npx @sabaiway/agent-workflow-engine --help

Installs/refreshes the methodology canon at ~/.claude/skills/agent-workflow-engine
  (override with --dir <path> or AGENT_WORKFLOW_ENGINE_DIR). init is additive —
  it never deletes your files and never writes through a symlink. If the installed
  canon is newer than the version you ran, init refuses (no network — it compares the
  version on disk) and points you at @latest; --allow-downgrade overrides that refusal.

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

  // Stale-cache defenses (no network — version already on disk vs this runner). Read BEFORE any write
  // so a refusal touches nothing. cmp is null on a legacy/unparseable install → no gate.
  const installedVersion = wasPresent ? await readInstalledVersion(target) : null;
  const cmp = installedVersion ? compareSemver(installedVersion, version) : null;

  // Never-downgrade gate (D3 / AD-012): a bare `npx … init` can run an OLDER cached build, which
  // would overwrite a NEWER installed canon with old text. Refuse loudly (nonzero) unless
  // --allow-downgrade — surfacing the cache trap instead of silently regressing (no silent failures).
  if (cmp === 1 && !args.allowDowngrade) {
    console.error(
      `[agent-workflow-engine] refusing to downgrade: the installed canon is v${installedVersion}, but ` +
        `this runner is the OLDER v${version}.\n` +
        `  This is the classic npx cache serving a stale build. To get the newest canon, bypass the cache:\n` +
        `    npx @sabaiway/agent-workflow-engine@latest init\n` +
        `  (or pass --allow-downgrade to overwrite the newer install with v${version} anyway).`,
    );
    process.exit(1);
  }

  await mkdir(target, { recursive: true });
  await Promise.all(
    PAYLOAD.map((entry) => copyRecursive(resolve(PKG_ROOT, entry), resolve(target, entry), target)),
  );
  // Verb keyed on the OBSERVED version relation (cmp), never on mere presence: null (fresh install,
  // or a legacy/unstamped one whose prior version is unknowable) → "installed"; -1 → a real update;
  // 0 → already current (the copy still ran — see the note below); 1 is reachable only under
  // --allow-downgrade (the gate above refused otherwise) and says so plainly.
  const verb =
    cmp === 0 ? 'refreshed the already-current canon'
    : cmp === 1 ? 'downgraded the canon to'
    : cmp === -1 ? 'updated the canon to'
    : 'installed';
  console.log(`[agent-workflow-engine] ${verb} v${version} -> ${tildify(target)}`);

  // Same-version re-run: state observable facts only. The copy DID run (repair-on-rerun is a feature —
  // it restores locally modified/deleted files), and whether npx served a cached build is NOT
  // observable here (no network), so the note never claims it; the @latest hint is conditional.
  if (cmp === 0) {
    console.log(
      `[agent-workflow-engine] note: the canon was already v${version} — the copy still ran, restoring ` +
        `any locally modified or deleted canon file to this version's packaged contents. If you ` +
        `expected a NEWER version, invoke the @latest tag explicitly:\n` +
        `    npx @sabaiway/agent-workflow-engine@latest init`,
    );
  }

  console.log(`
This installed the methodology canon at ${tildify(target)}. The engine is content the
family kit builds on — there is nothing to run inside an agent.
To update it later, re-run:  npx @sabaiway/agent-workflow-engine@latest init`);
};

// Run main() only when executed directly (npx / node bin/install.mjs), never on import — so tests can
// import this module to unit-test its exported helpers with no side effects. Compare by REAL path:
// npx invokes the bin through a node_modules/.bin symlink, so process.argv[1] is that symlink while
// import.meta.url is the resolved real file — a raw string compare reads them as different and main()
// never runs. realpathSync collapses the symlink so both sides match. (Same idiom as the kit.)
const isDirectRun = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

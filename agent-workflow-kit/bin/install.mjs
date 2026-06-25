#!/usr/bin/env node
// One-shot installer for @sabaiway/agent-workflow-kit.
//
//   npx @sabaiway/agent-workflow-kit@latest init
//
// Copies the kit into the canonical skill home (~/.claude/skills/agent-workflow-kit),
// then runs the cross-agent launcher (auto-detects Codex / Devin Desktop — only touches tools
// you actually have). Re-running refreshes the skill to this package's version, which is
// how you upgrade the *skill files* themselves:
//
//   npx @sabaiway/agent-workflow-kit@latest init
//
// That is distinct from `/agent-workflow-kit upgrade`, which migrates a *project's*
// docs/ai deployment — see README "Use".
//
// No telemetry, no phone-home: adoption is the npm registry's public, passive per-version
// download numbers (api.npmjs.org/downloads). The stale-version GATE below is no-network — it
// compares the version already on disk (the installed SKILL.md) against this runner's own version,
// never the registry — which is why `@latest` (above) is the documented form: a bare `npx … init`
// can reuse an OLDER cached build of this installer, so a returning user must bypass the cache to
// actually upgrade (see decisions.md AD-012). One step DOES contact a server: `init` fetches and
// installs the methodology engine the kit reads live (`npx @sabaiway/agent-workflow-engine@latest
// init`), skippable with `--no-engine` (Plan 3D / AD-016). No tracking either way.
//
// Dependency-free, Node >= 18.

import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyTreeRefresh } from '../tools/fs-safe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

// The deployable skill = everything except the npm wrapper (package.json, bin/).
// capability.json (the family manifest) + tools/ (the family schema + validator the kit runs
// as the memory detector) must land in the installed skill dir too. bridges/ carries the
// byte-identical execution-backend skill mirrors (codex/antigravity) so `setup` can place a bridge
// from the installed kit, with no network fetch (Plan B / AD-011).
const PAYLOAD = [
  'SKILL.md',
  'README.md',
  'CHANGELOG.md',
  'capability.json',
  'references',
  'launchers',
  'migrations',
  'tools',
  'bridges',
];

// Kit-owned files the package NO LONGER ships (Plan 3D retired the bundled methodology mirror). The
// refresh copy is additive, so a 1.10.0→1.11.0 upgrade would leave these dead copies behind; remove
// exactly these known kit paths from the target on install (never user content, never a dir/symlink),
// so an upgraded install has the same single-source-of-truth shape as a fresh one.
const RETIRED_PATHS = ['references/planning.md', 'tools/methodology-slot.md'];

// Collapse only a LEADING homedir() to "~" — anchored at the string start (boundary-checked with
// `sep`), never a mid-path occurrence (Issue-004 parity with the engine/memory installers).
const tildify = (path) =>
  path === homedir() ? '~' : path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path;

const readVersion = async () => {
  try {
    const pkg = JSON.parse(await readFile(resolve(PKG_ROOT, 'package.json'), 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

// Dependency-free semver: parse the leading `x.y.z` (prerelease/build ignored — kit versions are
// plain). compareSemver returns -1 | 0 | 1, or null when either side is unparseable (legacy installs
// predate any version stamp). No `let`: a small functional comparison (AGENTS.md §2.3).
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

// Extract the version that is a DIRECT child of the top-level `metadata:` key — never a top-level
// or deeper-nested decoy `version:` (mirrors the manifest validator's rigor; the kit ships manifest
// fixtures that probe exactly those decoys). Pure string walk over the frontmatter block, no deps.
const metadataVersion = (frontmatter) => {
  const lines = frontmatter.split(/\r?\n/);
  const metaIdx = lines.findIndex((l) => /^metadata:[ \t]*$/.test(l));
  if (metaIdx === -1) return null;
  const after = lines.slice(metaIdx + 1);
  const dedent = after.findIndex((l) => /^[^ \t]/.test(l)); // a column-0 line closes the metadata block
  const block = dedent === -1 ? after : after.slice(0, dedent);
  // Direct children share the first child's indent; a nested decoy is MORE indented, so a
  // `<baseIndent>version:` prefix match excludes it. baseIndent is non-empty, so a top-level
  // `version:` (column 0, and before `metadata:` anyway) is excluded too.
  const baseIndent = block.length ? (block[0].match(/^[ \t]*/)?.[0] ?? '') : '';
  const verLine = block.find((l) => l.startsWith(`${baseIndent}version:`));
  return verLine?.match(/version:[ \t]*['"]?(\d+\.\d+\.\d+)['"]?/)?.[1] ?? null;
};

// The installed version is read from the target's SKILL.md frontmatter (`metadata.version`) — the
// manifest's canonical `detect.installed.file`, present even on legacy installs that predate
// capability.json. Returns the semver string, or null when ABSENT / has no parseable stamp (legacy
// → no gate). A SKILL.md that EXISTS but cannot be read is NOT swallowed as "legacy": we fail closed
// (throw) so the never-downgrade gate can never be silently bypassed (AGENTS.md: no silent failures).
const readInstalledVersion = async (target) => {
  const skill = resolve(target, 'SKILL.md');
  if (!existsSync(skill)) return null; // absent → new/legacy install, nothing to compare
  const text = await readFile(skill, 'utf8').catch((err) => {
    throw new Error(
      `[agent-workflow-kit] cannot read the installed SKILL.md (${tildify(skill)}): ${err.message}. ` +
        `Refusing to install over an unreadable kit — fix permissions/contents or remove it, then re-run.`,
    );
  });
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return fm ? metadataVersion(fm[1]) : null;
};

// lstat without following symlinks; null when absent. existsSync FOLLOWS symlinks (so a
// *dangling* symlink reads as absent) — lstat is what lets the guard catch a dangling dest symlink.
const lstatNoFollow = (path) => {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err; // EACCES/EIO etc. must NOT fail open (be read as "not a symlink")
  }
};

// The symlink-traversal guard + the recursive refresh copy now live in tools/fs-safe.mjs (shared,
// dependency-injectable, unit-tested in isolation). install.mjs consumes copyTreeRefresh, which guards
// every dest via assertContainedRealPath internally. The local lstatNoFollow above stays for the
// pre-flight check on the target root itself (a nicer error than letting the copy throw).

const parseArgs = (argv) => {
  const dirFlag = argv.indexOf('--dir');
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version') || argv.includes('-v'),
    noLaunchers: argv.includes('--no-launchers'),
    noEngine: argv.includes('--no-engine'),
    force: argv.includes('--force'),
    allowDowngrade: argv.includes('--allow-downgrade'),
    dir: dirFlag >= 0 ? argv[dirFlag + 1] : undefined,
  };
};

// Mandatory engine install (Plan 3D / AD-016). The kit reads the methodology fragment LIVE from the
// installed agent-workflow-engine, so init places it as a CORE part of the kit (not an optional
// execution-backend — this deliberately diverges from AD-011 §5). It is fetched over npm, consistent
// with the kit's own npx install context; NO engine canon is bundled into the kit (that would
// re-create the mirror Plan 3D deletes). --no-engine skips it for air-gapped/scripted installs.
export const ENGINE_PACKAGE = '@sabaiway/agent-workflow-engine';

// The exact command + argv to install the engine. Windows resolution: spawn `npx.cmd` on win32,
// `npx` elsewhere, WITHOUT shell:true (no shell-parse overhead/inconsistency; the repo has no
// npx-spawn precedent to inherit a shell from). Pure → unit-tested in-process, no network.
export const engineInstallArgv = (platform) => ({
  command: platform === 'win32' ? 'npx.cmd' : 'npx',
  args: [`${ENGINE_PACKAGE}@latest`, 'init'],
  options: { stdio: 'inherit' }, // note: no `shell: true`
});

// The default runner — the only place that actually spawns. Injected in tests so the suite never
// hits the network.
const spawnEngine = ({ command, args, options }) => spawnSync(command, args, options);

// Synchronous backoff before the single retry. The common first-attempt failure is a TRANSIENT
// npm/network blip (rate-limit, registry hiccup, momentary DNS) — an immediate retry tends to hit the
// same blip, so wait briefly first. Atomics.wait is a dependency-free sync sleep (the install flow is
// already synchronous here). Injected in tests as a 0ms no-op so the suite never actually sleeps.
const ENGINE_RETRY_DELAY_MS = 1500;
const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// D1 failure policy: attempt → wait → retry-once → fail. Retry exactly once before giving up. Pure
// aside from the injected runner/sleep; returns { ok } so the caller prints the loud manual-recovery
// message + nonzero exit on a hard failure (the kit is already on disk — recovery is one step; never
// a silent skip).
export const installEngine = (platform, runner, { sleep = sleepSync, retryDelayMs = ENGINE_RETRY_DELAY_MS } = {}) => {
  const descriptor = engineInstallArgv(platform);
  const ranOk = (label) => {
    const res = runner(descriptor);
    const ok = (res?.status ?? 1) === 0 && !res?.error;
    if (!ok) {
      const why = res?.error ? `: ${res.error.message}` : ` (exit ${res?.status ?? 'unknown'})`;
      console.warn(`[agent-workflow-kit] methodology engine install ${label} failed${why}.`);
    }
    return ok;
  };
  if (ranOk('attempt 1')) return { ok: true };
  sleep(retryDelayMs); // brief backoff so the retry does not immediately re-hit a transient blip
  if (ranOk('retry')) return { ok: true };
  return { ok: false };
};

const resolveTarget = (dirArg) => {
  if (dirArg) return resolve(dirArg);
  if (process.env.AGENT_WORKFLOW_KIT_DIR) return resolve(process.env.AGENT_WORKFLOW_KIT_DIR);
  return resolve(homedir(), '.claude/skills/agent-workflow-kit');
};

const printHelp = (version) => {
  console.log(`agent-workflow-kit ${version}

Usage:
  npx @sabaiway/agent-workflow-kit@latest init [--dir <path>] [--no-launchers] [--no-engine] [--force] [--allow-downgrade]
  npx @sabaiway/agent-workflow-kit@latest --version
  npx @sabaiway/agent-workflow-kit@latest --help

Use the @latest form: a bare \`npx … init\` (no @latest) can reuse an OLDER cached
  build of this installer, so a returning user must bypass the npx cache to upgrade.

Installs/refreshes the kit at ~/.claude/skills/agent-workflow-kit
  (override with --dir <path> or AGENT_WORKFLOW_KIT_DIR), then wires any
  Codex / Devin Desktop you have, then installs the methodology engine the kit reads
  live (npx ${ENGINE_PACKAGE}@latest init). --no-launchers skips the
  launcher wiring; --no-engine skips the engine install (the live methodology read then
  STOPs until you install it by hand); --force replaces a pre-existing non-kit launcher
  file (backed up first). init is additive — it never deletes your settings. If the
  installed kit is newer than the version you ran, init refuses (no network — it compares
  the version on disk) and points you at @latest; --allow-downgrade overrides that
  refusal (distinct from --force, which is launcher-only).

After install, invoke the skill in your agent, inside a project:
  first time in the project  ->  /agent-workflow-kit
  project already has it     ->  /agent-workflow-kit upgrade
  (Claude Code / Codex / Devin Desktop all use the same /agent-workflow-kit.)

Re-running this npx command updates the kit's own files; /agent-workflow-kit
upgrade then migrates a project's deployment to that version.`);
};

const main = async () => {
  const version = await readVersion();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) return printHelp(version);
  if (args.version) return console.log(version);

  // Critical payload must be present, or the install would silently ship a kit that can't run
  // its own detector (tools/) or family contract (capability.json). Fail loudly, don't filter away.
  const REQUIRED = [
    'SKILL.md',
    'capability.json',
    'references',
    'tools',
    'migrations',
    'bridges/codex-cli-bridge',
    'bridges/antigravity-cli-bridge',
  ];
  const missing = REQUIRED.filter((entry) => !existsSync(resolve(PKG_ROOT, entry)));
  if (missing.length > 0) {
    console.error(`[agent-workflow-kit] package payload incomplete — missing: ${missing.join(', ')} (corrupt install?)`);
    process.exit(1);
  }

  const target = resolveTarget(args.dir);
  const wasPresent = existsSync(resolve(target, 'SKILL.md'));
  if (lstatNoFollow(target)?.isSymbolicLink()) {
    console.error(`[agent-workflow-kit] target dir is a symlink — refusing to write through it: ${tildify(target)}`);
    process.exit(1);
  }

  // Stale-cache defenses (no network — version already on disk vs this runner). Read BEFORE any
  // write so a refusal touches nothing. cmp is null on a legacy/unparseable install → no gate.
  const installedVersion = wasPresent ? await readInstalledVersion(target) : null;
  const cmp = installedVersion ? compareSemver(installedVersion, version) : null;

  // Never-downgrade gate: a bare `npx … init` can run an OLDER cached build of this installer, which
  // would overwrite a NEWER installed skill with old code. Refuse loudly (nonzero) unless the
  // dedicated --allow-downgrade override is passed — surfacing the cache trap instead of silently
  // regressing the install (AGENTS.md: no silent failures). The override is its OWN flag, NOT --force:
  // --force means "replace a foreign launcher file" and is forwarded to the launcher; conflating them
  // would let someone clearing the version gate also clobber launchers by accident.
  if (cmp === 1 && !args.allowDowngrade) {
    console.error(
      `[agent-workflow-kit] refusing to downgrade: the installed kit is v${installedVersion}, but this ` +
        `runner is the OLDER v${version}.\n` +
        `  This is the classic npx cache serving a stale build. To get the newest kit, bypass the cache:\n` +
        `    npx @sabaiway/agent-workflow-kit@latest init\n` +
        `  (or pass --allow-downgrade to overwrite the newer install with v${version} anyway).`,
    );
    process.exit(1);
  }

  await mkdir(target, { recursive: true });
  for (const entry of PAYLOAD.filter((e) => existsSync(resolve(PKG_ROOT, e)))) {
    copyTreeRefresh(resolve(PKG_ROOT, entry), resolve(target, entry), target);
  }
  // Remove the retired mirror files an older install may have left (additive refresh never deletes).
  // Only a regular file at the exact known path is removed — lstat (no-follow) so a dir/symlink is
  // left untouched, and the path is a hardcoded kit-owned constant (no traversal, never user content).
  for (const rel of RETIRED_PATHS) {
    const retired = resolve(target, rel);
    if (lstatNoFollow(retired)?.isFile()) {
      await rm(retired, { force: true });
      console.log(`[agent-workflow-kit] removed retired file ${tildify(retired)} (now read live from the engine).`);
    }
  }
  console.log(`[agent-workflow-kit] ${wasPresent ? 'updated the kit to' : 'installed'} v${version} -> ${tildify(target)}`);

  // No-op re-run: the install just refreshed the skill with the SAME version it already had. For a
  // user who ran `init` expecting an upgrade, that almost always means npx reused a cached build —
  // say so explicitly and point at @latest (the no-network signal that catches the reported scenario).
  if (cmp === 0) {
    console.log(
      `[agent-workflow-kit] note: no version change — the kit was already v${version}. If you expected ` +
        `an update, npx likely served a cached build; re-run bypassing the cache:\n` +
        `    npx @sabaiway/agent-workflow-kit@latest init`,
    );
  }

  // Wire non-Claude agents — best-effort; the launcher only touches tools you have.
  const launcher = resolve(target, 'launchers/install-launchers.sh');
  if (args.noLaunchers) {
    console.log('[agent-workflow-kit] --no-launchers: skipped Codex/Devin Desktop wiring.');
  } else if (process.platform === 'win32') {
    console.log('[agent-workflow-kit] Windows: skipped POSIX launcher. Claude Code reads the kit natively.');
  } else if (existsSync(launcher)) {
    const launcherArgs = args.force ? [launcher, '--force'] : [launcher];
    const launcherRun = spawnSync('bash', launcherArgs, { stdio: 'inherit' });
    if (launcherRun.status !== 0) {
      console.warn('[agent-workflow-kit] launcher step skipped/failed — run it by hand if you use Codex/Devin Desktop:');
      console.warn(`  bash ${tildify(launcher)}`);
    }
  }

  // Mandatory engine install — AFTER the kit + launchers but BEFORE the success block, so a failure
  // never first claims everything succeeded. The kit reads the methodology fragment live from the
  // installed engine; this places it (over npm, no canon bundled into the kit). --no-engine opts out.
  const engineCmd = `npx ${ENGINE_PACKAGE}@latest init`;
  if (args.noEngine) {
    console.log(
      `[agent-workflow-kit] --no-engine: skipped installing the methodology engine. The methodology ` +
        `slot is read LIVE from the installed engine, so a reconcile/upgrade will STOP until you run:\n` +
        `    ${engineCmd}`,
    );
  } else {
    console.log(`[agent-workflow-kit] installing the methodology engine the kit reads live: ${engineCmd}`);
    const engine = installEngine(process.platform, spawnEngine);
    if (!engine.ok) {
      // D1: two attempts failed → loud error + concrete recommendations + nonzero exit. The kit IS on
      // disk, so recovery is one step. Never a silent skip (Hard Constraint: no silent failures).
      console.error(
        `[agent-workflow-kit] FAILED to install the methodology engine after two attempts. The kit ` +
          `itself IS installed at ${tildify(target)}, but the methodology-slot read will STOP until the ` +
          `engine is present. Finish with EITHER:\n` +
          `    ${engineCmd}                                          (install the engine — recommended)\n` +
          `    npx @sabaiway/agent-workflow-kit@latest init --no-engine   (skip it deliberately)`,
      );
      process.exit(1);
    }
    console.log('[agent-workflow-kit] methodology engine installed.');
  }

  // This command (de)installed the *kit* globally. Deploying it into a project is a
  // separate, in-agent step — and which sub-command depends on whether that project
  // already has the kit. Spell both out so it's unambiguous (see README "Use").
  console.log(`
Next — open your agent inside a project and run the skill:
  • first time in this project  ->  /agent-workflow-kit
  • project already has the kit  ->  /agent-workflow-kit upgrade

This command only installs/updates the kit itself (in ${tildify(target)}).
To update the kit later, re-run:  npx @sabaiway/agent-workflow-kit@latest init`);
};

// Run main() only when executed directly (npx / node bin/install.mjs), never on import — so tests
// can import this module to assert it has no side effects. Same idiom as tools/detect-backends.mjs.
//
// Compare by REAL path, not by URL string: npx invokes the bin through a symlink in node_modules/.bin,
// so process.argv[1] is that symlink while import.meta.url is the resolved real file — a raw string
// compare reads them as different, main() never runs, and `npx … init` exits silently (the reported
// "nothing happens after install" bug). realpathSync collapses the symlink so both sides match; it also
// holds under --preserve-symlinks. A bare `node -e` (no argv[1]) and a missing file (realpath throws)
// both correctly fall through to false — importing the module still runs nothing.
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

#!/usr/bin/env node
// setup-backends.mjs — link-only auto-setup for the execution-backend bridges (Plan B / AD-011).
// The kit owns ONLY the two deterministic, secret-free steps: (1) PLACE/REFRESH the bundled bridge
// skill into its canonical dir, and (2) LINK its POSIX wrappers onto PATH (~/.local/bin) via managed
// symlinks. Binary install + the interactive subscription login stay GUIDED (printed, never run) —
// guideFor() supplies the exact commands. The read-only detector is the reader; this is the writer.
//
// Two write modes: plain setup (opt-in, in-agent — the ONLY path that ever PLACES a bridge) and the
// refresh-only driver (`--refresh-placed` / refreshPlacedBridges, run by `init` and Mode: upgrade) —
// it refreshes what setup already placed and re-links wrappers, states an absent bridge as a skip
// (never a first placement), and never downgrades: a placed bridge newer than the kit-bundled mirror
// is a stated skip naming the kit update (guarded again at the write boundary in placeSkill).
//
// Safety posture (AD-011): drive off the decoupled axes (a per-bindir wrapper check + an independent
// skill-dir inspection), never the detector's collapsed readiness. REFRESH only a dir we provably own
// (valid manifest, name+kind match) or one that is absent/empty; STOP on anything else (a marker fs
// error, a stub/foreign/invalid/unsupported manifest, a non-empty unknown dir, or a symlinked dir).
// Clobber-risk lives only on the wrapper symlinks — replace only a symlink already pointing at our
// source; STOP on a foreign symlink or a non-symlink. PREFLIGHT every dst, THEN mutate (a conflict on
// the 2nd wrapper ⇒ zero mutations; no rollback — symlinks/chmod converge on re-run). Windows: the
// wrappers are POSIX .sh — report unsupported / use WSL and mutate nothing. Every fs primitive is
// injectable (deps.*) so the whole module is unit-testable without touching the real filesystem.
//
// Dependency-free, Node >= 22.

import {
  existsSync, lstatSync, statSync, readdirSync, readlinkSync, symlinkSync, mkdirSync, copyFileSync,
  chmodSync, readFileSync, realpathSync,
} from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { KNOWN_BACKENDS, detectBackend, detectBackends, resolveDir, guideFor, READY } from './detect-backends.mjs';
import { copyTreeRefresh, linkManaged, isReadonlyWriteBoundary } from './fs-safe.mjs';
import { validateManifest, readAuthoritativeVersion, UNSUPPORTED, INVALID } from './manifest/validate.mjs';
import { compareSemver } from './semver-lite.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// bridges/ ships beside tools/ in both the repo and the installed kit, so this resolves in both.
const DEFAULT_BUNDLE_ROOT = resolve(__dirname, '..', 'bridges');
const DEFAULT_BINDIR_REL = '.local/bin';
const EXPECTED_KIND = 'execution-backend';
// A wrapper cmd becomes a PATH filename — keep it to a plain basename, no separators/traversal/control.
const CMD_ALLOWED = /^[A-Za-z0-9._-]+$/;

// Token → registry name. `codex`/`agy`/`antigravity` are the CLI-facing aliases.
const ALIASES = { codex: 'codex-cli-bridge', agy: 'antigravity-cli-bridge', antigravity: 'antigravity-cli-bridge' };
const resolveBackendName = (token) => ALIASES[token] ?? token;
const registryEntry = (name) => KNOWN_BACKENDS.find((b) => b.name === resolveBackendName(name));

// A typed STOP — a deliberate refusal we surface (distinct from a native fs error, though both exit
// non-zero). `Object.assign(new Error(), { code })`, the codebase's typed-error idiom (no classes).
export const SETUP_STOP = 'SETUP_STOP';
const stop = (message, fields = {}) =>
  Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'SetupStop', code: SETUP_STOP, ...fields });

// A refresh-only outcome (REFRESH-EROFS-HONESTY / AD-056): an equal-version repair-on-rerun whose
// write hit a READ-ONLY skills dir. A STATED skip (exit 0), never a false "could not refresh" — the
// versions are already current and `setup` would hit the same read-only dir. Doc-parity binds this
// token into references/modes/setup.md + upgrade.md so the mode contracts track the constant.
export const SKIPPED_READONLY = 'skipped-readonly';

// ── injectable fs ──────────────────────────────────────────────────────────────

const fsDeps = (deps = {}) => ({
  lstat: deps.lstat ?? lstatSync,
  exists: deps.exists ?? existsSync,
  stat: deps.stat ?? statSync,
  readdir: deps.readdir ?? readdirSync,
  readlink: deps.readlink ?? readlinkSync,
  symlink: deps.symlink ?? symlinkSync,
  mkdir: deps.mkdir ?? ((p) => mkdirSync(p, { recursive: true })),
  copyFile: deps.copyFile ?? copyFileSync,
  chmod: deps.chmod ?? chmodSync,
  readFile: deps.readFile ?? readFileSync,
  realpath: deps.realpath ?? realpathSync,
});

// lstat without following symlinks; null when absent. A non-ENOENT error propagates (never fail open).
const lstatNoFollow = (path, lstat) => {
  try {
    return lstat(path);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
};

// A path must be a real REGULAR file (never a symlink). Gates both the bundle source (during planning
// — what we will copy then link) and the placed skill source (at link time, a TOCTOU re-check).
const assertRegularFile = (absPath, label, fs) => {
  const st = lstatNoFollow(absPath, fs.lstat);
  if (st === null) throw stop(`${label} is missing: ${absPath}`);
  if (st.isSymbolicLink()) throw stop(`${label} is a symlink — refusing: ${absPath}`);
  if (!st.isFile()) throw stop(`${label} is not a regular file: ${absPath}`);
};

// Wrapped file probe: present (regular file) | missing (absent / not a file) | unknown (other fs err).
const probeMarker = (file, fs) => {
  try {
    if (!fs.exists(file)) return 'missing';
    return fs.stat(file).isFile() ? 'present' : 'missing';
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'missing' : 'unknown';
  }
};

// ── overwrite honesty (D5) — state what a refresh replaced, never a silent wipe ────────────────────

// The host-level settings surface a refresh NEVER touches — the one place a bridge tweak survives a
// kit upgrade (bridge CODE stays kit-owned; only these knobs persist). Named wherever a refresh
// reports overwriting a local edit, so the recovery is always a copy-paste away.
const SETTINGS_FILE_HINT = '${XDG_CONFIG_HOME:-~/.config}/agent-workflow/bridge-settings.conf';
const SETTINGS_CMD_HINT = '/agent-workflow-kit bridge-settings';

// Bundle-owned regular files whose PLACED copy differs from the bundle (a local edit an equal-version
// refresh would overwrite) or cannot be read (indeterminate — an honest degrade). Mirrors
// copyTreeRefresh's src dispatch so it flags EXACTLY the files the overwrite touches: a symlink src is
// additive (copyTreeRefresh skips an existing dest — never overwritten) and a dir recurses; a
// bundled-only file (no placed copy) is a pure add, no loss. The BUNDLE read is our own shipped
// artifact — a failure there is a loud corrupt-kit error upstream (never swallowed here); only the
// PLACED read is caught (EACCES/EIO → 'unreadable', and the refresh still proceeds). Sorted output is
// deterministic for the stated line. Exported for a direct unit test (the full driver cannot observe a
// symlinked placed file — copyTreeRefresh refuses to overwrite one, so the refresh fails before any line).
export const scanBundleOwnedDrift = (bundleDir, skillDir, fs) => {
  const drifted = [];
  const unreadable = [];
  const walk = (rel) => {
    const src = join(bundleDir, rel);
    const dest = join(skillDir, rel);
    const st = fs.lstat(src);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const entry of fs.readdir(src)) walk(rel ? join(rel, entry) : entry);
      return;
    }
    // lstat the PLACED path NO-FOLLOW first — never read THROUGH a symlink (copyTreeRefresh's
    // assertContainedRealPath would refuse to overwrite a symlinked dest, so reading its target here
    // would be both unsafe and moot). Absent → a bundled-only addition (no local loss); a symlink /
    // non-regular / unreadable placed node → "could not compare" without a read-through.
    const destStat = (() => {
      try {
        return fs.lstat(dest);
      } catch (err) {
        return err && err.code === 'ENOENT' ? 'absent' : 'error';
      }
    })();
    if (destStat === 'absent') return;
    if (destStat === 'error' || destStat.isSymbolicLink() || !destStat.isFile()) {
      unreadable.push(rel);
      return;
    }
    const srcBytes = fs.readFile(src);
    const destBytes = (() => {
      try {
        return fs.readFile(dest);
      } catch {
        unreadable.push(rel);
        return null;
      }
    })();
    if (destBytes === null) return;
    if (!Buffer.from(srcBytes).equals(Buffer.from(destBytes))) drifted.push(rel);
  };
  walk('');
  return { drifted: drifted.sort(), unreadable: unreadable.sort() };
};

// One user-facing sentence naming what an equal-version re-sync overwrote — or null when nothing local
// was lost. Callers apply their own indent; the pointer names the settings file that survives a refresh.
const driftSummary = (drift) => {
  if (!drift) return null;
  const parts = [];
  if (drift.drifted.length) parts.push(`overwrote ${drift.drifted.length} locally-changed file(s): ${drift.drifted.join(', ')}`);
  if (drift.unreadable.length) parts.push(`could not compare ${drift.unreadable.length} file(s) (kept the bundled copy): ${drift.unreadable.join(', ')}`);
  if (!parts.length) return null;
  return `${parts.join('; ')} — bridge code is kit-owned and always refreshed; persist host tweaks in ${SETTINGS_FILE_HINT} (survives every refresh): ${SETTINGS_CMD_HINT}`;
};

// ── path resolution ──────────────────────────────────────────────────────────

const skillDirOf = (entry, deps) =>
  resolveDir({ env: entry.installed.env, default: entry.installed.default }, deps.getenv ?? process.env, deps.home ?? os.homedir());
const bundleDirOf = (name, deps) => join(deps.bundleRoot ?? DEFAULT_BUNDLE_ROOT, name);
const bindirOf = (deps) => deps.bindir ?? join(deps.home ?? os.homedir(), DEFAULT_BINDIR_REL);

// Is `bindir` already a PATH member? Normalised per platform (delimiter + win32 case-fold). Read-only —
// a "no" only yields a printed "add to PATH" hint; we never edit a shell rc file.
export const bindirOnPath = (bindir, env = process.env, platform = process.platform) => {
  const isWin = platform === 'win32';
  const raw = (isWin ? env.PATH ?? env.Path : env.PATH) ?? '';
  const norm = (p) => (isWin ? resolve(p).toLowerCase() : resolve(p));
  const target = norm(bindir);
  return raw.split(isWin ? ';' : ':').filter(Boolean).some((d) => norm(d) === target);
};

// ── skill-dir inspection (read-only) ──────────────────────────────────────────

const provenManaged = (report, entry) => {
  if (report.result === UNSUPPORTED) return { ok: false, state: 'unsupported-schema' };
  if (report.result === INVALID) return { ok: false, state: 'invalid-manifest' };
  if (report.available === false) return { ok: false, state: 'stub' };
  if (report.kind !== EXPECTED_KIND || report.name !== entry.name) return { ok: false, state: 'foreign' };
  return { ok: true, state: 'ok' };
};

// Decide what placeSkill WOULD do, without writing. Returns { action:'place'|'refresh', skillDir,
// bundleDir, reason } or throws a typed STOP. `place` = absent/empty dir; `refresh` = proven-managed.
const inspectSkillDir = (entry, deps) => {
  const fs = fsDeps(deps);
  const validate = deps.validate ?? validateManifest;
  const skillDir = skillDirOf(entry, deps);
  const bundleDir = bundleDirOf(entry.name, deps);

  // A published tarball always ships the bundle; its absence means a corrupt/partial kit, fail loud.
  if (!fs.exists(join(bundleDir, entry.installed.file))) {
    throw Object.assign(
      new Error(`[agent-workflow-kit] bundled bridge missing: ${bundleDir} (corrupt kit install?)`),
      { code: 'MISSING_BUNDLE' },
    );
  }
  // Defense-in-depth: never place/link from a bundle we can't validate as THIS backend. The mirror
  // drift-guard pins the bundle at build time; this catches a corrupted / tampered install at runtime
  // (a valid-JSON manifest with the wrong name/kind would otherwise place a foreign bridge). Always
  // the REAL validator — the bundle is our own shipped artifact; `deps.validate` mocks only the
  // user-owned skill dir checked below.
  const bundleProvenance = provenManaged(validateManifest(bundleDir), entry);
  if (!bundleProvenance.ok) {
    throw Object.assign(
      new Error(`[agent-workflow-kit] bundled bridge manifest is "${bundleProvenance.state}" at ${bundleDir} (corrupt kit install?)`),
      { code: 'CORRUPT_BUNDLE' },
    );
  }

  const dirStat = lstatNoFollow(skillDir, fs.lstat);
  if (dirStat === null) return { action: 'place', skillDir, bundleDir, reason: 'skill dir absent' };
  if (dirStat.isSymbolicLink()) throw stop(`skill dir is a symlink — refusing to write through it: ${skillDir}`, { skillDir });
  if (!dirStat.isDirectory()) throw stop(`skill path exists but is not a directory: ${skillDir}`, { skillDir });

  const markerState = probeMarker(join(skillDir, entry.installed.file), fs);
  if (markerState === 'unknown') throw stop(`cannot determine bridge skill state — fs error on ${join(skillDir, entry.installed.file)}`, { skillDir });
  if (markerState === 'missing') {
    let entries;
    try {
      entries = fs.readdir(skillDir);
    } catch (err) {
      throw stop(`cannot read skill dir (${err.code ?? 'fs error'}): ${skillDir}`, { skillDir });
    }
    if (entries.length === 0) return { action: 'place', skillDir, bundleDir, reason: 'skill dir empty' };
    throw stop(`skill dir is non-empty but has no ${entry.installed.file} — refusing to overwrite unknown files: ${skillDir}`, { skillDir });
  }

  const provenance = provenManaged(validate(skillDir), entry);
  if (!provenance.ok) throw stop(`skill dir manifest is "${provenance.state}" — refusing to overwrite a dir we don't own: ${skillDir}`, { skillDir, state: provenance.state });
  return { action: 'refresh', skillDir, bundleDir, reason: 'proven-managed bridge skill' };
};

// ── wrapper link derivation (string-only) ─────────────────────────────────────

// Manifest roles → the deduped { cmd, sourceRel, source } link set. Validates UNTRUSTED manifest
// strings: cmd allowlist; a cmd mapped to two different sources is a STOP; a source must stay inside
// the skill dir. Pure string work — no fs (so the dry-run plan is correct before the skill is placed).
export const deriveLinks = (manifest, skillDir) => {
  const roles = manifest && typeof manifest.roles === 'object' && !Array.isArray(manifest.roles) ? manifest.roles : {};
  const byCmd = new Map();
  for (const role of Object.values(roles)) {
    const cmd = role && typeof role.cmd === 'string' ? role.cmd : null;
    const sourceRel = role && typeof role.source === 'string' ? role.source : null;
    if (!cmd || !CMD_ALLOWED.test(cmd)) throw stop(`invalid wrapper cmd ${JSON.stringify(cmd)} (must match ${CMD_ALLOWED})`);
    if (cmd === '.' || cmd === '..') throw stop(`invalid wrapper cmd ${JSON.stringify(cmd)} (reserved path name)`);
    if (!sourceRel) throw stop(`wrapper "${cmd}" has no source in the manifest`);
    if (byCmd.has(cmd) && byCmd.get(cmd) !== sourceRel) {
      throw stop(`wrapper "${cmd}" maps to two sources: "${byCmd.get(cmd)}" and "${sourceRel}"`);
    }
    byCmd.set(cmd, sourceRel);
  }
  if (byCmd.size === 0) throw stop('manifest declares no wrapper roles');
  return [...byCmd.entries()].map(([cmd, sourceRel]) => {
    const source = resolve(skillDir, sourceRel);
    const rel = relative(skillDir, source);
    if (rel.startsWith('..') || isAbsolute(rel)) throw stop(`wrapper "${cmd}" source escapes the skill dir: "${sourceRel}"`);
    return { cmd, sourceRel, source };
  });
};

// Classify a wrapper dst per-bindir (NOT PATH-wide): absent | ours (symlink → our source) | conflict.
const inspectDst = (dst, source, fs) => {
  const st = lstatNoFollow(dst, fs.lstat);
  if (st === null) return { state: 'absent' };
  if (!st.isSymbolicLink()) return { state: 'conflict', reason: 'a non-symlink already exists there' };
  let target;
  try {
    target = fs.readlink(dst);
  } catch (err) {
    return { state: 'conflict', reason: `unreadable symlink (${err.code ?? 'fs error'})` };
  }
  const resolved = isAbsolute(target) ? target : resolve(dirname(dst), target);
  return resolved === resolve(source) ? { state: 'ours' } : { state: 'conflict', reason: `foreign symlink → ${target}` };
};

// ── mutating primitives ───────────────────────────────────────────────────────

// The one kit-update recovery the never-downgrade skip names (the bundle only gets newer via the kit).
const KIT_UPDATE_RECOVERY = 'npx @sabaiway/agent-workflow-kit@latest init';

// Crash-safe placed-version read for the downgrade guard: an unreadable placed version yields null →
// compareSemver returns null → no ordering claim → the refresh stays allowed (legacy repair). The
// guard forbids only a PROVEN downgrade; it never turns an unreadable stamp into a false refusal.
const readPlacedVersionSafe = (skillDir, deps = {}) => {
  const readVersion = deps.readVersion ?? readAuthoritativeVersion;
  try {
    return readVersion(skillDir).version ?? null;
  } catch {
    return null;
  }
};

// Never-downgrade guard at the WRITE boundary (belt to planFor's braces — both read the versions
// fresh): a placed bridge NEWER than the kit-bundled mirror (an older npx runner / a kit downgrade)
// is a typed STOP naming the kit update, never a copy. Load-bearing once init/upgrade run the
// refresh automatically.
const downgradeReason = (placed, bundled) =>
  `placed bridge is v${placed} but this kit bundles the older v${bundled} — refusing to downgrade; ` +
  `update the kit first: ${KIT_UPDATE_RECOVERY}`;
const assertNoDowngrade = (plan, deps = {}) => {
  if (plan.action !== 'refresh') return;
  const placed = readPlacedVersionSafe(plan.skillDir, deps);
  const manifest = readBundledManifest(plan.bundleDir, deps);
  const bundled = typeof manifest.version === 'string' ? manifest.version : null;
  // `wouldDowngrade` lets a caller classify this STOP structurally (never by matching message text).
  if (compareSemver(placed, bundled) === 1) throw stop(downgradeReason(placed, bundled), { skillDir: plan.skillDir, wouldDowngrade: true });
};

// Copy the bundle over the placed skill dir (the refresh overwrite), FIRST scanning bundle-owned files
// for local drift so the caller can STATE what the overwrite replaced (D5 — overwrite honesty). Scan
// only on a refresh: a `place` writes into an absent/empty dir, so there is nothing local to lose. The
// copy proceeds either way — bridge code is kit-owned. Returns the drift report (null for a place).
const copyBridgeWithHonesty = (action, bundleDir, skillDir, deps) => {
  const fs = fsDeps(deps);
  const drift = action === 'refresh' ? scanBundleOwnedDrift(bundleDir, skillDir, fs) : null;
  copyTreeRefresh(bundleDir, skillDir, skillDir, fs);
  return drift;
};

// Place/refresh the bundled bridge skill. Re-inspects before writing (never trusts a stale plan).
// Returns the plan plus `drift`: on a refresh, the bundle-owned files whose local edits it overwrote.
export const placeSkill = (name, deps = {}) => {
  const entry = registryEntry(name);
  if (!entry) throw stop(`unknown backend: ${name}`);
  const plan = inspectSkillDir(entry, deps);
  assertNoDowngrade(plan, deps);
  const drift = copyBridgeWithHonesty(plan.action, plan.bundleDir, plan.skillDir, deps);
  return { ...plan, drift };
};

// Link the wrappers onto `bindir`. PREFLIGHT all (source is a regular non-symlink file inside the
// skill dir; every dst is absent/ours) THEN mutate, so a conflict on a later wrapper leaves the
// filesystem untouched. win32 → no mutation (POSIX-only wrappers). Returns the per-wrapper results.
export const linkWrappers = (skillDir, manifest, opts = {}) => {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') return { platform, skipped: true, links: [] };
  const fs = fsDeps(opts);
  const bindir = opts.bindir ?? bindirOf(opts);
  const derived = deriveLinks(manifest, skillDir);

  for (const { cmd, source } of derived) {
    assertRegularFile(source, `wrapper "${cmd}" source (was the skill placed?)`, fs);
  }
  for (const { cmd, source } of derived) {
    const info = inspectDst(join(bindir, cmd), source, fs);
    if (info.state === 'conflict') throw stop(`wrapper "${cmd}" target conflict at ${join(bindir, cmd)} — ${info.reason}`, { dst: join(bindir, cmd) });
  }

  fs.mkdir(bindir);
  // Collapse a symlinked bindir (a common dotfiles setup, e.g. ~/.local/bin → ~/dotfiles/bin) to its
  // real path, so the traversal guard inside linkManaged doesn't refuse the user's own PATH dir. cmd is
  // an allowlisted basename, so dst can never escape this dir.
  const realBindir = fs.realpath(bindir);
  const links = [];
  for (const { cmd, source } of derived) {
    fs.chmod(source, 0o755);
    const action = linkManaged(source, join(realBindir, cmd), realBindir, fs); // 'linked' | 'noop'
    links.push({ cmd, source, dst: join(bindir, cmd), action });
  }
  return { platform, skipped: false, links };
};

// ── planning (read-only) ──────────────────────────────────────────────────────

const readBundledManifest = (bundleDir, deps) => {
  const read = deps.readFile ?? readFileSync;
  let raw;
  try {
    raw = read(join(bundleDir, 'capability.json'), 'utf8');
  } catch (err) {
    throw Object.assign(
      new Error(`[agent-workflow-kit] cannot read bundled manifest: ${join(bundleDir, 'capability.json')} (${err.code ?? 'fs error'})`),
      { code: 'MISSING_BUNDLE' },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw stop(`bundled manifest is not valid JSON: ${err.message}`);
  }
};

const errOutcome = (entry, skillDir, bindir, platform, err, place = null) => ({
  name: entry.name,
  skillDir,
  bindir,
  platform,
  place,
  links: [],
  guides: [],
  bindirHint: null,
  outcome: err.code === SETUP_STOP ? 'stop' : 'error',
  reason: err.message,
});

// Build the full per-backend plan WITHOUT mutating anything (this is exactly what --dry-run prints).
// outcome ∈ unsupported(win32) | error | stop | ok. Only the deterministic skill+wrapper steps are
// "owned"; the cli/login axes surface as guides (informational — they never fail the command).
export const planFor = (backend, deps = {}) => {
  const entry = registryEntry(backend);
  if (!entry) throw stop(`unknown backend: ${backend}`);
  const platform = deps.platform ?? process.platform;
  const skillDir = skillDirOf(entry, deps);
  const bindir = bindirOf(deps);

  if (platform === 'win32') {
    return {
      name: entry.name, skillDir, bindir, platform, place: null, links: [], guides: [], bindirHint: null,
      outcome: 'unsupported',
      reason: 'POSIX .sh wrappers — run setup under WSL (Claude Code reads the kit natively on Windows)',
    };
  }

  let place;
  try {
    place = inspectSkillDir(entry, deps);
  } catch (err) {
    return errOutcome(entry, skillDir, bindir, platform, err);
  }

  let links;
  let version = null;
  let priorVersion = null;
  try {
    const fs = fsDeps(deps);
    const readVersion = deps.readVersion ?? readAuthoritativeVersion;
    const bundledManifest = readBundledManifest(place.bundleDir, deps);
    // The bundled bridge version (what setup will place/refresh) + the prior installed version (only on
    // a refresh — a place has no prior). readAuthoritativeVersion is the SAME source `status` reads, so
    // setup never invents a second version reader. A place / absent-prior shows no arrow (never "vnull").
    version = typeof bundledManifest.version === 'string' ? bundledManifest.version : null;
    priorVersion = place.action === 'refresh' ? readVersion(skillDir).version ?? null : null;
    // Never-downgrade (predicted here so a --dry-run is faithful and a real run stops before any
    // write; placeSkill re-checks at the write boundary). An unparseable side → compareSemver null →
    // no ordering claim → the refresh stays allowed (legacy repair). `wouldDowngrade` lets the
    // refresh-only driver report this as a stated skip rather than a failure.
    if (place.action === 'refresh' && compareSemver(priorVersion, version) === 1) {
      return {
        name: entry.name, skillDir, bindir, platform, place, links: [], guides: [], bindirHint: null,
        outcome: 'stop', wouldDowngrade: true, version, priorVersion,
        reason: downgradeReason(priorVersion, version),
      };
    }
    const derived = deriveLinks(bundledManifest, skillDir);
    // Preflight the BUNDLE sources (what we will copy → link). After place, the skill source IS the
    // bundle source, so checking it here makes a dry-run faithfully predict linkWrappers instead of
    // reporting "ok" and then throwing at apply time.
    for (const { cmd, sourceRel } of derived) {
      assertRegularFile(join(place.bundleDir, sourceRel), `bundled wrapper "${cmd}" source`, fs);
    }
    links = derived.map(({ cmd, sourceRel, source }) => {
      const dst = join(bindir, cmd);
      const info = inspectDst(dst, source, fs);
      return { cmd, sourceRel, source, dst, dstState: info.state, dstReason: info.reason ?? null };
    });
  } catch (err) {
    return errOutcome(entry, skillDir, bindir, platform, err, place);
  }

  const conflicts = links.filter((l) => l.dstState === 'conflict');
  if (conflicts.length > 0) {
    return {
      name: entry.name, skillDir, bindir, platform, place, links, guides: [], bindirHint: null,
      outcome: 'stop',
      reason: conflicts.map((c) => `wrapper "${c.cmd}": ${c.dstReason}`).join('; '),
    };
  }

  const status = (deps.detect ?? detectBackend)(entry, deps);
  const guides = guideFor(status).filter((g) => g.need !== 'skill'); // the place plan owns the skill axis
  const onPath = bindirOnPath(bindir, deps.getenv ?? process.env, platform);
  const bindirHint = onPath ? null : `add ${bindir} to PATH to use the wrappers: export PATH="${bindir}:$PATH"  (persist in ~/.bashrc / ~/.zshrc)`;

  return { name: entry.name, skillDir, bindir, platform, place, links, guides, bindirHint, outcome: 'ok', version, priorVersion };
};

// Perform an `ok` plan's deterministic steps. Re-derives + re-checks inside the primitives (no trust
// in the plan across the read→write gap). Throws on a mid-flight conflict / fs error (honest partial
// failure — placeSkill/chmod/symlink all converge on a re-run, so there is nothing to roll back).
const applyBackend = (plan, deps) => {
  const placed = (plan.place.action === 'place' || plan.place.action === 'refresh')
    ? placeSkill(plan.name, deps)
    : null;
  const manifest = readBundledManifest(plan.place.bundleDir, deps);
  linkWrappers(plan.skillDir, manifest, { ...deps, bindir: plan.bindir, platform: plan.platform });
  return { drift: placed?.drift ?? null };
};

// ── formatting ─────────────────────────────────────────────────────────────────

// The bridge version label for the skill line: place / absent-prior → "(vX)" (no arrow, never
// "vnull → vX"); refresh with a DIFFERENT prior → "(vOld → vNew)"; refresh equal / null prior → "(vX)".
const versionLabel = (plan) => {
  if (!plan.version) return '';
  if (plan.place?.action === 'refresh' && plan.priorVersion && plan.priorVersion !== plan.version) {
    return ` (v${plan.priorVersion} → v${plan.version})`;
  }
  return ` (v${plan.version})`;
};

const formatBackend = (plan, applied) => {
  const lines = [`  ${plan.name} → ${plan.outcome}`];
  if (plan.outcome === 'unsupported') {
    lines.push(`      ↳ ${plan.reason}`);
    return lines.join('\n');
  }
  if (plan.outcome === 'stop' || plan.outcome === 'error') {
    lines.push(`      ✗ ${plan.reason}`);
    return lines.join('\n');
  }
  const placeVerb = applied ? { place: 'placed', refresh: 'refreshed' } : { place: 'will place', refresh: 'will refresh' };
  lines.push(`      • skill: ${placeVerb[plan.place.action]}${versionLabel(plan)} → ${plan.skillDir}`);
  // Overwrite honesty (D5): on an equal-version re-sync that clobbered a local edit, say so (a version
  // upgrade's diffs are the version delta — versionLabel's arrow already signals that change).
  const equalVersionRefresh = plan.place.action === 'refresh' && (!plan.priorVersion || plan.priorVersion === plan.version);
  const driftLine = equalVersionRefresh ? driftSummary(plan.drift) : null;
  if (driftLine) lines.push(`      ↳ ${driftLine}`);
  for (const l of plan.links) {
    const verb = l.dstState === 'ours' ? 'already linked' : applied ? 'linked' : 'will link';
    lines.push(`      • wrapper ${l.cmd}: ${verb} → ${l.dst}`);
  }
  if (plan.bindirHint) lines.push(`      ↳ ${plan.bindirHint}`);
  for (const g of plan.guides) lines.push(`      ↳ ${g.need}: ${g.hint}`);
  return lines.join('\n');
};

// ── the refresh-only driver (the init/upgrade delivery hook — refresh, never place) ──

// Refresh-only apply: re-inspects at APPLY time and copies ONLY when the fresh inspection still says
// `refresh` (TOCTOU: a dir gone absent between plan and apply is a reported skip, NEVER a first
// placement — placement stays setup's opt-in step, AD-009/AD-011), and re-asserts the downgrade
// guard against a freshly-read placed version (a NEWER bridge landing between plan and apply is a
// typed STOP, never overwritten). No cross-process lock beyond that: like every mutating primitive
// here (see applyBackend), concurrent writers are resolved by CONVERGE-ON-RE-RUN — the Phase-1
// freshness probe flags any interleaving loser as behind and the next init/upgrade/setup repairs it;
// a per-bridge lock file would be new machinery for a user-driven, self-healing race.
const refreshSkillOnly = (entry, deps = {}) => {
  const fresh = inspectSkillDir(entry, deps);
  if (fresh.action !== 'refresh') return { refreshed: false, drift: null };
  assertNoDowngrade(fresh, deps);
  // D1b: version equality for the read-only degrade is decided from the APPLY-TIME fresh inspection's
  // fields (never the stale pre-apply plan) — both versions KNOWN and equal; two unknowns are not equal.
  // assertNoDowngrade just read the bundled manifest, so this read cannot throw here; a versionless
  // manifest yields null (never "equal" → no false skip).
  const bundledManifest = readBundledManifest(fresh.bundleDir, deps);
  const bundledVersion = typeof bundledManifest.version === 'string' ? bundledManifest.version : null;
  const placedVersion = readPlacedVersionSafe(fresh.skillDir, deps);
  const currentEqual = bundledVersion !== null && placedVersion === bundledVersion;
  try {
    const drift = copyBridgeWithHonesty('refresh', fresh.bundleDir, fresh.skillDir, deps);
    return { refreshed: true, drift };
  } catch (err) {
    // D1/D1a: ONLY a read-only WRITE-boundary failure at an EQUAL version is a repair-on-rerun that
    // cannot run — a STATED skip, never a false "could not refresh". Every other failure stays loud
    // (a read-side / source-side / EIO failure, or a version-behind upgrade, re-throws here).
    if (currentEqual && isReadonlyWriteBoundary(err)) return { refreshed: false, skippedReadonly: true, version: bundledVersion };
    throw err;
  }
};

const NOT_PLACED_LINE = 'skipped — not placed (placement is opt-in: /agent-workflow-kit setup)';
const stripPrefix = (message) => message.replace('[agent-workflow-kit] ', '');

// The read-only degrade wording (D1). The STATED-skip line: version current + the re-sync
// skipped/incomplete + the read-only cause + the residual — it never claims a re-sync RAN (that is
// already-current's line) nor file integrity (a partial copy may have happened before the throw). The
// FAILED line (a version-behind upgrade blocked by the same read-only dir) stays loud, but its
// recovery points at a writable rerun — the in-session `setup` would hit the same read-only dir.
const READONLY_RERUN_HINT = 're-run the refresh from a writable session (e.g. outside the read-only sandbox)';
const skippedReadonlyLine = (name, version) =>
  `  ${name}: already current${version ? ` (v${version})` : ''} — the re-sync was skipped/incomplete: ` +
  `the skills directory is read-only this session (the tree may be PARTIALLY updated). Repair-on-rerun cannot ` +
  `run here; any remaining drift persists until you ${READONLY_RERUN_HINT}.`;
const readonlyRefreshFailedLine = (name, message) =>
  `  ${name}: could not refresh — ${stripPrefix(message)}; the skills directory is read-only this session — ${READONLY_RERUN_HINT}`;

// Refresh every ALREADY-PLACED bridge from the kit's bundled copies and re-link its wrappers (a newer
// bridge can add one). One reported outcome per backend — never a crash; a per-backend STOP/error
// becomes a `failed` result. `line` is the tool-composed sentence callers print VERBATIM (the agent
// pastes, never composes — deterministic-first). Outcomes: refreshed · already-current · not-placed
// (absent — NEVER placed here) · kept-newer (INV-D stated skip) · unsupported (win32) · failed.
export const refreshPlacedBridges = (deps = {}, names = KNOWN_BACKENDS.map((b) => b.name)) =>
  names.map((name) => {
    const canonical = resolveBackendName(name);
    // The whole per-backend path is crash-proof, not just the apply: planFor itself can throw on a
    // truly unexpected dependency error, and one broken backend must never abort the others' report.
    try {
      const plan = planFor(name, deps);
      if (plan.outcome === 'unsupported') {
        return { name: plan.name, outcome: 'unsupported', line: `  ${plan.name}: skipped — ${plan.reason}` };
      }
      if (plan.wouldDowngrade) {
        return { name: plan.name, outcome: 'kept-newer', line: `  ${plan.name}: skipped — ${stripPrefix(plan.reason)}` };
      }
      // An absent/empty skill dir is `not placed` REGARDLESS of any later plan trouble (a foreign
      // wrapper conflict, a bundle-source problem): the refresh-only driver skips an unplaced bridge
      // before those axes matter, so it must never claim "could not refresh" what it would not touch.
      if (plan.place && plan.place.action !== 'refresh') {
        return { name: plan.name, outcome: 'not-placed', line: `  ${plan.name}: ${NOT_PLACED_LINE}` };
      }
      if (plan.outcome === 'stop' || plan.outcome === 'error') {
        return { name: plan.name, outcome: 'failed', line: `  ${plan.name}: could not refresh — ${stripPrefix(plan.reason)}; recover with /agent-workflow-kit setup` };
      }
      const refresh = refreshSkillOnly(registryEntry(plan.name), deps);
      // A read-only skills dir at an EQUAL version is a STATED skip (repair-on-rerun cannot run here) —
      // never a false "could not refresh" and never a failure exit (D1/AD-056).
      if (refresh.skippedReadonly) {
        return { name: plan.name, outcome: SKIPPED_READONLY, line: skippedReadonlyLine(plan.name, refresh.version) };
      }
      if (!refresh.refreshed) {
        return { name: plan.name, outcome: 'not-placed', line: `  ${plan.name}: ${NOT_PLACED_LINE}` };
      }
      const manifest = readBundledManifest(plan.place.bundleDir, deps);
      linkWrappers(plan.skillDir, manifest, { ...deps, bindir: plan.bindir, platform: plan.platform });
      const current = plan.version !== null && plan.priorVersion === plan.version;
      // The equal-version line still states the copy that ran (repair-on-rerun) — the tool never
      // reports a mutation-free "already current" while it re-synced files underneath.
      const base = `  ${plan.name}: ${current ? `already current${versionLabel(plan)} — files re-synced from the bundled copy` : `refreshed${versionLabel(plan)}`}`;
      // Overwrite honesty (D5): only an EQUAL-version re-sync can prove a byte diff is a LOCAL edit —
      // a version upgrade's diffs are the version delta, which the (vOld → vNew) arrow already states.
      const summary = current ? driftSummary(refresh.drift) : null;
      return {
        name: plan.name,
        outcome: current ? 'already-current' : 'refreshed',
        line: summary ? `${base}\n     ↳ ${summary}` : base,
      };
    } catch (err) {
      // A downgrade STOP raised at the write boundary (a newer bridge landed between plan and apply)
      // is the same stated skip as the planned one — classified structurally via the typed field.
      if (err.wouldDowngrade) {
        return { name: canonical, outcome: 'kept-newer', line: `  ${canonical}: skipped — ${stripPrefix(err.message)}` };
      }
      // A read-only WRITE failure on a version-BEHIND (upgrade) refresh stays a loud failure — but the
      // in-session "recover with setup" would hit the same read-only dir, so point at a writable rerun.
      if (isReadonlyWriteBoundary(err)) {
        return { name: canonical, outcome: 'failed', line: readonlyRefreshFailedLine(canonical, err.message) };
      }
      return { name: canonical, outcome: 'failed', line: `  ${canonical}: could not refresh — ${stripPrefix(err.message)}; recover with /agent-workflow-kit setup` };
    }
  });

// ── close-the-loop: surface versions + a proactive recipe offer ───────────────────

// The closing pointer: setup surfaces only the bridge it touched; the full family + deployment version
// view lives in the read-only status mode.
const STATUS_POINTER = 'Full family + deployment versions: /agent-workflow-kit status';

// Count the review-capable backends that are READY right now (both bridges provide review, so a READY
// count ≥1 unlocks Reviewed, ≥2 unlocks Council). Uses the MULTI-backend detector. A detection failure
// → null: we can't tell, so we make NO offer (never a false one). Read-only.
const reviewReadyCount = (deps) => {
  const detectAll = deps.detectAll ?? detectBackends;
  try {
    return detectAll(deps).filter((d) => d.readiness === READY).length;
  } catch {
    return null;
  }
};

// After a successful setup, if a review backend NEWLY became ready (the pre-apply readiness in planFor
// is stale — re-detect AFTER apply), offer to set the review recipe — for BOTH planning AND execution
// review (planning review is a core goal; never offer only plan-execution). Council when ≥2 are ready,
// else Reviewed (with a one-reviewer alternative noted). English; the agent localizes when it narrates.
export const proactiveReviewOffer = (before, after) => {
  if (before == null || after == null || after <= before) return null;
  const depth = after >= 2 ? 'council' : 'reviewed';
  const lines = [
    '',
    `A review backend is now ready (${after} ready). To have your plans reviewed, set the review recipe (preview first; I'll write it for you — or edit docs/ai/orchestration.json yourself):`,
    `  /agent-workflow-kit set-recipe --set plan-authoring.review=${depth}`,
    `  /agent-workflow-kit set-recipe --set plan-execution.review=${depth}`,
  ];
  if (depth === 'council') lines.push('  (or =reviewed for a single reviewer)');
  return lines.join('\n');
};

// ── CLI ─────────────────────────────────────────────────────────────────────────

const USAGE = `usage: setup-backends [<backend>] [--bindir <path>] [--dry-run | --refresh-placed] [--help]

  <backend>          codex | agy | antigravity | codex-cli-bridge | antigravity-cli-bridge   (default: all)
  --bindir           where to link the wrappers                                              (default: ~/.local/bin)
  --dry-run          print the plan; change nothing
  --refresh-placed   refresh ONLY the already-placed bridges from the kit's bundled copies —
                     an absent bridge is a stated skip (never placed), a placed bridge newer
                     than the bundle is a stated skip (never downgraded). The refresh-only
                     mode init/upgrade run; does not combine with --dry-run.
  --help, -h         this help

Places the bundled bridge skill + links its wrappers (idempotent; refuses to clobber a non-symlink).
Binary install + the interactive subscription login stay manual — the printed guidance has the exact
commands. The detector ("/agent-workflow-kit backends") stays read-only; this is the only writer.`;

const parseArgs = (argv) => {
  const out = { dryRun: false, refreshPlaced: false, help: false, bindir: undefined, backend: undefined, bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--refresh-placed') out.refreshPlaced = true;
    else if (a === '--bindir') {
      // Do NOT greedily swallow a following flag (e.g. `--bindir --dry-run` must not become
      // bindir="--dry-run" and silently mutate); a missing or flag-like value is a usage error.
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) out.bad = '--bindir needs a path argument';
      else {
        out.bindir = next;
        i += 1;
      }
    } else if (a.startsWith('-')) out.bad = `unknown flag: ${a}`;
    else if (out.backend === undefined) out.backend = a;
    else out.bad = `unexpected argument: ${a}`;
  }
  return out;
};

// Returns the process exit code (0 ok/guided/unsupported, non-zero on STOP/error/bad-args). Pure of
// process.exit so tests can assert the code; isDirectRun is what actually exits.
export const main = (argv = process.argv.slice(2), deps = {}) => {
  const log = deps.log ?? console.log;
  const errlog = deps.errlog ?? console.error;
  const args = parseArgs(argv);

  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (args.refreshPlaced && args.dryRun) args.bad = '--refresh-placed does not combine with --dry-run';
  if (args.bad) {
    errlog(args.bad);
    errlog(USAGE);
    return 2;
  }

  let targets;
  if (args.backend === undefined) targets = KNOWN_BACKENDS.map((b) => b.name);
  else {
    const entry = registryEntry(args.backend);
    if (!entry) {
      errlog(`unknown backend: ${args.backend}`);
      errlog(USAGE);
      return 2;
    }
    targets = [entry.name];
  }

  const runDeps = { ...deps, bindir: args.bindir ?? deps.bindir };

  // Refresh-only mode: act on what setup already placed; never place, never downgrade. Every line is
  // tool-composed — callers (init, Mode: upgrade) print/paste them verbatim.
  if (args.refreshPlaced) {
    log('agent-workflow placed-bridge refresh (refresh-only — placement stays opt-in: /agent-workflow-kit setup)');
    const results = refreshPlacedBridges(runDeps, targets);
    for (const r of results) log(r.line);
    return results.some((r) => r.outcome === 'failed') ? 1 : 0;
  }

  log(args.dryRun ? 'agent-workflow backend setup — DRY RUN (no changes)' : 'agent-workflow backend setup (link-only)');
  // Snapshot review readiness BEFORE applying, so we can offer the recipe only on a true readiness flip.
  const reviewBefore = args.dryRun ? null : reviewReadyCount(runDeps);
  let worst = 0;
  let appliedOk = false;
  for (const name of targets) {
    let plan = planFor(name, runDeps);
    if (!args.dryRun && plan.outcome === 'ok') {
      try {
        const { drift } = applyBackend(plan, runDeps);
        plan = { ...plan, drift };
        appliedOk = true;
      } catch (err) {
        plan = { ...plan, outcome: err.code === SETUP_STOP ? 'stop' : 'error', reason: err.message };
      }
    }
    log(formatBackend(plan, !args.dryRun));
    if (plan.outcome === 'stop' || plan.outcome === 'error') worst = 1;
  }
  log('');
  log(STATUS_POINTER);
  // Re-detect AFTER apply (pre-apply readiness is stale): a review backend that just became ready earns
  // a proactive set-recipe offer. Only after a real apply (never on a dry-run or a no-op run).
  if (!args.dryRun && appliedOk) {
    const offer = proactiveReviewOffer(reviewBefore, reviewReadyCount(runDeps));
    if (offer) log(offer);
  }
  return worst;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exit(main(process.argv.slice(2)));

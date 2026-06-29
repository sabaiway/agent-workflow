#!/usr/bin/env node
// family-registry.mjs — the unified, kit-owned registry over EVERY agent-workflow family member.
//
// Until now "who the members are" was split across three disjoint kit-owned tables: KNOWN_BACKENDS
// (the 2 bridges, detect-backends.mjs), KIT_OWN_PATHS/KNOWN_FOOTPRINT (the hidden-mode paths,
// known-footprint.mjs), and the 5 per-member capability.json files. This module is the single
// authoritative aggregation: it answers "what is installed, what version, what kind" (the SKILL
// axis) and "what is deployed in this project" (the deploy axis). It is the substrate the read-only
// `/agent-workflow-kit status` mode and the guarded `/agent-workflow-kit uninstall` both consume.
//
// Source of truth = the in-tool FAMILY_MEMBERS table (the AD-008 KNOWN_BACKENDS precedent): a member
// that is NOT installed has no manifest on disk to read, so the enumeration + detect/install facts
// must live here. A drift-guard test (family-registry.test.mjs) pins FAMILY_MEMBERS to the 5 in-repo
// capability.json files, so the table cannot silently drift from the manifests it mirrors.
//
// Pure, dependency-injectable (fs/env/home/validator are deps), dependency-free, Node >= 18. No
// side effects on import (the isDirectRun idiom) — tests import the helpers with nothing run.

import { existsSync, statSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { resolveDir, detectBackends, findOnPath } from './detect-backends.mjs';
import { validateManifest, readAuthoritativeVersion, UNSUPPORTED, INVALID } from './manifest/validate.mjs';
import { START_MARKER, excludePath, inferVisibility } from './hide-footprint.mjs';
import { readEngineFragment, ORCHESTRATION_FRAGMENT_REL, PROCEDURES_FRAGMENT_REL } from './engine-source.mjs';
import { ACTIVITIES, resolveActivityRecipe } from './recipes.mjs';
// The config reader lives in orchestration-config.mjs (the single config contract). The read-only status
// settings-survey reuses THIS reader (one strict-JSON + loud-on-malformed contract), not a second copy.
import { loadConfig } from './orchestration-config.mjs';
// The deployment-lineage head + the shared settings readers are reused from velocity-profile so the
// `--json` envelope/settings-survey has ONE implementation each, never a drifting copy:
//   EXPECTED_WORKFLOW_VERSION — the head literal (drift-guarded vs memory LINEAGE_HEAD)
//   readSettingsFile / resolveEffectiveMode — the loud `.claude/settings.*` reader + mode precedence
// (No import cycle: velocity-profile / recipes / procedures import only node builtins + siblings, none
// import family-registry, and none has a side effect on import — every CLI is isDirectRun-guarded.)
import {
  EXPECTED_WORKFLOW_VERSION,
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  readSettingsFile,
  resolveEffectiveMode,
} from './velocity-profile.mjs';

// ── manifestState values (the detect-backends precedence, generalized to any member kind) ──────────
export const NOT_INSTALLED = 'not-installed';
export const UNSUPPORTED_SCHEMA = 'unsupported-schema';
export const INVALID_MANIFEST = 'invalid-manifest';
export const STUB = 'stub';
export const FOREIGN = 'foreign';
export const OK = 'ok';
// The marker could not be probed (a non-ENOENT fs error — EACCES/EIO). Surfaced explicitly instead of
// being masked as not-installed (no silent failure); uninstall treats it as "do not touch" (skip).
export const UNKNOWN = 'unknown';

// ── the unified registry ───────────────────────────────────────────────────────
// One entry per family member. `installed` is the detect.installed spec (env + home-relative default
// + marker file); `deployed` is the project-relative stamp a deploy writes (kit + memory only);
// `npm` is the install package (null for the bridges, which are placed by `setup`, not npm);
// `wrapperCmds` is the deduped roles[].cmd set the `setup` linker creates on PATH (bridges only).
// Kept in lockstep with the 5 in-repo capability.json by the drift-guard test. The two release skills
// (release-engineering / release-marketing) are deliberately NOT here — they are not family members
// (AD-013): no capability.json, not in the kit tarball, not in the role vocabulary.
export const FAMILY_MEMBERS = [
  {
    name: 'agent-workflow-kit',
    kind: 'composition-root',
    installed: { env: 'AGENT_WORKFLOW_KIT_DIR', default: '~/.claude/skills/agent-workflow-kit', file: 'SKILL.md' },
    deployed: { file: 'docs/ai/.workflow-version' },
    npm: '@sabaiway/agent-workflow-kit',
    wrapperCmds: [],
  },
  {
    name: 'agent-workflow-memory',
    kind: 'memory-substrate',
    installed: { env: 'AGENT_WORKFLOW_MEMORY_DIR', default: '~/.claude/skills/agent-workflow-memory', file: 'SKILL.md' },
    deployed: { file: 'docs/ai/.memory-version' },
    npm: '@sabaiway/agent-workflow-memory',
    wrapperCmds: [],
  },
  {
    name: 'agent-workflow-engine',
    kind: 'methodology-engine',
    installed: { env: 'AGENT_WORKFLOW_ENGINE_DIR', default: '~/.claude/skills/agent-workflow-engine', file: 'SKILL.md' },
    deployed: null,
    npm: '@sabaiway/agent-workflow-engine',
    wrapperCmds: [],
  },
  {
    name: 'codex-cli-bridge',
    kind: 'execution-backend',
    installed: { env: 'CODEX_CLI_BRIDGE_DIR', default: '~/.claude/skills/codex-cli-bridge', file: 'SKILL.md' },
    deployed: null,
    npm: null,
    wrapperCmds: ['codex-exec', 'codex-review'],
  },
  {
    name: 'antigravity-cli-bridge',
    kind: 'execution-backend',
    installed: { env: 'ANTIGRAVITY_CLI_BRIDGE_DIR', default: '~/.claude/skills/antigravity-cli-bridge', file: 'SKILL.md' },
    deployed: null,
    npm: null,
    wrapperCmds: ['agy-run'],
  },
];

// A GLOBAL skill (lives under ~/.claude/skills) may be shared by other projects on the host — the
// uninstaller warns before removing one (there is no cross-project dependency tracking). All current
// members are global skills; the field is explicit so the warning is data-driven, not hardcoded.
export const isGlobalSkill = (member) => member.kind !== undefined; // every member is a global skill today

// ── pure probes ──────────────────────────────────────────────────────────────────
// Wrapped marker probe → 'present' (a regular file) | 'absent' (ENOENT / not a regular file) |
// 'unknown' (a non-ENOENT fs error, e.g. EACCES). STAT-FIRST on purpose: `existsSync()` SWALLOWS an
// EACCES into a bare `false`, which would mask a permission error as 'absent' (a silent failure);
// `statSync` THROWS the EACCES so it surfaces as 'unknown'. 'unknown' is never collapsed to 'absent' —
// classifyMember reports it (uninstall then leaves the dir alone) and the memory caveat skips it.
const probeMarker = (path, deps = {}) => {
  const stat = deps.stat ?? statSync;
  try {
    return stat(path).isFile() ? 'present' : 'absent';
  } catch (err) {
    return err && err.code === 'ENOENT' ? 'absent' : 'unknown';
  }
};

// Pure manifestState classifier — the detect-backends precedence, generalized to a member's own
// expected name + kind: not-installed → unsupported-schema → invalid-manifest → stub → foreign → ok.
const classifyState = (markerPresent, report, member) => {
  if (!markerPresent) return NOT_INSTALLED;
  if (report.result === UNSUPPORTED) return UNSUPPORTED_SCHEMA;
  if (report.result === INVALID) return INVALID_MANIFEST;
  if (report.available === false) return STUB;
  if (report.kind !== member.kind || report.name !== member.name) return FOREIGN;
  return OK;
};

// ── the SKILL axis ─────────────────────────────────────────────────────────────
// classifyMember → { name, kind, installed, skillDir, manifestState, version }. Reuses resolveDir
// (detect-backends), validateManifest + readAuthoritativeVersion (the manifest validator) — one
// authoritative version reader, no second drifting source. `version` is set only for an `ok` member.
export const classifyMember = (member, deps = {}) => {
  const validate = deps.validate ?? validateManifest;
  const readVersion = deps.readVersion ?? readAuthoritativeVersion;
  const getenv = deps.getenv ?? process.env;
  const home = deps.home ?? os.homedir();

  const skillDir = resolveDir({ env: member.installed.env, default: member.installed.default }, getenv, home);
  const marker = probeMarker(join(skillDir, member.installed.file), deps);
  // A marker we cannot probe (EACCES/EIO) → 'unknown': reported, but NOT installed (so uninstall never
  // removes a dir whose ownership it could not verify). Distinct from 'not-installed' (genuinely absent).
  if (marker === 'unknown') {
    return { name: member.name, kind: member.kind, installed: false, skillDir, manifestState: UNKNOWN, version: null };
  }
  const markerPresent = marker === 'present';
  const report = markerPresent ? validate(skillDir) : { result: NOT_INSTALLED };
  const manifestState = classifyState(markerPresent, report, member);
  const installed = manifestState !== NOT_INSTALLED;
  const version = manifestState === OK ? readVersion(skillDir).version ?? null : null;

  return { name: member.name, kind: member.kind, installed, skillDir: installed ? skillDir : null, manifestState, version };
};

// An installed engine may be a VALID methodology-engine yet too old (or incomplete) to ship one of the
// kit's live-read fragments: `references/orchestration-slot.md` (the recipes pointer, engine >= 1.2.0)
// and `references/procedures.md` (the activity-procedures canon, engine >= 1.3.0). Each missing
// fragment is a DISTINCT, plain-language caveat. They are collected into `row.caveats` (an ARRAY) so an
// engine missing BOTH surfaces both — a single `row.caveat` would overwrite one with the other. The
// check mirrors what each consumer actually does — `readEngineFragment(..., { rel })` validates
// the manifest AND reads the fragment — so an absent, non-file, OR present-but-unreadable fragment all
// surface (status never claims "ok" for a fragment a reconcile / the procedures CLI would STOP on), and
// a current, readable fragment never gets the caveat. Read-only, best-effort.
const ENGINE_FRAGMENT_CAVEATS = [
  { rel: ORCHESTRATION_FRAGMENT_REL, caveat: 'engine present but does not supply the recipes pointer (too old / incomplete) — run `npx @sabaiway/agent-workflow-engine@latest init`' },
  { rel: PROCEDURES_FRAGMENT_REL, caveat: 'engine present but does not ship the activity-procedures canon (too old / incomplete) — run `npx @sabaiway/agent-workflow-engine@latest init`' },
];

// The orchestration-config TEMPLATE a current memory ships (added in memory 1.2.0; absent in older
// installs such as v1.0.0). It is the SAME asset Step 2.4 adds to delegation.mjs's
// REQUIRED_MEMORY_ASSETS: the read-only note here INFORMS, the delegation gate ACTS. Step 2.4 also
// adds a parity drift-guard tying this path to that required-asset set, so the note and the gate can
// never key on different files (until then they are kept in lockstep by review).
export const MEMORY_ORCH_TEMPLATE_REL = 'references/templates/orchestration.json';
// Worded as an honest OBSERVATION, not a diagnosis (absence can mean old OR incomplete), and it makes
// NO claim about an orchestration.json seeding outcome (that depends on delegate-vs-fallback).
const MEMORY_BEHIND_NOTE =
  "the memory installed here doesn't include the current orchestration template — refresh it with `npx @sabaiway/agent-workflow-memory@latest init`, then restart the session.";

export const surveyFamily = (deps = {}) =>
  FAMILY_MEMBERS.map((member) => {
    const row = classifyMember(member, deps);
    if (row.kind === 'methodology-engine' && row.manifestState === OK && row.skillDir) {
      const fragmentUsable = (rel) => {
        try {
          readEngineFragment(row.skillDir, { source: 'default', rel, ...deps });
          return true;
        } catch {
          return false; // absent / non-file / unreadable fragment → the engine can't supply it
        }
      };
      const caveats = ENGINE_FRAGMENT_CAVEATS.filter((f) => !fragmentUsable(f.rel)).map((f) => f.caveat);
      if (caveats.length) row.caveats = caveats;
    }
    // Memory offline caveat (Step 2.2): a distinct probe — the orchestration TEMPLATE file's existence.
    // Only attach when it is provably ABSENT (a non-ENOENT probe error → 'unknown' → skip, never a
    // false "missing" claim). Mirrors the engine-caveat SHAPE; keyed on the Step-2.4 required asset.
    if (row.kind === 'memory-substrate' && row.manifestState === OK && row.skillDir) {
      if (probeMarker(join(row.skillDir, MEMORY_ORCH_TEMPLATE_REL), deps) === 'absent') {
        row.caveats = [...(row.caveats ?? []), MEMORY_BEHIND_NOTE];
      }
    }
    return row;
  });

// ── the DEPLOY axis ──────────────────────────────────────────────────────────────
// Read a one-line semver stamp (docs/ai/.workflow-version etc.). Returns the trimmed version or null.
const readStamp = (path, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? readFileSync;
  try {
    if (!exists(path)) return null;
    const v = String(read(path, 'utf8')).trim();
    return v.length ? v : null;
  } catch {
    return null;
  }
};

// Is our hidden-mode managed fence present? Resolve the exclude file via the SAME git-path-aware path
// hide-footprint uses (`git rev-parse --git-path info/exclude`), so a linked worktree / submodule is
// handled correctly (not the hardcoded `.git/info/exclude`). If git is unavailable or this is not a
// repo, fall back to the conventional path; any read error → not present (best-effort, read-only).
const hasHiddenFence = (projectDir, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const read = deps.readFile ?? readFileSync;
  const ep = (() => {
    try {
      return excludePath(deps, projectDir);
    } catch {
      return join(projectDir, '.git', 'info', 'exclude');
    }
  })();
  try {
    return exists(ep) && String(read(ep, 'utf8')).includes(START_MARKER);
  } catch {
    return false;
  }
};

// surveyProject → the deploy axis for a target project dir: the per-member deployment stamps, whether
// docs/ai/ exists, and whether the hidden-mode fence is present. Pure (fs reads only, all injectable),
// no git subprocess — the read-only `status` view must never mutate or spawn anything.
export const surveyProject = (projectDir, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const dir = resolve(projectDir);
  const stamps = FAMILY_MEMBERS
    .filter((m) => m.deployed)
    .map((m) => ({ name: m.name, file: m.deployed.file, version: readStamp(join(dir, m.deployed.file), deps) }));
  const docsAiPresent = (() => {
    try {
      return exists(join(dir, 'docs', 'ai'));
    } catch {
      return false;
    }
  })();
  const deployed = stamps.some((s) => s.version != null) || docsAiPresent;
  return { dir, deployed, docsAiPresent, hiddenFence: hasHiddenFence(dir, deps), stamps };
};

// ── report ───────────────────────────────────────────────────────────────────────
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// The human (non-JSON) settings render. A dev view — the agent consumes `--json` + renders in plain
// language (Mode: status). Each area shows its `error` field loudly when one fired.
const formatSettings = (s) => {
  const out = ['', 'settings'];
  if (s.recipes?.error) out.push(`  ${pad('recipes', 14)}error: ${s.recipes.error}`);
  else {
    const parts = [];
    for (const [act, slots] of Object.entries(s.recipes?.activities ?? {})) {
      for (const [slot, r] of Object.entries(slots)) parts.push(`${act}.${slot}=${r.recipe}`);
    }
    out.push(`  ${pad('recipes', 14)}${parts.join(' · ') || '—'}`);
    if (s.recipes?.detectError) out.push(`  ${pad('', 14)}↳ couldn't check backends (${s.recipes.detectError}); recipes floored at solo`);
  }
  if (s.attribution?.error) out.push(`  ${pad('attribution', 14)}error: ${s.attribution.error}`);
  else out.push(`  ${pad('attribution', 14)}includeCoAuthoredBy effective=${String(s.attribution?.effective)}`);
  if (s.velocity?.error) out.push(`  ${pad('velocity', 14)}error: ${s.velocity.error}`);
  else out.push(`  ${pad('velocity', 14)}defaultMode=${String(s.velocity?.defaultMode)} · allow project/local=${s.velocity?.allowEntries?.project}/${s.velocity?.allowEntries?.local}`);
  return out;
};

export const formatStatus = (family, project = null, extras = {}) => {
  const lines = ['agent-workflow family — installed skills (skill axis)', ''];
  for (const m of family) {
    const ver = m.version ? `v${m.version}` : '—';
    lines.push(`  ${pad(m.name, 26)}[${pad(m.manifestState, 16)}] ${pad(ver, 10)} ${m.kind}`);
    for (const c of m.caveats ?? []) lines.push(`      ↳ ${c}`);
  }
  if (extras.bridges) {
    const WRAP_MARK = { present: '✓', missing: '✗', unknown: '?' };
    lines.push('', 'execution backends (host)', '');
    for (const b of extras.bridges) {
      const w = b.wrappers.map((x) => `${x.cmd} ${WRAP_MARK[x.state] ?? '?'}`).join(', ') || '—';
      lines.push(`  ${pad(b.display, 20)}${pad(b.readiness, 18)}wrappers: ${w}`);
    }
  }
  if (project) {
    lines.push('', `project deployment (${project.dir})`, '');
    if (!project.deployed) {
      lines.push('  no agent-workflow deployment detected here (no docs/ai, no version stamp).');
    } else {
      for (const s of project.stamps) {
        lines.push(`  ${pad(s.file, 26)}${s.version ?? '—'}`);
      }
      lines.push(`  ${pad('docs/ai present', 26)}${project.docsAiPresent ? 'yes' : 'no'}`);
      if (extras.visibility) {
        lines.push(`  ${pad('visibility', 26)}${extras.visibility.error ? `error: ${extras.visibility.error}` : extras.visibility.state}`);
      } else {
        lines.push(`  ${pad('hidden-mode fence', 26)}${project.hiddenFence ? 'present' : 'absent'}`);
      }
    }
    if (extras.settings) lines.push(...formatSettings(extras.settings));
  }
  return lines.join('\n');
};

// ── the no-leak --json envelope ──────────────────────────────────────────────────
// A machine-readable view with USER-SAFE field names only — NEVER the internal manifestState /
// hiddenFence terms or the raw stamp FILENAMES. The render (SKILL.md version block + Mode: status)
// consumes THIS, never the human table verbatim. An envelope-shape test pins its shape so later phases
// (the settings/visibility block) can't silently break the Phase-2 version consumer.

// internal manifestState → a STABLE, user-safe token (SKILL.md owns the value→plain-language phrasing).
// Deliberately NOT the internal literals (foreign/stub/…): those must never leak past this boundary.
const STATE_PUBLIC = {
  [OK]: 'installed',
  [NOT_INSTALLED]: 'absent',
  [FOREIGN]: 'other-tool',
  [STUB]: 'placeholder',
  [INVALID_MANIFEST]: 'invalid',
  [UNSUPPORTED_SCHEMA]: 'unsupported',
  [UNKNOWN]: 'uncheckable',
};

// Short, user-facing labels for the version block (kit · memory · engine · codex-bridge · …), so the
// render is deterministic and the agent never invents a label.
export const DISPLAY_NAMES = {
  'agent-workflow-kit': 'kit',
  'agent-workflow-memory': 'memory',
  'agent-workflow-engine': 'engine',
  'codex-cli-bridge': 'codex-bridge',
  'antigravity-cli-bridge': 'antigravity-bridge',
};
const displayOf = (name) => DISPLAY_NAMES[name] ?? name;

// ── the settings survey (Phase 3) — read-only, honest, localized-on-error ──────────
// Each sub-survey returns a small user-safe object OR a single `{ error }` field (a localized message,
// never a crash): a malformed/unreadable file in ONE area must not break the rest of `status`. The
// readers are REUSED (one implementation each): loadConfig (procedures.mjs), readSettingsFile /
// resolveEffectiveMode (velocity-profile.mjs), resolveActivityRecipe (recipes.mjs), inferVisibility
// (hide-footprint.mjs). Engine-free throughout (the effective-recipe view never reads the engine).

// A localized, user-safe error string. The reused readers already build cwd-relative `path: reason`
// messages (loadConfig / velocity), so this just normalizes to a string — never a raw stack/abs path.
const localizeError = (err) => (err && err.message ? String(err.message) : String(err));

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// The backend detector is a SECONDARY input to the survey — a corrupt bridge must never break the
// read-only view, but the failure must NOT be silent (Hard Constraint). Run it defensively: a throw →
// { detection: [], error: <localized> } so callers floor gracefully (recipes → solo, bridges →
// 'unknown') AND can surface the concrete reason. Returns a value so callers stay `const`.
const detectSafe = (deps) => {
  try {
    return { detection: (deps.detect ?? detectBackends)(deps), error: null };
  } catch (err) {
    return { detection: [], error: localizeError(err) };
  }
};

// visibility: the THREE honest states from inferVisibility (NOT the single hiddenFence bit) → user-safe
// words. Never the internal "hidden fence" / marker terms. A git/probe error → a localized error field.
const VISIBILITY_PUBLIC = { visible: 'visible', hidden: 'hidden', ambiguous: 'unclear' };
export const surveyVisibility = (dir, deps = {}) => {
  try {
    const vis = inferVisibility(deps, resolve(dir));
    return { state: VISIBILITY_PUBLIC[vis.visibility] ?? 'unclear' };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// orchestration recipes: the EFFECTIVE recipe per slot (config · default · effective), engine-free —
// shared loadConfig + resolveActivityRecipe + the read-only backend detector. A malformed config → a
// localized error field; a detection failure floors at solo (a corrupt bridge must not break the view).
export const surveyRecipes = (dir, deps = {}) => {
  // A detector failure floors recipes at solo (mirrors procedures) but is surfaced as `detectError`, so
  // the render says "couldn't check backends" instead of letting a real solo-default look identical.
  const { detection, error: detectError } = detectSafe(deps);
  try {
    const { config, source } = loadConfig(resolve(dir), deps.readFile ?? readFileSync, deps.lstat ?? lstatSync);
    const activities = {};
    for (const [activity, def] of Object.entries(ACTIVITIES)) {
      activities[activity] = {};
      for (const slot of Object.keys(def.slots)) {
        const r = resolveActivityRecipe({ config: config ?? {}, readiness: detection, activity, slot });
        activities[activity][slot] = { recipe: r.recipe, source: r.source, degradedFrom: r.degradedFrom ?? null };
      }
    }
    return { configSource: source, activities, ...(detectError ? { detectError } : {}) };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// attribution: includeCoAuthoredBy across .claude/settings.json + settings.local.json as
// project · local override · effective (local WINS only when it actually sets the key — presence-based,
// mirroring resolveEffectiveMode). Reuses the loud readSettingsFile; the precedence read is new code.
export const surveyAttribution = (dir, deps = {}) => {
  try {
    const d = resolve(dir);
    const project = readSettingsFile(join(d, SETTINGS_FILE), { ...deps, cwd: d });
    const local = readSettingsFile(join(d, SETTINGS_LOCAL_FILE), { ...deps, cwd: d });
    const projVal = project.present && hasOwn(project.data, 'includeCoAuthoredBy') ? project.data.includeCoAuthoredBy : null;
    const localHasKey = local.present && hasOwn(local.data, 'includeCoAuthoredBy');
    const localVal = localHasKey ? local.data.includeCoAuthoredBy : null;
    return { project: projVal, local: localVal, effective: localHasKey ? localVal : projVal };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// velocity: the effective permissions.defaultMode (local > project, via resolveEffectiveMode) + the
// per-source count of allowlist entries — a read-only view of what the velocity profile may have seeded.
export const surveyVelocity = (dir, deps = {}) => {
  try {
    const d = resolve(dir);
    const project = readSettingsFile(join(d, SETTINGS_FILE), { ...deps, cwd: d });
    const local = readSettingsFile(join(d, SETTINGS_LOCAL_FILE), { ...deps, cwd: d });
    const { effectiveMode } = resolveEffectiveMode(project.data, local.data);
    const allowOf = (s) => (s.present && Array.isArray(s.data?.permissions?.allow) ? s.data.permissions.allow.length : 0);
    return { defaultMode: effectiveMode ?? null, allowEntries: { project: allowOf(project), local: allowOf(local) } };
  } catch (err) {
    return { error: localizeError(err) };
  }
};

// the project-scoped settings survey (needs a project dir). Each area is independently localized-on-error.
export const surveySettings = (dir, deps = {}) => ({
  recipes: surveyRecipes(dir, deps),
  attribution: surveyAttribution(dir, deps),
  velocity: surveyVelocity(dir, deps),
});

// bridges: HOST-scoped (no project needed). Wrapper command NAMES come from FAMILY_MEMBERS[].wrapperCmds
// (static, always present), their PATH-presence is probed DIRECTLY via findOnPath over those names (NOT
// detect-backends' wrappers[], which is [] when the bridge isn't ok — the onboarding case), and the
// readiness summary comes from the detector. NO default-model claim (a negative drift-guard asserts it).
export const surveyBridges = (deps = {}) => {
  const { detection } = detectSafe(deps); // a detector failure → every readiness reads 'unknown' (honest)
  const probe = deps.findOnPath ?? findOnPath;
  return FAMILY_MEMBERS.filter((m) => m.kind === 'execution-backend').map((m) => {
    const det = detection.find((d) => d.name === m.name);
    // Preserve findOnPath's THREE-state result (present | missing | unknown): an `unknown` (EACCES,
    // "cannot confirm") must stay distinct from a real `missing` — never flattened to a false boolean.
    const wrappers = m.wrapperCmds.map((cmd) => ({ cmd, state: probe(cmd, deps).state }));
    return { member: m.name, display: displayOf(m.name), readiness: det?.readiness ?? 'unknown', wrappers };
  });
};

export const buildEnvelope = (family, project = null, extras = {}) => {
  const installed = family.map((m) => {
    const entry = {
      member: m.name,
      display: displayOf(m.name),
      version: m.version ?? null,
      state: STATE_PUBLIC[m.manifestState] ?? STATE_PUBLIC[UNKNOWN],
    };
    if (m.caveats?.length) entry.notes = m.caveats; // plain-language observations (Steps 2.2 / engine)
    return entry;
  });
  const envelope = { deploymentHead: EXPECTED_WORKFLOW_VERSION, installed };
  if (extras.bridges) envelope.bridges = extras.bridges; // HOST-scoped (no project needed)
  if (project) {
    envelope.project = {
      dir: project.dir,
      deployed: project.deployed,
      docsAi: project.docsAiPresent,
      // member + display + version only — never the internal stamp FILENAME (s.file).
      deployStamps: project.stamps.map((s) => ({ member: s.name, display: displayOf(s.name), version: s.version ?? null })),
    };
    // project-scoped Phase-3 additions (visibility from inferVisibility, not the hiddenFence bit).
    if (extras.visibility) envelope.project.visibility = extras.visibility;
    if (extras.settings) envelope.project.settings = extras.settings;
  }
  return envelope;
};

// ── CLI ────────────────────────────────────────────────────────────────────────
const parseArgs = (argv) => {
  const dirFlag = argv.indexOf('--dir');
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    json: argv.includes('--json'),
    dir: dirFlag >= 0 ? argv[dirFlag + 1] : undefined,
  };
};

const main = (argv) => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`family-registry — read-only view of the agent-workflow family.

Usage:
  node family-registry.mjs [--dir <project>] [--json]
    # skill axis always; deploy axis when --dir is given; --json = the no-leak machine envelope

Detection only — never writes, never commits, never runs a subscription CLI.`);
    return;
  }
  const family = surveyFamily();
  const bridges = surveyBridges();
  const project = args.dir ? surveyProject(args.dir) : null;
  const extras = { bridges };
  if (args.dir) {
    extras.visibility = surveyVisibility(args.dir);
    extras.settings = surveySettings(args.dir);
  }
  console.log(args.json ? JSON.stringify(buildEnvelope(family, project, extras), null, 2) : formatStatus(family, project, extras));
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));

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

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { resolveDir } from './detect-backends.mjs';
import { validateManifest, readAuthoritativeVersion, UNSUPPORTED, INVALID } from './manifest/validate.mjs';
import { START_MARKER, excludePath } from './hide-footprint.mjs';
import { readEngineFragment, ORCHESTRATION_FRAGMENT_REL } from './engine-source.mjs';

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
// Wrapped marker probe → 'present' (a regular file) | 'absent' (ENOENT / not a file) | 'unknown' (a
// non-ENOENT fs error, e.g. EACCES). 'unknown' is NOT collapsed to 'absent': a permission error must
// surface, never be masked as not-installed (no silent failure) — and uninstall then leaves it alone.
const probeMarker = (path, deps = {}) => {
  const exists = deps.exists ?? existsSync;
  const stat = deps.stat ?? statSync;
  try {
    if (!exists(path)) return 'absent';
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

// An engine OLDER than 1.2.0 has a valid manifest + version but ships no orchestration-recipes
// fragment (references/orchestration-slot.md), so it cannot supply the recipes pointer the kit
// injects. surveyFamily attaches a plain-language caveat to that engine row instead of a bare "ok".
// The check mirrors what a RECONCILE actually does — `readEngineFragment(..., { rel: orchestration })`
// validates the manifest AND reads the fragment — so an absent, non-file, OR present-but-unreadable
// fragment all surface as a caveat (status never claims "ok" for a fragment the reconcile would STOP
// on), and a current, readable fragment never gets the caveat. Read-only, best-effort.
export const surveyFamily = (deps = {}) =>
  FAMILY_MEMBERS.map((member) => {
    const row = classifyMember(member, deps);
    if (row.kind === 'methodology-engine' && row.manifestState === OK && row.skillDir) {
      const orchUsable = (() => {
        try {
          readEngineFragment(row.skillDir, { source: 'default', rel: ORCHESTRATION_FRAGMENT_REL, ...deps });
          return true;
        } catch {
          return false; // absent / non-file / unreadable fragment → the engine can't supply the pointer
        }
      })();
      if (!orchUsable) {
        row.caveat = 'engine present but does not supply the recipes pointer (too old / incomplete) — run `npx @sabaiway/agent-workflow-engine@latest init`';
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

export const formatStatus = (family, project = null) => {
  const lines = ['agent-workflow family — installed skills (skill axis)', ''];
  for (const m of family) {
    const ver = m.version ? `v${m.version}` : '—';
    lines.push(`  ${pad(m.name, 26)}[${pad(m.manifestState, 16)}] ${pad(ver, 10)} ${m.kind}`);
    if (m.caveat) lines.push(`      ↳ ${m.caveat}`);
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
      lines.push(`  ${pad('hidden-mode fence', 26)}${project.hiddenFence ? 'present' : 'absent'}`);
    }
  }
  return lines.join('\n');
};

// ── CLI ────────────────────────────────────────────────────────────────────────
const parseArgs = (argv) => {
  const dirFlag = argv.indexOf('--dir');
  return { help: argv.includes('--help') || argv.includes('-h'), dir: dirFlag >= 0 ? argv[dirFlag + 1] : undefined };
};

const main = (argv) => {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`family-registry — read-only view of the agent-workflow family.

Usage:
  node family-registry.mjs [--dir <project>]   # skill axis always; deploy axis when --dir is given

Detection only — never writes, never commits, never runs a subscription CLI.`);
    return;
  }
  const family = surveyFamily();
  const project = args.dir ? surveyProject(args.dir) : null;
  console.log(formatStatus(family, project));
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));

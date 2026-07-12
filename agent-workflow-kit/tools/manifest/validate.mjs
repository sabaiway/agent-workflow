#!/usr/bin/env node
// Family-wide capability.json validator — OWNED AND SHIPPED BY THE KIT (the composition
// root legitimately knows the whole family). Pure Node, JSON.parse, dependency-free.
//
// Shipped in the kit's tarball + installer PAYLOAD so an *installed* kit can run it as the
// memory detector (SKILL.md §"delegate-else-fallback"); root CI invokes this SAME file over
// every real capability.json. It lives in the kit, never in memory (preserving memory's
// "knows nobody"): a DAG, no cycle.
//
// Three result classes:
//   valid        — well-formed, schema understood, every check passes.
//   unsupported  — schema number this validator does not understand (forward-compat).
//   invalid      — schema understood but a check failed (malformed, missing, mismatched).
// Runtime callers (the kit detector) treat unsupported AND invalid alike: DO NOT act, fall
// back. Authoring/CI runs with `--strict` and exits non-zero on unsupported OR invalid.
//
// Usage:
//   node validate.mjs <skill-dir>...            # report, always exit 0 (informational)
//   node validate.mjs --strict <skill-dir>...   # exit 1 if any dir is not "valid"

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAMILY = 'agent-workflow';
export const SUPPORTED_SCHEMA = 1;
export const KINDS = new Set([
  'memory-substrate',
  'methodology-engine',
  'execution-backend',
  'composition-root',
]);
export const ROLE_VOCAB = new Set(['context', 'plan', 'execute', 'review', 'probe', 'synthesize']);

export const VALID = 'valid';
export const UNSUPPORTED = 'unsupported';
export const INVALID = 'invalid';

// Typed settings-value grammar (D6, bridges 2.3.0) — the ONE predicate the manifest validator (for a
// declared `default`), the kit-side bridge-settings writer (for a user-supplied value), and — mirrored
// in shell as aw_settings_valid — the wrappers all use, so a value the writer accepts is exactly a
// value a wrapper honors. A value is always compared as a STRING (the settings-file wire format).
export const SETTING_KINDS = new Set(['enum', 'integer', 'duration', 'boolean']);
// The wrappers' shell duration grammar: a unit suffix is REQUIRED (a bare integer is invalid), and
// zero durations are rejected — `timeout 0` DISABLES a hard cap, so a persistent settings line could
// otherwise silently remove the stall guard.
export const DURATION_RE = /^[0-9]+(\.[0-9]+)?[smhd]$/;
export const ZERO_DURATION_RE = /^0+(\.0+)?[smhd]$/;
export const settingValueValid = (entry, value) => {
  switch (entry.kind) {
    case 'enum': return Array.isArray(entry.values) && entry.values.includes(value);
    case 'integer': {
      if (!/^[0-9]+$/.test(value)) return false;
      const n = Number(value);
      return Number.isSafeInteger(n) && n >= entry.min && n <= entry.max;
    }
    case 'duration': return DURATION_RE.test(value) && !ZERO_DURATION_RE.test(value);
    case 'boolean': return value === '0' || value === '1';
    default: return false;
  }
};

const hasTraversal = (p) => p.split(/[\\/]/).includes('..');
const isUnresolved = (s) => /\{\{|\}\}|\$\{/.test(s);

// A `networkHosts` entry: a bare dotted hostname, optionally a `*.` family wildcard — never a
// scheme, a path, a port, or whitespace (the entry is pasted verbatim into an allowlist line).
export const NETWORK_HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Cross-platform "absolute-like": POSIX root (/x), Windows drive (C:\ or C:/), UNC (\\host),
// or a leading backslash. node:path.isAbsolute() alone is platform-dependent, so a Windows path
// would slip through unchecked on a POSIX CI runner — Windows-safety requires rejecting both.
const isAbsoluteLike = (p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p) || p.startsWith('\\');

const collectStrings = (val, acc = []) => {
  if (typeof val === 'string') acc.push(val);
  else if (Array.isArray(val)) val.forEach((v) => collectStrings(v, acc));
  else if (val && typeof val === 'object') Object.values(val).forEach((v) => collectStrings(v, acc));
  return acc;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
// Parse the `version:` that is a DIRECT child of the `metadata:` block — not the first `version:`
// anywhere in the frontmatter (so an unrelated top-level `version:` is ignored) and not a deeper
// nested `version:` (so `metadata: { foo: { version } }` is ignored). The direct-child indent is
// fixed by the first child line of the block.
const readSkillVersion = (text) => {
  const fm = text.match(FRONTMATTER_RE);
  if (!fm) return null;
  const lines = fm[1].split('\n');
  const metaIdx = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metaIdx === -1) return null;
  const block = [];
  for (const line of lines.slice(metaIdx + 1)) {
    if (line.trim() === '') continue; // tolerate blank lines inside the block
    if (/^\S/.test(line)) break; // dedent → left the metadata block
    block.push(line);
  }
  if (block.length === 0) return null;
  const childIndent = block[0].match(/^(\s+)/)[1];
  const directChild = new RegExp(`^${childIndent}version:\\s*['"]?(\\d+\\.\\d+\\.\\d+)['"]?\\s*$`);
  const match = block.map((line) => line.match(directChild)).find(Boolean);
  return match ? match[1] : null;
};

// Authoritative version source: package.json where one exists, else SKILL.md
// frontmatter metadata.version. So a bridge (no package.json) can't drift from its SKILL.md.
// Exported so the family registry (tools/family-registry.mjs) reports an INSTALLED member's
// version from the SAME authoritative source the validator checks — no second, drifting reader.
export const readAuthoritativeVersion = (skillDir) => {
  const pkgPath = join(skillDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return { version: pkg.version ?? null, from: 'package.json' };
    } catch {
      return { version: null, from: 'package.json (unparseable)' };
    }
  }
  const skillPath = join(skillDir, 'SKILL.md');
  if (existsSync(skillPath)) {
    return { version: readSkillVersion(readFileSync(skillPath, 'utf8')), from: 'SKILL.md metadata.version' };
  }
  return { version: null, from: 'no package.json or SKILL.md' };
};

export const validateManifest = (skillDir) => {
  const manifestPath = join(skillDir, 'capability.json');
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    return { result: INVALID, errors: [`capability.json not found in ${skillDir}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    return { result: INVALID, errors: [`malformed JSON: ${err.message}`] };
  }

  // Valid JSON that is not an object (null, array, string, number) would crash field access —
  // classify as invalid so runtime callers fall back instead of throwing.
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { result: INVALID, errors: ['top-level capability.json must be a JSON object'] };
  }

  // Schema gate first — an unknown schema is *unsupported*, distinct from *invalid*.
  if (typeof manifest.schema !== 'number') {
    return { result: INVALID, name: manifest.name, errors: ['`schema` missing or not a number'] };
  }
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    return {
      result: UNSUPPORTED,
      name: manifest.name,
      errors: [`unsupported schema ${manifest.schema} (this validator understands ${SUPPORTED_SCHEMA})`],
    };
  }

  const errors = [];
  const requireString = (key) => {
    if (typeof manifest[key] !== 'string' || !manifest[key]) errors.push(`\`${key}\` must be a non-empty string`);
  };
  requireString('family');
  requireString('name');
  requireString('kind');
  requireString('version');
  if (manifest.family !== FAMILY) errors.push(`\`family\` must be "${FAMILY}"`);
  if (typeof manifest.kind === 'string' && !KINDS.has(manifest.kind)) errors.push(`unknown \`kind\` "${manifest.kind}"`);
  if (manifest.available != null && typeof manifest.available !== 'boolean') errors.push('`available`, if present, must be a boolean');
  if (!Array.isArray(manifest.provides)) errors.push('`provides` must be an array');
  const rolesOk = manifest.roles != null && typeof manifest.roles === 'object' && !Array.isArray(manifest.roles);
  if (!rolesOk) errors.push('`roles` must be an object');

  const provides = Array.isArray(manifest.provides) ? manifest.provides : [];
  for (const p of provides) if (!ROLE_VOCAB.has(p)) errors.push(`\`provides\` lists unknown role "${p}"`);
  const roles = rolesOk ? manifest.roles : {};
  for (const key of Object.keys(roles)) {
    if (!ROLE_VOCAB.has(key)) errors.push(`role "${key}" is not in the role vocabulary`);
    if (!provides.includes(key)) errors.push(`role "${key}" is missing from \`provides\` (provides ⊇ Object.keys(roles))`);
  }

  for (const s of collectStrings(manifest)) {
    if (isUnresolved(s)) errors.push(`unresolved placeholder in "${s}"`);
  }

  const isStub = manifest.available === false;

  // In-skill path: repo-relative, no absolute, no "~", no "..", and (unless a stub) must exist.
  const checkInSkillPath = (label, value, mustExist) => {
    if (typeof value !== 'string' || !value) {
      errors.push(`${label} must be a non-empty string`);
      return;
    }
    let bad = false;
    if (isAbsoluteLike(value)) {
      errors.push(`${label} must not be an absolute path ("${value}")`);
      bad = true;
    }
    if (value.startsWith('~')) {
      errors.push(`${label} must be repo-relative within the skill, not home-relative ("${value}")`);
      bad = true;
    }
    if (hasTraversal(value)) {
      errors.push(`${label} must not contain ".." traversal ("${value}")`);
      bad = true;
    }
    if (mustExist && !bad && !existsSync(join(skillDir, value))) {
      errors.push(`${label} not found in the skill dir: "${value}"`);
    }
  };

  const detect = manifest.detect;
  if (detect != null) {
    if (typeof detect !== 'object' || Array.isArray(detect)) {
      errors.push('`detect` must be an object');
    } else {
      const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
      const inst = detect.installed;
      if (inst != null && !isPlainObject(inst)) {
        errors.push('`detect.installed` must be an object');
      } else if (inst != null) {
        if (inst.env != null && typeof inst.env !== 'string') errors.push('`detect.installed.env` must be a string (env var name)');
        if (inst.default != null) {
          if (typeof inst.default !== 'string') errors.push('`detect.installed.default` must be a string');
          else {
            // `default` may be home-relative (~/…); reject only true absolute/traversal forms.
            if (isAbsoluteLike(inst.default)) errors.push('`detect.installed.default` must not be an absolute path');
            if (hasTraversal(inst.default)) errors.push('`detect.installed.default` must not contain ".."');
          }
        }
        if (inst.file != null) checkInSkillPath('`detect.installed.file`', inst.file, !isStub);
      }
      const dep = detect.deployed;
      if (dep != null && !isPlainObject(dep)) {
        errors.push('`detect.deployed` must be an object');
      } else if (dep != null && dep.file != null) {
        if (typeof dep.file !== 'string') errors.push('`detect.deployed.file` must be a string');
        else {
          if (isAbsoluteLike(dep.file)) errors.push('`detect.deployed.file` must not be an absolute path');
          if (dep.file.startsWith('~')) errors.push('`detect.deployed.file` must be project-relative, not home-relative');
          if (hasTraversal(dep.file)) errors.push('`detect.deployed.file` must not contain ".."');
        }
      }
    }
  }

  for (const [key, role] of Object.entries(roles)) {
    if (role == null || typeof role !== 'object' || Array.isArray(role)) {
      errors.push(`role "${key}" must be an object`);
      continue;
    }
    if (typeof role.cmd !== 'string' || !role.cmd) errors.push(`role "${key}".cmd must be a non-empty string (the PATH name)`);
    if (role.source == null) errors.push(`role "${key}".source is required (the in-skill script; cmd is the PATH name, source is validated)`);
    else checkInSkillPath(`role "${key}".source`, role.source, !isStub);
    if (role.template != null) checkInSkillPath(`role "${key}".template`, role.template, !isStub);
  }

  // Typed `settings` block (bridges 2.3.0, D6 manifest-as-source): the per-bridge settings-file
  // surface — an ARRAY of typed entries (a JSON object would silently dedupe duplicate keys under
  // JSON.parse). Unlike the AD-033 `contract` block (validator-tolerated, externally
  // drift-guarded), a malformed `settings` entry FAILS validation: the kit writer, the status
  // renderers, and the wrapper shell constants all consume this block, so a bad entry would
  // corrupt a host-level config surface.
  const settings = manifest.settings;
  if (settings != null) {
    if (!Array.isArray(settings)) {
      errors.push('`settings` must be an array of setting entries');
    } else {
      const cmds = new Set(Object.values(roles)
        .map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r.cmd : null))
        .filter((c) => typeof c === 'string' && c));
      const seenKeys = new Set();
      settings.forEach((entry, i) => {
        const at = `\`settings[${i}]\``;
        if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${at} must be an object`);
          return;
        }
        if (typeof entry.key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entry.key)) {
          errors.push(`${at}.key must be an UPPER_SNAKE_CASE string`);
        } else if (seenKeys.has(entry.key)) {
          errors.push(`duplicate settings key "${entry.key}" (${at})`);
        } else {
          seenKeys.add(entry.key);
        }
        if (typeof entry.effect !== 'string' || !entry.effect) errors.push(`${at}.effect must be a non-empty string`);
        if (!Array.isArray(entry.appliesTo) || entry.appliesTo.length === 0
            || !entry.appliesTo.every((c) => typeof c === 'string' && c)) {
          errors.push(`${at}.appliesTo must be a non-empty array of wrapper cmd names`);
        } else {
          for (const c of entry.appliesTo) {
            if (!cmds.has(c)) errors.push(`${at}.appliesTo names "${c}" which is no roles.*.cmd of this manifest`);
          }
        }
        if (!SETTING_KINDS.has(entry.kind)) {
          errors.push(`${at}.kind must be one of enum|integer|duration|boolean`);
          return; // the typed checks below are meaningless without a kind
        }
        if (entry.kind === 'enum'
            && (!Array.isArray(entry.values) || entry.values.length === 0
              || !entry.values.every((v) => typeof v === 'string' && v)
              || new Set(entry.values).size !== entry.values.length)) {
          errors.push(`${at}.values must be a non-empty array of unique non-empty strings (enum kind)`);
        }
        if (entry.kind === 'integer'
            && (!Number.isSafeInteger(entry.min) || !Number.isSafeInteger(entry.max) || entry.min > entry.max)) {
          errors.push(`${at}.min/.max must be integers with min <= max (integer kind)`);
        }
        if (!Object.hasOwn(entry, 'default')) {
          errors.push(`${at}.default is required (null = the wrapper built-ins apply)`);
        } else if (entry.default != null
            && (typeof entry.default !== 'string' || !settingValueValid(entry, entry.default))) {
          errors.push(`${at}.default must be null or a string value that passes the ${entry.kind} validation`);
        }
      });
    }
  }

  // `networkHosts` (AD-044 Plan 4, consult-locked): the backend CLI's OBSERVED egress host
  // families — a DOCUMENTATION source for hand-applied sandbox/network allowlists. The kit never
  // seeds these into settings (exclusion stays primary; a network pre-allow widens egress for
  // EVERY sandboxed command), but a malformed list FAILS --strict like `settings`: the
  // Recommendations advisor renders it verbatim, so a bad entry would corrupt a pasted line.
  const networkHosts = manifest.networkHosts;
  if (networkHosts != null) {
    if (!Array.isArray(networkHosts) || networkHosts.length === 0) {
      errors.push('`networkHosts` must be a non-empty array of host strings');
    } else {
      const seenHosts = new Set();
      networkHosts.forEach((host, i) => {
        if (typeof host !== 'string' || !NETWORK_HOST_RE.test(host)) {
          errors.push(`\`networkHosts[${i}]\` must be a bare hostname or a *.family wildcard (${JSON.stringify(host)})`);
          return;
        }
        if (seenHosts.has(host)) errors.push(`duplicate networkHosts entry "${host}" (\`networkHosts[${i}]\`)`);
        else seenHosts.add(host);
      });
    }
  }

  // `writableDirs` (REC-UX-REWORK, D6): the backend CLI's writable state-dir declarations —
  // {env, default} entries the Recommendations advisor RESOLVES at run time (a NON-EMPTY env
  // value wins, else the default) and renders into the sandbox-lane recipe. Like `networkHosts`
  // this is a DOCUMENTATION source (the kit never seeds filesystem allowances), and a malformed
  // list FAILS --strict for the same reason: the resolved dir is rendered into a hand-applied line.
  const writableDirs = manifest.writableDirs;
  if (writableDirs != null) {
    if (!Array.isArray(writableDirs) || writableDirs.length === 0) {
      errors.push('`writableDirs` must be a non-empty array of {env, default} entries');
    } else {
      const seenDefaults = new Set();
      writableDirs.forEach((entry, i) => {
        const at = `\`writableDirs[${i}]\``;
        if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`${at} must be an {env, default} object`);
          return;
        }
        if (entry.env !== null && (typeof entry.env !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entry.env))) {
          errors.push(`${at}.env must be null or an UPPER_SNAKE_CASE env-var name (${JSON.stringify(entry.env)})`);
        }
        const dir = entry.default;
        if (typeof dir !== 'string' || !(dir.startsWith('~/') || dir.startsWith('/'))) {
          errors.push(`${at}.default must be a \`~/\`-anchored or absolute POSIX path (${JSON.stringify(dir)})`);
          return;
        }
        if (/[*?[\]]/.test(dir)) errors.push(`${at}.default must not carry glob characters ("${dir}")`);
        // The resolved dir is rendered into a ONE-LINE hand-applied recipe — a control character
        // (newline, CR, NUL, …) would break the line or the shell paste.
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f]/.test(dir)) errors.push(`${at}.default must not carry control characters (${JSON.stringify(dir)})`);
        if (dir.endsWith('/')) errors.push(`${at}.default must not end with a trailing slash ("${dir}")`);
        if (hasTraversal(dir)) errors.push(`${at}.default must not contain ".." traversal ("${dir}")`);
        if (seenDefaults.has(dir)) errors.push(`duplicate writableDirs default "${dir}" (${at})`);
        else seenDefaults.add(dir);
      });
    }
  }

  if (!isStub) {
    const auth = readAuthoritativeVersion(skillDir);
    if (auth.version == null) errors.push(`could not resolve an authoritative version (${auth.from})`);
    else if (typeof manifest.version === 'string' && manifest.version !== auth.version) {
      errors.push(`\`version\` "${manifest.version}" != ${auth.from} "${auth.version}"`);
    }
  }

  return {
    result: errors.length ? INVALID : VALID,
    name: manifest.name,
    kind: manifest.kind,
    available: manifest.available !== false, // false only when explicitly declared a stub
    errors,
  };
};

const main = (argv) => {
  const strict = argv.includes('--strict');
  const dirs = argv.filter((a) => a !== '--strict');
  if (dirs.length === 0) {
    console.error('usage: validate.mjs [--strict] <skill-dir>...');
    process.exit(2);
  }
  let notValid = 0;
  for (const dir of dirs) {
    const report = validateManifest(resolve(dir));
    console.log(`[${report.result.toUpperCase()}] ${dir}${report.name ? ` (${report.name})` : ''}`);
    for (const err of report.errors) console.log(`    - ${err}`);
    if (report.result !== VALID) notValid += 1;
  }
  if (strict && notValid > 0) process.exit(1);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));

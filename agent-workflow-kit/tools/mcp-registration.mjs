// mcp-registration.mjs — the READ-ONLY half of the `mcp` mode: is the kit's stdio MCP server
// registered in THIS project? It answers for two consumers that must never reach a writer — the
// `mcp-channel` advisor item and `uninstall`'s report — and the writer (mcp.mjs) composes its bodies
// from the same merges, so "what is there" and "what would be written" can never drift apart.
//
// Split out for the reason bridge-settings-read.mjs was (bridges 2.3.0, D6): a read-only consumer
// that imports the writer pulls in the atomic-write core, which read-graph-purity.test.mjs forbids.
// That is also why the two settings-path literals are NOT imported from velocity-profile.mjs (a
// write module) — the equality is pinned by a test instead.
//
// It reads through fs-read-nofollow.mjs rather than velocity's readSettingsFile because that reader
// follows a symlink: a symlinked `.mcp.json` whose TARGET is a perfect registration would report
// registered over a file the writer must refuse to touch. Every never-committable dirent class
// (the sandbox's own device masks, a FIFO, a socket) is a NAMED state, classified by lstat BEFORE
// any open. Nothing here throws: every failure is a state with its own reason.
//
// RESIDUAL, stated as a BOUNDARY. What this module closes is the STATIC case: a symlink, device,
// FIFO or socket ALREADY at a path is classified, named, and never read — a target decided FOREIGN
// is never opened. (A target decided REGULAR is of course opened; that is the read.)
//
// Against a path that CHANGES under it, this module promises nothing, and the two races are NOT the
// same shape:
//   • the LEAF is protected by the shared reader as far as a path-based reader can go — it opens
//     `O_NOFOLLOW`, fstats the DESCRIPTOR and reads through it, so a swapped SYMLINK cannot be
//     followed. What it cannot catch is substitution by another REGULAR FILE, which needs the open
//     bound to an earlier inode observation — inside fs-read-nofollow.mjs, which four consumers
//     share, so that is the leaf's decision rather than this one's.
//   • the CONTAINER cannot be closed that way at all: no property of the leaf's descriptor says
//     anything about the directory the path was resolved through. That needs directory-relative
//     opening (`openat`), which Node does not expose — so it is a platform limit, not a missing check.
// Classifying `.claude` before reading inside it closes the STATIC symlinked container — the real and
// reachable case, where a settings file outside the work tree became a verdict; a container swapped
// mid-flight is not closed, for the reason above. Earlier drafts of this comment enumerated windows
// and were corrected three rounds running, each time for being one window too generous. The bar this
// module meets: no STATIC foreign path is followed or read, and no target decided FOREIGN is opened.
//
// Dependency-free, Node >= 22. No writes, no CLI, no side effects on import.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeNonRegular, lstatNoFollowRead, readRegularFileNoFollow } from './fs-read-nofollow.mjs';
import { refuseDirectRun } from './direct-run.mjs';
import { SERVER_NAME, TOOLS } from './mcp-server.mjs';

export { SERVER_NAME };

export const MCP_JSON_REL = '.mcp.json';
export const CLAUDE_DIR_REL = '.claude';
export const SETTINGS_REL = '.claude/settings.json';
export const SERVERS_KEY = 'mcpServers';
export const ENABLED_KEY = 'enabledMcpjsonServers';
// OUT OF SCOPE, deliberately and by name: `disabledMcpjsonServers`. A server listed there is rejected
// by the client in every mode, so a project can hold our entry, the enable and both rules and still
// have a dark channel — this mode does NOT detect that, and `registered` therefore means "the three
// things this mode writes are in place", never "the client will load it".
//
// It was implemented during review and then SUBTRACTED. The reason is worth keeping: honouring a veto
// means reading it from every scope the client merges, and each scope has its own masked, symlinked,
// malformed and unreadable states — in each of which a hidden deny still yields a confident answer.
// Three review rounds each closed one such hole and opened the next. A check that is wrong in states
// it cannot enumerate is worse than a stated limit, so this is the stated limit.
// The RUNNING kit copy's own server — the args entry a registration must carry to reach THIS kit.
export const DEFAULT_SERVER_PATH = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url));

export const STATE = Object.freeze({
  ABSENT: 'absent',
  MASKED: 'masked',
  FOREIGN: 'foreign',
  UNREADABLE: 'unreadable',
  MALFORMED: 'malformed',
  PRESENT: 'present',
});

const LF = '\n';
const CRLF = '\r\n';
const JSON_INDENT = 2;

// The two allow rules a client needs, derived from the server's own name + tool list — never a
// re-typed pair (a renamed tool would otherwise ship a rule nothing grants).
export const allowRulesFor = (tools = TOOLS) => tools.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`);

export const buildServerEntry = (serverPath) => ({ type: 'stdio', command: 'node', args: [serverPath] });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Key-order-independent structural identity: an entry that differs only in key order is the SAME
// registration, while an extra key, a different command or a different arg is a real difference.
const stable = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};

// The never-committable stat classes (core-evidence's own review-domain rule, re-decided here rather
// than imported: core-evidence reaches the atomic-write core and this module may not).
const isMaskStat = (st) => st.isCharacterDevice() || st.isBlockDevice() || st.isFIFO() || st.isSocket();

// lstat FIRST, then read: the classification decides whether an open may happen at all, so a FIFO is
// never opened and a symlink is never followed.
const readTarget = (abs, io) => {
  let st;
  try {
    st = lstatNoFollowRead(abs, io.lstat);
  } catch (err) {
    return { state: STATE.UNREADABLE, reason: (err && (err.code || err.message)) || 'lstat failed' };
  }
  if (st === null) return { state: STATE.ABSENT };
  if (isMaskStat(st)) return { state: STATE.MASKED, className: describeNonRegular(st) };
  if (!st.isFile()) return { state: STATE.FOREIGN, className: describeNonRegular(st) };
  const r = readRegularFileNoFollow(abs, io);
  if (r.outcome === 'absent') return { state: STATE.ABSENT };
  if (r.outcome === 'foreign') return { state: STATE.FOREIGN, className: r.className };
  if (r.outcome !== 'ok') return { state: STATE.UNREADABLE, reason: r.code };
  return { state: STATE.PRESENT, text: r.content };
};

const eolOf = (text) => (text.includes(CRLF) ? CRLF : LF);

// A file we cannot parse is MALFORMED with its own reason — never an empty object, which would let a
// writer clobber a file it never understood.
const parseJsonText = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { state: STATE.MALFORMED, reason: `not valid JSON (${(err && err.message) || 'parse failed'})` };
  }
  if (!isPlainObject(data)) return { state: STATE.MALFORMED, reason: 'the root is not a JSON object' };
  return { state: STATE.PRESENT, data };
};

// A MANAGED key of the wrong type is MALFORMED, not "empty". Reading it as an empty container and
// merging over it DESTROYS whatever it held — the merge-through-clobber `gate-hook.mjs`
// (assertHooksShape) already refuses for its own `hooks` key. Only the four keys this mode writes are
// judged; a foreign key of any shape is data, carried over untouched and never inspected.
const wrongType = (key, expected) => `carrying a "${key}" key that is not ${expected}`;

const NEUTRAL_ENTRY = { hasEntry: false, existing: null, matches: false, differs: false };

// The two decisions over TEXT. Exported because a consumer that already holds the bytes — the
// uninstaller, which reads every surface through its own injected fs — must answer "is this OUR
// registration?" by the SAME rule the reader uses, not by a second copy of it.
export const decideMcpJsonText = (text, entry) => {
  const parsed = parseJsonText(text);
  const eol = eolOf(text);
  if (parsed.state !== STATE.PRESENT) return { ...parsed, eol, ...NEUTRAL_ENTRY };
  const servers = parsed.data[SERVERS_KEY];
  if (servers !== undefined && !isPlainObject(servers)) {
    return { state: STATE.MALFORMED, eol, reason: wrongType(SERVERS_KEY, 'a JSON object'), ...NEUTRAL_ENTRY };
  }
  // PRESENCE is hasOwnProperty, never `value !== null`: a key that is THERE is a declaration this
  // mode may refuse but must never replace — a literal `null` included.
  const hasEntry = isPlainObject(servers) && Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const existing = hasEntry ? servers[SERVER_NAME] : null;
  const matches = hasEntry && stable(existing) === stable(entry);
  return { ...parsed, eol, hasEntry, existing, matches, differs: hasEntry && !matches };
};

export const decideSettingsText = (text, allowRules) => {
  const parsed = parseJsonText(text);
  const eol = eolOf(text);
  const neutral = { enabled: false, allowPresent: [], allowMissing: allowRules, complete: false };
  if (parsed.state !== STATE.PRESENT) return { ...parsed, eol, ...neutral };
  const malformed = (reason) => ({ state: STATE.MALFORMED, eol, reason, ...neutral });
  const enabledList = parsed.data[ENABLED_KEY];
  if (enabledList !== undefined && !Array.isArray(enabledList)) return malformed(wrongType(ENABLED_KEY, 'a JSON array'));
  const permissions = parsed.data.permissions;
  if (permissions !== undefined && !isPlainObject(permissions)) return malformed(wrongType('permissions', 'a JSON object'));
  const allow = isPlainObject(permissions) ? permissions.allow : undefined;
  if (allow !== undefined && !Array.isArray(allow)) return malformed(wrongType('permissions.allow', 'a JSON array'));
  const rules = Array.isArray(allow) ? allow : [];
  const enabled = Array.isArray(enabledList) && enabledList.includes(SERVER_NAME);
  const allowMissing = allowRules.filter((rule) => !rules.includes(rule));
  return {
    ...parsed,
    eol,
    enabled,
    allowPresent: allowRules.filter((rule) => rules.includes(rule)),
    allowMissing,
    // "Everything this mode writes is in place" — see the scope note in the header for what that
    // deliberately does NOT mean.
    complete: enabled && allowMissing.length === 0,
  };
};

// readRegistration(root, io?) → the full registration picture of ONE project. `io.serverPath`
// overrides the running kit's server path (tests); every fs primitive in `io` is the fs-read-nofollow
// injection contract. NEVER throws.
export const readRegistration = (root, io = {}) => {
  const serverPath = io.serverPath ?? DEFAULT_SERVER_PATH;
  const entry = buildServerEntry(serverPath);
  const allowRules = allowRulesFor();

  const mcpAbs = join(root, MCP_JSON_REL);
  const mcpRead = readTarget(mcpAbs, io);
  const mcpJson = { rel: MCP_JSON_REL, abs: mcpAbs, eol: LF, ...NEUTRAL_ENTRY, ...mcpRead,
    ...(mcpRead.state === STATE.PRESENT ? decideMcpJsonText(mcpRead.text, entry) : {}) };

  // The CONTAINER is classified BEFORE the file inside it is read, and the order is load-bearing:
  // path resolution follows an INTERMEDIATE symlink (O_NOFOLLOW guards the FINAL component only), so
  // reading first would pull a settings file from outside the work tree into memory — and into a
  // verdict, and into a rendered merge body — before anything got the chance to refuse it.
  const claudeDirAbs = join(root, CLAUDE_DIR_REL);
  const claudeDir = { rel: CLAUDE_DIR_REL, abs: claudeDirAbs, ...classifyDir(claudeDirAbs, io) };
  const containerUsable = claudeDir.state === STATE.PRESENT || claudeDir.state === STATE.ABSENT;

  // settings.local.json is NOT read at all: this mode never writes it, so counting a rule that lives
  // only there would report a registration the writer cannot maintain. (Reading it for the deny veto
  // alone was tried and subtracted — see the scope note in the header.)
  const settingsAbs = join(root, SETTINGS_REL);
  const settingsRead = containerUsable
    ? readTarget(settingsAbs, io)
    : { state: STATE.UNREADABLE, reason: `${CLAUDE_DIR_REL} is a ${claudeDir.className ?? claudeDir.reason} — refusing to read through it` };
  const neutralAllow = { enabled: false, allowPresent: [], allowMissing: allowRules, complete: false };
  const settings = { rel: SETTINGS_REL, abs: settingsAbs, eol: LF, ...neutralAllow, ...settingsRead,
    ...(settingsRead.state === STATE.PRESENT ? decideSettingsText(settingsRead.text, allowRules) : {}) };

  return {
    root,
    serverPath,
    entry,
    allowRules,
    mcpJson,
    settings,
    claudeDir,
    registered: mcpJson.matches && settings.complete,
  };
};

// The `.claude/` container: an ABSENT dir is a named state the preflight reports and only `--apply`
// resolves (creating it here would make a read-only preflight write).
const classifyDir = (abs, io) => {
  let st;
  try {
    st = lstatNoFollowRead(abs, io.lstat);
  } catch (err) {
    return { state: STATE.UNREADABLE, reason: (err && (err.code || err.message)) || 'lstat failed' };
  }
  if (st === null) return { state: STATE.ABSENT };
  if (st.isDirectory()) return { state: STATE.PRESENT };
  return { state: STATE.FOREIGN, className: describeNonRegular(st) };
};

// ── the merges (ONE definition, shared by the writer's bodies and the paste-ready fragments) ──
// Merge-don't-clobber in both: every foreign server, key and allow rule is carried over untouched,
// and our own entry/rules are added idempotently.

export const mergeMcpJson = (registration) => {
  const base = isPlainObject(registration.mcpJson.data) ? registration.mcpJson.data : {};
  const servers = isPlainObject(base[SERVERS_KEY]) ? base[SERVERS_KEY] : {};
  return { ...base, [SERVERS_KEY]: { ...servers, [SERVER_NAME]: registration.entry } };
};

export const mergeSettings = (registration) => {
  const base = isPlainObject(registration.settings.data) ? registration.settings.data : {};
  const enabled = Array.isArray(base[ENABLED_KEY]) ? base[ENABLED_KEY] : [];
  const permissions = isPlainObject(base.permissions) ? base.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  return {
    ...base,
    [ENABLED_KEY]: enabled.includes(SERVER_NAME) ? enabled : [...enabled, SERVER_NAME],
    permissions: { ...permissions, allow: [...allow, ...registration.allowRules.filter((rule) => !allow.includes(rule))] },
  };
};

export const formatJson = (data, eol) => `${JSON.stringify(data, null, JSON_INDENT).replaceAll(LF, eol)}${eol}`;

// The two hand-apply bodies — the whole output of the MASKED arm.
//
// They are deliberately DIFFERENT shapes, because what the kit knows about each file differs. The
// settings file was OBSERVABLE — and read where present — so its body is a real merge: it already
// carries every foreign key it had. The masked `.mcp.json` was not observable at all, so a
// whole-file body would name only our server and, pasted as
// instructed, would delete every foreign server the mask hid. `mcpEntry` is therefore the ENTRY
// ALONE, to be merged under `mcpServers` by a human who can see what is actually in that file.
export const renderFragments = (registration) => ({
  mcpEntry: formatJson(registration.entry, registration.mcpJson.eol),
  settings: formatJson(mergeSettings(registration), registration.settings.eol),
});

// A LIBRARY module the mode doc names by path — so someone can try to run it. A no-op on import;
// on a direct run it points at the command that acts on what this module only reports.
refuseDirectRun(import.meta.url);

// spec:jev-guide — docs/ai/specs/kit/jev-guide/index.md
// The one leaf the Jev surfaces share: the key rule, the connect line, the vendor facts the connect
// command's one request uses, and the vendor skill's pin, targets, state rule and apply line. No side
// effect, no import beyond node:path and node:crypto — the read-only guide imports it under its closed
// import graph, the advisor and the two commands beside it; file primitives arrive through `io`.
import { createHash } from 'node:crypto';
import { join, posix, win32 } from 'node:path';

export const KEY_VARIABLE = 'TYPESAFE_API_KEY';

// The ONE key rule: set exactly when the variable is a string that is not empty after trimming.
export const keySet = (env) => typeof env[KEY_VARIABLE] === 'string' && env[KEY_VARIABLE].trim() !== '';

// A minimal POSIX quoting for the one path the connect line carries: bare when every byte is safe,
// else single-quoted with the shell's own escape for a single quote.
const SAFE = /^[A-Za-z0-9_./:=+@%,-]+$/;
export const quoteArg = (value) => (SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

// The command the user runs in a terminal of their own; the guide prints it, the advisor's apply
// carries it. `toolsDir` is the kit's tools directory (the file beside this one). On win32 the line
// is for PowerShell: always single-quoted, a quote doubled, one backslash by concatenation.
export const connectLine = (toolsDir, platform) => (platform === 'win32'
  ? `node '${`${toolsDir}\\jev-connect.mjs`.replace(/'/g, "''")}'`
  : `node ${quoteArg(join(toolsDir, 'jev-connect.mjs'))}`);

// The one restart step the connect command's all-saved line and the guide's STEP 1 print.
export const RESTART_STEP = 'restart the agent so it reads the key: in VS Code or a VS Code fork, quit the editor completely (every window) and open it again; in a terminal, open a new terminal and start the agent there';

// Where the user runs the connect line, by one ordered rule; a name outside the set drops its rung.
const NAME = /^[A-Za-z0-9._-]+$/;
const named = (value) => typeof value === 'string' && NAME.test(value);
const nonEmpty = (value) => typeof value === 'string' && value !== '';
export const placeOf = ({ env = {}, platform, hostname, container } = {}) => {
  if (platform === 'win32') return 'a PowerShell terminal';
  if (named(env.WSL_DISTRO_NAME)) return `the WSL distro ${env.WSL_DISTRO_NAME} terminal`;
  if (nonEmpty(env.SSH_CONNECTION) && named(hostname)) return `a terminal on SSH host ${hostname}`;
  if (nonEmpty(env.REMOTE_CONTAINERS) || nonEmpty(env.CODESPACES) || container === true) return 'a terminal inside this container';
  return '';
};

// The vendor's smallest documented request (docs.typesafe.ai quickstart, read 2026-09-29) and the
// meanings of its documented error codes, quoted as the vendor prints them.
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_SAMPLE_BODY = Object.freeze({
  state: 'Help! My payouts have been failing for 3 days.',
  model: 'jev-latest',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades, new accounts' },
    },
  },
});
export const JEV_ERROR_MEANINGS = Object.freeze({
  401: 'Missing or invalid API key. Check the `Authorization` header.',
  422: 'The request body failed validation — for example a missing required field or a malformed question. The body details the offending field.',
  429: 'You have exceeded your rate limit. Back off and retry after a short delay.',
  529: 'TypeSafe is temporarily overloaded. Retry after a short delay.',
});

// ── the vendor skill (part jev-skill) ─────────────────────────────────────────────────────────────
// Each target file name -> the name the kit ships it under. The shipped SKILL.md is renamed so no agent
// walking the kit's own tree (a skill folder itself) loads the vendor's text before the user's --apply.
export const SKILL_FILES = Object.freeze({ 'SKILL.md': 'SKILL.md.pinned', LICENSE: 'LICENSE' });
// Newest first; a release that moves the pin puts the new entry first and removes none.
export const SKILL_PINS = Object.freeze([Object.freeze({
  tag: 'v0.5.7',
  commit: '65a39f393687675ce170e6094757de20370365b9',
  digests: Object.freeze({
    'SKILL.md': '71ea90d7906c6554c4f4c460ef7361b2d26f59116ccdae986dc6d997b9389f52',
    LICENSE: '835f233f1d6ed84a9b9a351aba0689b47644a4137d6316911fc7957bde523b02',
  }),
})]);
export const AFTER_INSTALL = 'After an install, quit the agent and start it again from a new terminal.';
export const NO_APPLY_LINE = 'the apply line cannot be printed here: a path holds a control character';

const isControl = (char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f;
// Display only: every path, entry name and reason a surface prints; never a command line.
export const printable = (text) => [...String(text)].map((char) => (isControl(char) ? '?' : char)).join('');

// The Claude Code dir the agent's environment names: an absolute CLAUDE_CONFIG_DIR for the platform, else <home>/.claude.
export const claudeDirOf = (env = {}, home = '', platform) => {
  const value = env.CLAUDE_CONFIG_DIR;
  const set = typeof value === 'string' && value !== '';
  if (set && (platform === 'win32' ? win32 : posix).isAbsolute(value)) return { dir: value, fromEnv: true, note: '' };
  const dir = home === '' ? '' : join(home, '.claude');
  return { dir, fromEnv: false,
    note: set ? printable(`CLAUDE_CONFIG_DIR is set to ${value}, not an absolute path: the Claude Code target is ${dir}`) : '' };
};

// The host separator, read off the host's own join.
const SEP = join('a', 'b').slice(1, -1);
const within = (path, dir) => path.startsWith(dir.endsWith(SEP) ? dir : `${dir}${SEP}`);
// The three targets in their order; a later record on an earlier one's path merges into it, and a later
// record inside an earlier one's path, or holding it, carries `overlaps`.
export const skillTargets = ({ home = '', claudeDir = '' } = {}) => {
  if (home === '') return [];
  const records = [
    { agent: 'Codex', base: home, root: join(home, '.agents', 'skills') },
    { agent: 'Claude Code', base: within(claudeDir, home) ? home : claudeDir, root: join(claudeDir, 'skills') },
    { agent: 'Antigravity CLI', base: home, root: join(home, '.gemini', 'config', 'skills') },
  ].map((record) => ({ ...record, path: join(record.root, 'typesafe-ai') }));
  return records.reduce((kept, record) => {
    const same = kept.find(({ path }) => path === record.path);
    if (same) return kept.map((item) => (item === same ? { ...item, agent: `${item.agent} and ${record.agent}` } : item));
    const other = kept.find(({ path }) => within(record.path, path) || within(path, record.path));
    return [...kept, other ? { ...record, overlaps: other.path } : record];
  }, []);
};

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const codeOf = (error) => error?.code ?? error?.message ?? String(error);
// The state of one target, by content and never by name; pure over io.lstat, io.readdir, io.readFile and io.pins.
export const skillState = (target, io) => {
  const foreign = (reason) => ({ state: 'foreign', tag: null, reason });
  if (target.overlaps) return foreign(`overlaps ${target.overlaps}`);
  const pins = io.pins ?? SKILL_PINS;
  try {
    const names = target.path.slice(target.base.length).split(SEP).filter(Boolean);
    let at = target.base;
    for (const [index, name] of names.entries()) {
      at = join(at, name);
      let stat;
      try { stat = io.lstat(at); } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'absent', tag: null, reason: null };
        return foreign(codeOf(error));
      }
      if (stat.isSymbolicLink()) return foreign(`a link at ${at}`);
      if (!stat.isDirectory()) return foreign(index === names.length - 1 ? 'not a directory' : `${at} is not a directory`);
    }
    const entries = [...io.readdir(target.path)].map(String).sort();
    if (entries.join('/') !== 'LICENSE/SKILL.md') return foreign(`holds ${entries.join(', ') || 'no entry'}`);
    for (const name of entries) {
      if (!io.lstat(join(target.path, name)).isFile()) return foreign(`${name} is not a regular file`);
    }
    const found = Object.fromEntries(entries.map((name) => [name, digestOf(io.readFile(join(target.path, name)))]));
    const pinAt = pins.findIndex(({ digests }) => Object.keys(SKILL_FILES).every((name) => digests[name] === found[name]));
    if (pinAt === 0) return { state: 'current', tag: pins[0].tag, reason: null };
    if (pinAt > 0) return { state: 'earlier', tag: pins[pinAt].tag, reason: null };
    return foreign('matches no pin');
  } catch (error) {
    return foreign(codeOf(error));
  }
};

// The skill command's apply line, always with the Claude Code dir its caller resolved; '' when a path holds a control byte.
export const skillLine = (toolsDir, platform, claudeDir) => {
  if ([...`${toolsDir}${claudeDir}`].some(isControl)) return '';
  if (platform === 'win32') {
    const quoted = (value) => `'${value.replace(/'/g, "''")}'`;
    return `node ${quoted(`${toolsDir}\\jev-skill.mjs`)} --apply --claude-dir ${quoted(claudeDir)}`;
  }
  return `node ${quoteArg(join(toolsDir, 'jev-skill.mjs'))} --apply --claude-dir ${quoteArg(claudeDir)}`;
};

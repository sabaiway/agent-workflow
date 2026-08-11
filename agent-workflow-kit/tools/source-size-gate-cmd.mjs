// source-size-gate-cmd.mjs — whether a declared gate cmd IS this checker. Mirrors the SHAPE of the
// review-dependent matcher (gates-declaration.mjs) without joining either of its arrays: this gate is
// neither a final core check nor review-dependent.
//
// Dependency-free, Node >= 22. No side effects on import.

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// STRICT full command — `node` + ONE (quoted or bare) path token + the exact basename + ` --check` +
// END — and the token must realpath-resolve to THIS kit's own checker, so an id squatter never
// matches.
//
// Separators are PLAIN SPACES, not \s: a newline between the tokens is not a command a runner would
// execute as written. The token is screened by the rules of the quoting it actually carries, because
// the two halves are interpreted differently and a single screen would be wrong for one of them:
//   • QUOTED — double quotes survive most bytes, so only what breaks OUT of them is refused.
//   • BARE   — anything the shell may split, expand or glob makes the executed command different
//              from the string, so a bare token is admitted only from a known-safe alphabet.
// Either way the point is the same: a path that resolves literally here while the shell would read
// it differently must never be called canonical, or the matcher certifies a command that never runs.
export const dqUnsafePath = (text) => [...text].some((ch) => {
  const code = ch.codePointAt(0);
  return ch === '"' || ch === '$' || code === 96 || code === 92 || code === 13 || code === 10;
});

// Stated as the bytes the shell ACTS on, not as an alphabet of blessed ones: an allow-list refuses
// perfectly ordinary paths (`@`, `+`, `,`, `%`, `=`, anything non-ASCII) that the shell passes
// through verbatim, and refusing a command that really is canonical is its own defect. Whitespace
// and ASCII control bytes are refused too — a bare token cannot contain them and still be one token.
const SHELL_ACTIVE_BARE = new Set([...'"\'\\$|&;<>(){}[]*?!#~^`']);
const bareTokenSafe = (text) => text.length > 0 && ![...text].some((ch) => {
  const code = ch.codePointAt(0);
  return code <= 0x20 || code === 0x7f || SHELL_ACTIVE_BARE.has(ch);
});

const CHECK_CMD_RE = /^node +(?:"((?:[^"]*[/\\])?source-size-check\.mjs)"|((?:[^\s"]*[/\\])?source-size-check\.mjs)) +--check$/;
export const SOURCE_SIZE_GATE_ID = 'source-size';
export const SOURCE_SIZE_TOOL_PATH = fileURLToPath(new URL('./source-size-check.mjs', import.meta.url));

export const matchesSourceSizeGate = (cmd, projectDir) => {
  if (typeof cmd !== 'string') return false;
  const match = CHECK_CMD_RE.exec(cmd.trim());
  if (!match) return false;
  const token = match[1] ?? match[2];
  const admissible = match[1] !== undefined ? !dqUnsafePath(token) : bareTokenSafe(token);
  if (!admissible) return false;
  const abs = isAbsolute(token) ? token : join(projectDir, token);
  try {
    return realpathSync(abs) === realpathSync(SOURCE_SIZE_TOOL_PATH);
  } catch {
    return false; // unresolvable → never canonical (fail closed)
  }
};

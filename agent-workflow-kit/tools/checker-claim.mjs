// checker-claim.mjs — what a declared gate cmd CLAIMS about one of the kit's own `--check` tools,
// as three named outcomes instead of a boolean. A LEAF: node built-ins only, so every surface that
// must recognize a tool invocation (the source-size matcher, the advisor's probes, the standalone
// migration's twin) decides through ONE screen.
// Dependency-free, Node >= 22. No side effects on import.

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// checker-claim canon >>> BEGIN drift-guarded region
// Authored TWICE, byte-identically: in the composition root's tools/checker-claim.mjs and in the
// memory substrate's references/scripts/migrate-gates.mjs. Neither side imports the other — the
// substrate is standalone and must not depend on the root, and the root must not import mirrored
// bytes — so a TEXT drift guard beside the root's copy holds them equal. Edit BOTH, then re-run the
// mirror sync.
//
// A cmd makes exactly ONE of three claims about a given tool, and collapsing them into a boolean is
// what makes a VENDORED copy of the tool read as "the tool is not declared at all" — a false
// absence, with a remedy (adopt it) that then collides with the entry already there:
//   • canonical      — this tool's `--check` invocation, resolving to THIS copy of it
//   • tool-elsewhere — the same invocation shape, resolving to a DIFFERENT real copy
//   • not-the-tool   — anything else: another command, a masked form, an inadmissible token, or a
//                      path nothing can resolve
// The realpath anchor never widens: a lookalike file that merely carries the basename is not this
// tool, whatever it prints. What widens is the VOCABULARY. Stated residual, unchanged by the split:
// nothing here reads the file's CONTENT, so a byte-swapped file at the canonical path is invisible.
export const CHECKER_CLAIM = Object.freeze({
  CANONICAL: 'canonical',
  ELSEWHERE: 'tool-elsewhere',
  NOT_THE_TOOL: 'not-the-tool',
});

// The token is screened by the rules of the quoting it actually carries, because the two halves are
// interpreted differently and a single screen would be wrong for one of them:
//   • QUOTED — double quotes survive most bytes, so only what breaks OUT of them is refused.
//   • BARE   — anything the shell may split, expand or glob makes the executed command different
//              from the string, so a bare token is admitted only from a known-safe alphabet.
// Either way the point is the same: a path that resolves literally here while the shell would read
// it differently must never be called a claim about this tool, or the screen certifies a command
// that never runs.
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

const RE_META = /[.*+?^${}()|[\]\\]/g;

// checkerClaimTool(basename, canonicalPath) → the screen for ONE tool. The shape is the STRICT full
// command — `node` + ONE (quoted or bare) path token + the exact basename + ` --check` + END — so a
// masked form (`--check --help`, `--check || true`, a prefix command) is never any claim at all.
// Separators are PLAIN SPACES, not \s: a newline between the tokens is not a command a runner would
// execute as written. The basename is regex-escaped here, never by the caller — a caller-escaped
// literal is one forgotten backslash away from a dot matching any byte.
export const checkerClaimTool = (basename, canonicalPath) => {
  const safe = basename.replace(RE_META, '\\$&');
  return Object.freeze({
    re: new RegExp(`^node +(?:"((?:[^"]*[/\\\\])?${safe})"|((?:[^\\s"]*[/\\\\])?${safe})) +--check$`),
    canonical: canonicalPath,
  });
};

// classifyCheckerClaim(tool, cmd, projectDir) → one CHECKER_CLAIM value. Every unresolvable side
// fails CLOSED to `not-the-tool`: an unresolvable path is not evidence the tool lives elsewhere, it
// is evidence nothing can be told about it — and `tool-elsewhere` is a claim a consumer ACTS on.
//
// Two screens beyond the shape, for the same reason the quoting screens exist — a claim must never
// be minted for a command that cannot run the tool as written:
//   • a token starting with `-` is an OPTION to node, whatever it resolves to on disk. (First-order,
//     like the producer canon's own leading-`-` rule: `{x,-y}` still defeats it, and the cost of a
//     miss is only a withheld claim.)
//   • the RESOLVED target must be a REGULAR FILE. A directory or a FIFO carrying the basename
//     resolves perfectly well and is not a copy of anything; `realpathSync` succeeding proves a path
//     exists, never that it is a tool. lstat runs AFTER realpath, so there is no link left to follow.
export const classifyCheckerClaim = (tool, cmd, projectDir) => {
  if (typeof cmd !== 'string' || typeof projectDir !== 'string') return CHECKER_CLAIM.NOT_THE_TOOL;
  const match = tool.re.exec(cmd.trim());
  if (!match) return CHECKER_CLAIM.NOT_THE_TOOL;
  const token = match[1] ?? match[2];
  const admissible = match[1] !== undefined ? !dqUnsafePath(token) : bareTokenSafe(token);
  if (!admissible || token.startsWith('-')) return CHECKER_CLAIM.NOT_THE_TOOL;
  const declared = isAbsolute(token) ? token : join(projectDir, token);
  try {
    const resolved = realpathSync(declared);
    if (!lstatSync(resolved).isFile()) return CHECKER_CLAIM.NOT_THE_TOOL;
    return resolved === realpathSync(tool.canonical) ? CHECKER_CLAIM.CANONICAL : CHECKER_CLAIM.ELSEWHERE;
  } catch {
    return CHECKER_CLAIM.NOT_THE_TOOL;
  }
};
// checker-claim canon <<< END drift-guarded region

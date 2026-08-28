// repo-lex.mjs — pure lexical helpers shared by the read and write surfaces (FLOW-READ-GRAPH-PURITY,
// flow Plan 4 Phase 2). A LEAF: Node built-ins only, no fs, no CLI, no side effects on import —
// extracted so read-surface modules (flow-record, cheap-agents) reach these rules without pulling
// in the mixed modules that host the write APIs (core-evidence and review-state re-export them, so
// every existing consumer keeps its import site). Dependency-free, Node >= 22.

import { isAbsolute, normalize, sep } from 'node:path';

// The LEXICAL half of the repo-relative rule — ONE home shared by the record validator (which has
// no fs to resolve against) and the fs resolver in core-evidence, so the two can never drift: a
// forged record carrying an equal-but-absolute (or escaping) testId/file pair is refused at
// validation, not just at observation time.
export const lexicalRepoRelative = (rel) => {
  if (typeof rel !== 'string' || rel.length === 0) return { ok: false, reason: 'empty file path' };
  if (isAbsolute(rel)) return { ok: false, reason: `absolute path "${rel}" — the testId file half must be repo-relative` };
  const norm = normalize(rel);
  if (norm === '..' || norm.startsWith(`..${sep}`)) return { ok: false, reason: `path "${rel}" escapes the repo root` };
  return { ok: true };
};

// POSIX single-quote for pasteable command rendering (display only — never an execution boundary).
export const shellQuoteArg = (s) => (/^[A-Za-z0-9_/.\-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// The bytes a settings-level allow rule cannot see past: command separators, redirections,
// expansions and globs. ONE home for the seeder (velocity-profile.mjs, the allow-rule writer) and
// the renders that must spell a path in the seeded byte-form (procedures.mjs) — two predicates for
// one rule drift apart, and a drifted render is a dead allow rule that simply prompts.
export const SHELL_METACHARACTERS = Object.freeze([
  '&', '|', ';', '<', '>', '$', '`', '(', ')',
  '\n', '\r', '\t', '\\', '{', '}', '*', '?', '#', '~', '!',
]);
export const hasShellMetacharacter = (cmd) => SHELL_METACHARACTERS.some((ch) => cmd.includes(ch));

// Characters that survive whitespace tokenization but break an UNQUOTED byte-exact path rule:
// shell quoting syntax and glob brackets (SHELL_METACHARACTERS owns the command-level separators/
// redirections/expansions — `*`/`?` globs included — but not these four).
const PATH_BREAKING_CHARACTERS = Object.freeze(["'", '"', '[', ']']);

// A path token that can be seeded UNQUOTED into a byte-exact allow rule: POSIX-absolute, no
// whitespace, no shell metacharacter, no quoting/glob syntax.
export const isSeedablePathToken = (token) =>
  typeof token === 'string' &&
  token.startsWith('/') &&
  !/\s/u.test(token) &&
  !hasShellMetacharacter(token) &&
  !PATH_BREAKING_CHARACTERS.some((ch) => token.includes(ch));

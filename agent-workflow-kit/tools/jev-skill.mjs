#!/usr/bin/env node
// spec:jev-guide — docs/ai/specs/kit/jev-guide/jev-skill.md
// The one command that installs the vendor's Jev skill, pinned and digest-checked, as a verified COPY into
// the three agent skill roots. The USER runs it with --apply in a terminal of their own after their yes in
// the chat; without --apply it is a read-only dry run. It reads no secret, needs no terminal, opens no
// connection, never writes through a link below a base, and never removes what it did not mint this run.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { AFTER_INSTALL, NO_APPLY_LINE, SKILL_FILES, SKILL_PINS, claudeDirOf, printable, skillLine, skillState,
  skillTargets } from './jev-facts.mjs';

export const EXIT = Object.freeze({ done: 0, nothingWritten: 1, usage: 2, inPart: 4 });
const TOOLS = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(TOOLS, '..', 'references', 'vendor', 'typesafe-ai');
const TMP_PREFIX = '.typesafe-ai.kit-tmp-';
const OLD_PREFIX = '.typesafe-ai.kit-old-';
const HELP = `jev-skill — installs the vendor's Jev (TypeSafe) skill, pinned, as one verified copy per agent skill root.

Usage:
  node jev-skill.mjs [--apply] [--claude-dir DIR]

Without --apply: a dry run that writes nothing and prints the plan.
--apply       install or replace the planned copies (Codex ~/.agents/skills, Claude Code <claude dir>/skills,
              Antigravity CLI ~/.gemini/config/skills); a foreign copy is left untouched.
--claude-dir  the Claude Code dir (absolute); default CLAUDE_CONFIG_DIR when absolute, else ~/.claude.
--help        answered only when it is the whole invocation.

Exit codes: 0 the dry run rendered or every planned write done; 1 nothing written (the kit's own copy fails
its check, or no home directory); 2 usage; 4 applied in part (a target refused).`;

const parseArgv = (argv, platform) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 1) throw fail(EXIT.usage, '--help is answered only when it is the whole invocation');
    return { help: true };
  }
  const parsed = { help: false, apply: false, claudeDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') parsed.apply = true;
    else if (arg === '--claude-dir') {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('-')) throw fail(EXIT.usage, '--claude-dir takes a value');
      if (!(platform === 'win32' ? win32 : posix).isAbsolute(value)) throw fail(EXIT.usage, `--claude-dir takes an absolute path, not ${printable(value)}`);
      parsed.claudeDir = value;
      index += 1;
    } else throw fail(EXIT.usage, `unknown argument "${printable(arg)}" — run with --help`);
  }
  return parsed;
};

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const codeOf = (error) => error?.code ?? error?.message ?? String(error);
const DEFAULT_IO = Object.freeze({
  lstat: lstatSync, readdir: readdirSync, readFile: readFileSync, mkdir: mkdirSync, mkdtemp: mkdtempSync,
  write: (path, bytes) => writeFileSync(path, bytes, { flag: 'wx' }), rename: renameSync, rm: rmSync,
});
const homeOf = (io) => {
  if (io.home !== undefined) return io.home;
  try { return homedir(); } catch { return ''; }
};

// The kit's own pair, digest-checked against the first pin: the bytes every install writes, or the refused file.
const vendorBytes = (io) => {
  const bytes = {};
  for (const [name, shipped] of Object.entries(SKILL_FILES)) {
    try { bytes[name] = io.readFile(join(io.vendorDir, shipped)); } catch { return { refused: shipped }; }
    if (digestOf(bytes[name]) !== io.pins[0].digests[name]) return { refused: shipped };
  }
  return { bytes };
};

const ACTIONS = Object.freeze({ current: 'keep', earlier: 'replace', absent: 'install', foreign: 'untouched' });
// Every target with its state and its action, the effective Claude Code dir, the note and the leftovers.
export const planFor = (io) => {
  const resolved = claudeDirOf(io.env, io.home, io.platform);
  const claudeDir = io.claudeDir ?? resolved.dir;
  const note = io.claudeDir ? '' : resolved.note;
  const targets = skillTargets({ home: io.home, claudeDir }).map((target) => {
    const state = skillState(target, io);
    return { ...target, ...state, action: ACTIONS[state.state] };
  });
  const parents = [...new Set(targets.map(({ root }) => dirname(root)))];
  const leftovers = parents.flatMap((parent) => {
    try {
      return [...io.readdir(parent)].map(String).filter((name) => name.startsWith(TMP_PREFIX) || name.startsWith(OLD_PREFIX))
        .sort().map((name) => join(parent, name));
    } catch { return []; }
  });
  return { claudeDir, note, targets, leftovers };
};

const countsOf = (targets) => Object.fromEntries(Object.values(ACTIONS)
  .map((action) => [action, targets.filter((target) => target.action === action).length]));
const detailOf = (target, newest) => ({
  keep: `${target.tag}, keep`, replace: `${target.tag}, replace with ${newest}`, install: 'install',
  untouched: `${printable(target.reason)}, left untouched`,
})[target.action];

// One target's write: install or replace, re-checking the target before each rename. Returns its lines and outcome.
export const applyTarget = (entry, io) => {
  const path = printable(entry.path);
  const parent = dirname(entry.root);
  const lines = [];
  const minted = [];
  const stateNow = () => skillState(entry, io).state;
  const changed = (planned) => {
    const now = stateNow();
    return now === planned ? null : `changed since the plan: now ${now}`;
  };
  let aside = null;
  const refuse = (cause) => {
    lines.push(`refused: ${path} — ${cause}`);
    for (const dir of minted) io.rm(dir, { recursive: true, force: true });
    if (aside) {
      const now = stateNow();
      let kept = now === 'absent' ? null : `the target is now ${now}`;
      if (kept === null) {
        try {
          io.rename(join(aside, 'typesafe-ai'), entry.path);
          io.rm(aside, { recursive: true, force: true });
        } catch (error) { kept = codeOf(error); }
      }
      if (kept !== null) lines.push(`kept aside: ${printable(join(aside, 'typesafe-ai'))} — ${kept}`);
    }
    return { lines, outcome: 'refused' };
  };
  try {
    const below = entry.root.slice(entry.base.length).split(/[\\/]/).filter(Boolean);
    below.reduce((at, name) => {
      const next = join(at, name);
      try { io.lstat(next); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        io.mkdir(next, { mode: 0o700 });
      }
      return next;
    }, entry.base);
    const temp = io.mkdtemp(join(parent, TMP_PREFIX));
    minted.push(temp);
    const child = join(temp, 'typesafe-ai');
    io.mkdir(child, { mode: 0o700 });
    for (const name of Object.keys(SKILL_FILES)) io.write(join(child, name), io.bytes[name]);
    for (const name of Object.keys(SKILL_FILES)) {
      if (digestOf(io.readFile(join(child, name))) !== io.pins[0].digests[name]) return refuse('digest mismatch');
    }
    if (entry.state === 'earlier') {
      const old = io.mkdtemp(join(parent, OLD_PREFIX));
      minted.push(old);
      const moved = changed('earlier');
      if (moved) return refuse(moved);
      io.rename(entry.path, join(old, 'typesafe-ai'));
      minted.pop();
      aside = old;
    }
    const placed = changed('absent');
    if (placed) return refuse(placed);
    io.rename(child, entry.path);
    io.rm(temp, { recursive: true, force: true });
    minted.length = 0;
    if (!aside) {
      lines.push(`installed: ${path} (${io.pins[0].tag})`);
      return { lines, outcome: 'installed' };
    }
    const old = { base: aside, path: join(aside, 'typesafe-ai') };
    const verified = skillState(old, io);
    if (verified.state === 'earlier') io.rm(aside, { recursive: true, force: true });
    else lines.push(`kept aside: ${printable(old.path)} — it reads ${verified.state}`);
    lines.unshift(`replaced: ${path} (${entry.tag} → ${io.pins[0].tag})`);
    return { lines, outcome: 'replaced' };
  } catch (error) {
    return refuse(codeOf(error));
  }
};

const run = (parsed, io) => {
  const pin = io.pins[0];
  const { bytes, refused } = vendorBytes(io);
  if (refused) {
    io.error(`refused: the kit's own copy of ${refused} is missing, unreadable or does not match the pin — nothing written`);
    return EXIT.nothingWritten;
  }
  if (io.home === '') { io.error('refused: no home directory found — nothing written'); return EXIT.nothingWritten; }
  const plan = planFor({ ...io, claudeDir: parsed.claudeDir ?? undefined });
  io.log(`pin: ${pin.tag}, commit ${pin.commit}`);
  if (plan.note) io.log(plan.note);
  const leftovers = plan.leftovers.map((path) => `leftover: ${printable(path)} — not removed; delete it by hand`);
  const counts = countsOf(plan.targets);
  if (!parsed.apply) {
    for (const target of plan.targets) io.log(`${target.agent}: ${target.state} at ${printable(target.path)} — ${detailOf(target, pin.tag)}`);
    for (const line of leftovers) io.log(line);
    io.log(`dry run — nothing written. Planned: ${counts.install} to install, ${counts.replace} to replace, ${counts.keep} kept, ${counts.untouched} left untouched.`);
    if (counts.install + counts.replace > 0) {
      io.log('To install, run in a terminal of your own:');
      io.log(skillLine(io.toolsDir, io.platform, plan.claudeDir) || NO_APPLY_LINE);
    }
    return EXIT.done;
  }
  const done = { installed: 0, replaced: 0, kept: 0, untouched: 0, refused: 0 };
  for (const target of plan.targets) {
    if (target.action === 'keep' || target.action === 'untouched') {
      io.log(target.action === 'keep' ? `kept: ${printable(target.path)} (${target.tag})`
        : `left untouched: ${printable(target.path)} — ${printable(target.reason)}`);
      done[target.action === 'keep' ? 'kept' : 'untouched'] += 1;
      continue;
    }
    const result = applyTarget(target, { ...io, bytes });
    for (const line of result.lines) io.log(line);
    done[result.outcome] += 1;
  }
  for (const line of leftovers) io.log(line);
  io.log(`done — ${done.installed} installed, ${done.replaced} replaced, ${done.kept} kept, ${done.untouched} left untouched, ${done.refused} refused.`);
  if (done.installed + done.replaced > 0) io.log(AFTER_INSTALL);
  return done.refused === 0 ? EXIT.done : EXIT.inPart;
};

export const main = (argv, io = {}) => {
  const resolved = {
    ...DEFAULT_IO, log: console.log, error: console.error, env: process.env, platform: process.platform,
    pins: SKILL_PINS, vendorDir: VENDOR_DIR, toolsDir: TOOLS, ...io,
  };
  let parsed;
  try { parsed = parseArgv(argv, resolved.platform); } catch (err) { resolved.error(err.message); return EXIT.usage; }
  if (parsed.help) { resolved.log(HELP); return EXIT.done; }
  return run(parsed, { ...resolved, home: homeOf(io) });
};

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
// spec:jev-guide — docs/ai/specs/kit/jev-guide/jev-connect.md
// The one command that connects Jev (TypeSafe) on a host. The USER runs it in a terminal of their
// own: it reads the key with no echo, verifies it with one request, saves it as managed export lines
// in the shell's startup files and says to restart the agent. It never prints the key, never puts it in
// an argv, and refuses when stdin is not a terminal, so a non-interactive run (the agent's) cannot
// reach the prompt — the mode doc keeps the rule that the agent never runs it.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fail } from '../references/scripts/markdown-blocks.mjs';
import { isDirectRun } from './direct-run.mjs';
import { JEV_ENDPOINT, JEV_ERROR_MEANINGS, JEV_SAMPLE_BODY, KEY_VARIABLE } from './jev-facts.mjs';

export const EXIT = Object.freeze({ saved: 0, notVerified: 1, usage: 2, noTerminal: 3, notSaved: 4 });
export const MARK = '# agent-workflow jev';
export const TIMEOUT_MS = 15000;
const LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'];
export const TERMINAL_SENTENCE = 'run this in a terminal of your own: it asks for the key there, so the agent never sees it';
export const CONNECTED = 'connected — quit the agent and start it again from a new terminal';
export const SAVED_IN_PART = 'saved in part — add the export line by hand where a line above says not saved, then restart the agent';
export const NOT_SAVED_SENTENCE = `not saved — set ${KEY_VARIABLE} to your key in your shell's startup file, in an editor and in that shell's own syntax, then restart the agent`;
export const EDITOR_SENTENCE = `verified, ${NOT_SAVED_SENTENCE}`;
const HELP = `jev-connect — connects Jev (TypeSafe) on this host; run it in a terminal of your own.

Usage:
  node jev-connect.mjs [--unverified]

Asks for ${KEY_VARIABLE} with no echo, verifies the key with one request to api.typesafe.ai, saves it
as managed export lines in your shell's startup files (bash: ~/.bashrc and the login file bash
reads; zsh: ~/.zshrc, under ZDOTDIR when set) and says to restart the agent. The key is never printed and never put in an argument.

--unverified  save without the request (no network from here).
--help        answered only when it is the whole invocation.

Exit codes: 0 saved; 1 not verified, nothing written; 2 usage; 3 no terminal, aborted or no key,
nothing written; 4 not saved (another shell, Windows, a linked startup file or directory) — the
last line says what to set by hand.`;

const parseArgv = (argv) => {
  if (argv.includes('--help') || argv.includes('-h')) {
    if (argv.length !== 1) throw fail(EXIT.usage, '--help is answered only when it is the whole invocation');
    return { help: true };
  }
  return argv.reduce((parsed, arg) => {
    if (arg === '--unverified') return { ...parsed, unverified: true };
    throw fail(EXIT.usage, `unknown argument "${arg}" — run with --help`);
  }, { help: false, unverified: false });
};

// The no-echo read: raw mode on a terminal stdin, restored on every path. Resolves the first line
// (CR, LF or CRLF ends it; bytes after it are dropped), null on Ctrl-C / Ctrl-D.
export const readSecret = (prompt, { stdin, stdout }) => new Promise((resolve, reject) => {
  let buffer = '';
  const finish = (fn) => {
    stdin.removeListener('data', onData);
    try { stdin.setRawMode(false); } catch { /* the terminal is gone; the value still resolves */ }
    stdin.pause();
    stdout.write('\n');
    fn();
  };
  const onData = (chunk) => {
    for (const char of String(chunk)) {
      if (char === '\u0003' || char === '\u0004') return finish(() => resolve(null));
      if (char === '\r' || char === '\n') return finish(() => resolve(buffer.trim()));
      if (char === '\u007f' || char === '\b') buffer = buffer.slice(0, -1);
      else if (char >= ' ') buffer += char;
    }
    return undefined;
  };
  try {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  } catch (error) {
    finish(() => reject(error));
  }
});

const scrub = (text, key) => String(text).split(key).join('<key>');

// One request: the vendor's sample body, the key in a header, no redirect, a bounded wait. The
// verdict is a line to print; `ok` says whether the save may follow. Nothing here writes.
export const verifyKey = async (key, io = {}) => {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const timeoutMs = io.timeoutMs ?? TIMEOUT_MS;
  let response;
  try {
    response = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JEV_SAMPLE_BODY),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : (error?.cause?.message ?? error?.message ?? String(error));
    return { ok: false, line: `not verified: ${scrub(cause, key)}` };
  }
  if (response.status !== 200) {
    const meaning = JEV_ERROR_MEANINGS[response.status];
    return { ok: false, line: `not verified: HTTP ${response.status}${meaning ? ` — ${meaning}` : ''}` };
  }
  let body;
  try { body = await response.json(); } catch { return { ok: false, line: 'not verified: HTTP 200 with an answer that is not JSON' }; }
  const answer = body?.answers?.department;
  if (typeof answer?.choice !== 'string' || typeof answer?.confidence !== 'number') {
    return { ok: false, line: 'not verified: HTTP 200 without a department choice and a confidence' };
  }
  return { ok: true, line: `verified: HTTP 200 — department ${scrub(answer.choice, key)}, confidence ${answer.confidence}` };
};

// The startup files the key goes to, by a closed rule over the shell: zsh reads ~/.zshrc (under
// ZDOTDIR when set); an interactive bash reads ~/.bashrc and a login bash the first of
// .bash_profile, .bash_login, .profile that exists — created as .bash_profile when none does. Both
// bash files always: no file content decides the set, so a login file's own older export is
// rewritten too. Any other shell, and Windows, gets no target.
export const targetsFor = ({ shell, home, zdotdir, platform = 'linux' }, deps = {}) => {
  const exists = deps.exists ?? ((path) => { try { lstatSync(path); return true; } catch { return false; } });
  if (platform === 'win32' || typeof home !== 'string' || home === '') return [];
  const name = typeof shell === 'string' ? basename(shell) : '';
  if (name === 'zsh') return [join(typeof zdotdir === 'string' && zdotdir !== '' ? zdotdir : home, '.zshrc')];
  if (name !== 'bash') return [];
  const login = LOGIN_FILES.map((file) => join(home, file)).find(exists) ?? join(home, LOGIN_FILES[0]);
  return [join(home, '.bashrc'), login];
};

export const managedLine = (key) => `export ${KEY_VARIABLE}='${key.replace(/'/g, `'\\''`)}'  ${MARK}`;
const isExportLine = (line) => new RegExp(`^\\s*export\\s+${KEY_VARIABLE}=`).test(line);

// Replace matching export lines in place, their indent and CR kept, so no if/case branch is
// emptied; append when none match.
export const upsertManagedLine = (text, line) => {
  const lines = text.split('\n');
  if (lines.some(isExportLine)) {
    return lines.map((item) => (isExportLine(item)
      ? `${item.match(/^\s*/)[0]}${line}${item.endsWith('\r') ? '\r' : ''}` : item)).join('\n');
  }
  const body = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return `${body}${line}\n`;
};

// The directories between the home and the target, each lstat'ed: a link among them is never written
// through (a stow'd ZDOTDIR is a dotfiles repo); a target outside the home is not written at all.
const parentRefusal = (path, home, lstat) => {
  const rel = relative(home, dirname(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return `${path} is outside the home`;
  let dir = home;
  for (const part of rel.split(sep).filter(Boolean)) {
    dir = join(dir, part);
    if (lstat(dir).isSymbolicLink()) return `${path} — ${dir} is a link`;
  }
  return null;
};

// One line per target: `saved: <path>` or `not saved: <path> — <why>`. A link — the target or a
// directory below the home — or a non-regular entry is never written through; a new file is created
// 0600; an existing file keeps its mode.
export const saveKey = (key, targets, home, deps = {}) => targets.map((path) => {
  const lstat = deps.lstat ?? lstatSync;
  const read = deps.read ?? ((at) => readFileSync(at, 'utf8'));
  const write = deps.write ?? writeFileSync;
  let stat = null;
  try {
    const refusal = parentRefusal(path, home, lstat);
    if (refusal) return { path, saved: false, line: `not saved: ${refusal} — add the export line by hand` };
    stat = lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') return { path, saved: false, line: `not saved: ${path} — ${error?.code ?? error?.message}` };
  }
  if (stat?.isSymbolicLink()) return { path, saved: false, line: `not saved: ${path} is a link — add the export line by hand` };
  if (stat && !stat.isFile()) return { path, saved: false, line: `not saved: ${path} is not a regular file` };
  try {
    write(path, upsertManagedLine(stat ? read(path) : '', managedLine(key)), stat ? {} : { mode: 0o600 });
    return { path, saved: true, line: `saved: ${path}` };
  } catch (error) {
    return { path, saved: false, line: `not saved: ${path} — ${error?.code ?? error?.message}` };
  }
});

const safeHome = (env) => {
  if (typeof env.HOME === 'string' && env.HOME !== '') return env.HOME;
  try { return homedir(); } catch { return ''; }
};

export const main = async (argv, io = {}) => {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  let parsed;
  try { parsed = parseArgv(argv); } catch (err) { error(err.message); return EXIT.usage; }
  if (parsed.help) { log(HELP); return EXIT.saved; }
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  if (!stdin.isTTY) { error(TERMINAL_SENTENCE); return EXIT.noTerminal; }
  let key;
  try { key = await readSecret(`${KEY_VARIABLE}: `, { stdin, stdout }); } catch (err) { error(`the terminal read failed: ${err?.message ?? err} — nothing written`); return EXIT.noTerminal; }
  if (key === null) { error('aborted — nothing written'); return EXIT.noTerminal; }
  if (key === '') { error('no key entered — nothing written'); return EXIT.noTerminal; }
  if (parsed.unverified) log('not verified: skipped (--unverified)');
  else {
    const verdict = await verifyKey(key, io);
    log(verdict.line);
    if (!verdict.ok) { log('nothing written'); return EXIT.notVerified; }
  }
  const env = io.env ?? process.env;
  const home = io.home ?? safeHome(env);
  const targets = targetsFor({ shell: env.SHELL, home, zdotdir: env.ZDOTDIR, platform: io.platform ?? process.platform }, io);
  const results = saveKey(key, targets, home, io);
  for (const result of results) log(result.line);
  const saved = results.filter((result) => result.saved).length;
  if (results.length > 0 && saved === results.length) { log(CONNECTED); return EXIT.saved; }
  if (saved > 0) log(SAVED_IN_PART);
  else log(parsed.unverified ? NOT_SAVED_SENTENCE : EDITOR_SENTENCE);
  return EXIT.notSaved;
};

if (isDirectRun(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

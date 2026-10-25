import { after } from 'node:test';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACKS_FILE } from '../ack-store.mjs';
import { quoteArg } from '../jev-facts.mjs';

export const TOOLS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = resolve(TOOLS, '..', 'references', 'vendor', 'typesafe-ai');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// The vendored pair is read guarded, so a suite loads on a tree without it and each cell fails on its own.
const vendorRead = (name) => { try { return readFileSync(join(VENDOR, name)); } catch { return Buffer.from(`the vendored ${name} is absent\n`); } };

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
export const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
// A project root holding docs/ai, and the given acks when there are any.
export const projectWith = (acks = null) => {
  const root = tempDir('jev-project-');
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  if (acks !== null) writeFileSync(join(root, ACKS_FILE), `${JSON.stringify(acks)}\n`);
  return root;
};
// Every path deps.lstat is given is recorded; the unreadable ack throws EACCES at the root's docs/ai/acks.json.
export const recordingLstat = (root, unreadable, seen) => (path) => {
  seen.push(path);
  if (unreadable && path === join(root, ACKS_FILE)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' });
  return lstatSync(path);
};
// The checked slot of a jev-skill variant, built from the parts the lane leaf composes.
export const skillSlot = (variant, root, dir) => {
  const check = ['node', ...[join(TOOLS, 'apply-danger-check.mjs'), '--variant', variant, '--cwd', root, '--claude-dir', dir]
    .map((arg) => quoteArg(arg))].join(' ');
  return { check, apply: `${check} --apply --expect <digest>` };
};

export const pairs = {
  current: { 'SKILL.md': vendorRead('SKILL.md.pinned'), LICENSE: vendorRead('LICENSE') },
  older: { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.6\n'), LICENSE: Buffer.from('MIT at v0.5.6\n') },
  oldest: { 'SKILL.md': Buffer.from('# the vendor skill at v0.5.5\n'), LICENSE: Buffer.from('MIT at v0.5.5\n') },
  nopin: { 'SKILL.md': Buffer.from('# a copy matching no pin\n'), LICENSE: Buffer.from('MIT, no pin\n') },
};
export const pinOf = (tag, pair) => ({ tag, commit: tag, digests: { 'SKILL.md': digest(pair['SKILL.md']), LICENSE: digest(pair.LICENSE) } });
export const PINS = [pinOf('v0.5.7', pairs.current), pinOf('v0.5.6', pairs.older), pinOf('v0.5.5', pairs.oldest)];

export const fillPair = (dir, pair) => {
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(pair)) writeFileSync(join(dir, name), bytes);
};
export const homeTargets = (home, claude = join(home, '.claude')) => [join(home, '.agents', 'skills', 'typesafe-ai'),
  join(claude, 'skills', 'typesafe-ai'), join(home, '.gemini', 'config', 'skills', 'typesafe-ai')];
// A home whose three targets hold the given pairs by name (null: absent, 'foreign': the current pair beside an extra entry).
export const homeOf = (states, home = tempDir('jev-skill-home-')) => {
  homeTargets(home).forEach((path, index) => {
    const state = states[index];
    if (state === 'foreign') fillPair(path, { ...pairs.current, 'notes.txt': 'mine\n' });
    else if (state) fillPair(path, pairs[state]);
  });
  return home;
};

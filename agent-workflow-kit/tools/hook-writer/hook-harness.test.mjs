import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXPECTED_WORKFLOW_VERSION } from '../velocity-profile.mjs';

export const SETTINGS = '.claude/settings.json';
export const LOCAL = '.claude/settings.local.json';
export const STAMP = 'docs/ai/.workflow-version';

export const put = (root, rel, contents) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

export const makeHookProject = (t, { prefix, hookRel, settings, local, hook, stamp = EXPECTED_WORKFLOW_VERSION } = {}) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, STAMP, `${stamp}\n`);
  if (settings !== undefined) put(root, SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  if (local !== undefined) put(root, LOCAL, `${JSON.stringify(local, null, 2)}\n`);
  if (hook !== undefined) put(root, hookRel, hook);
  return root;
};

export const snapshot = (root) => readdirSync(root).sort().map((name) => {
  const path = join(root, name);
  const stat = lstatSync(path);
  const entry = { name, mode: stat.mode, inode: stat.ino };
  if (stat.isSymbolicLink()) return { ...entry, link: readlinkSync(path) };
  if (stat.isDirectory()) return { ...entry, children: snapshot(path) };
  return { ...entry, bytes: readFileSync(path) };
});

export const plantLink = (root, rel, directory = false) => {
  const backing = join(root, 'backing');
  if (directory) mkdirSync(backing);
  else writeFileSync(backing, 'untouched\n');
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(backing, join(root, rel));
};

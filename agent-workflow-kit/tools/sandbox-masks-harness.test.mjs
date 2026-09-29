// The shared harness of the sandbox-masks suites: stat stubs, the committed template repo, mountinfo
// lines, the counting reader, the fence writer and the hermetic advisor. It declares NO test of its own;
// the `.test.mjs` name keeps it out of the tarball (files[] excludes tools/**/*.test.mjs).

import { after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MASKS_FENCE_START, MASKS_FENCE_END } from './sandbox-masks.mjs';
import { buildRecommendations } from './recommendations.mjs';

// An empty stat by default (`size: 0`, no `mode`): the S2 and S3 stubs.
export const fakeStat = (type, extra = {}) => ({
  isFile: () => type === 'file',
  isDirectory: () => type === 'dir',
  isSymbolicLink: () => type === 'symlink',
  isCharacterDevice: () => type === 'char',
  isBlockDevice: () => type === 'block',
  isFIFO: () => type === 'fifo',
  isSocket: () => type === 'socket',
  size: 0,
  ...extra,
});

export const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// → makeRepo(): a fresh copy of one committed template holding the given files, removed after the suite.
export const repoFactory = (prefix, files = { 'base.txt': 'committed\n' }) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const template = join(tmp, 'template');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(template, rel)), { recursive: true });
    writeFileSync(join(template, rel), text);
  }
  git(template, 'init', '-q');
  git(template, 'config', 'user.email', 'probe@example.com');
  git(template, 'config', 'user.name', 'probe');
  git(template, 'add', '-A');
  git(template, 'commit', '-qm', 'base');
  let seq = 0;
  return () => {
    const root = join(tmp, `repo-${seq += 1}`);
    cpSync(template, root, { recursive: true });
    return root;
  };
};

// A mountinfo line; `measured` carries the option and source fields of the lines measured on this host.
export const line = (id, parent, dev, root, point) => `${id} ${parent} ${dev} ${root} ${point} rw,relatime - ext4 /dev/sda rw`;
export const measured = (id, parent, dev, root, point, fs = 'ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered') =>
  `${id} ${parent} ${dev} ${root} ${point} ro,nosuid,nodev,relatime - ${fs}`;
export const DEVTMPFS = 'devtmpfs none rw,size=4046008k,nr_inodes=1011502,mode=755';
// The root mount at /, the work tree on another device beneath it; foreignBashrc adds a foreign
// bind of /tmp/empty (0:40) at <root>/.bashrc on the work-tree mount (the acceptance table).
export const plainTable = (root) => `${[line(1, 0, '8:1', '/', '/'), line(2, 1, '8:2', '/wt', root)].join('\n')}\n`;
export const foreignBashrc = (root) => `${[line(1, 0, '8:1', '/', '/'), line(2, 1, '8:2', '/wt', root), line(3, 2, '0:40', '/tmp/empty', `${root}/.bashrc`)].join('\n')}\n`;

// A reader that answers the given text and counts its calls.
export const reader = (text) => {
  const read = () => {
    read.calls += 1;
    return text;
  };
  read.calls = 0;
  return read;
};

// The walk lists the given paths and lstat answers each one's class, or its stat object (the lying-dirent twin).
export const stubs = (classes) => ({
  listUntracked: () => Object.keys(classes),
  lstat: (p) => {
    for (const [rel, type] of Object.entries(classes)) if (p.endsWith(`/${rel}`)) return typeof type === 'string' ? fakeStat(type) : type;
    return lstatSync(p);
  },
});

export const writeFence = (root, ...rels) => {
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  writeFileSync(join(root, '.git', 'info', 'exclude'), `${[MASKS_FENCE_START, ...rels.map((r) => `/${r}`), MASKS_FENCE_END].join('\n')}\n`);
};
export const readExclude = (root) => readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');

// Keeps the host machine out of every other advisor probe: the masks suites read one item.
export const adviseMasks = (root, deps) => {
  const built = buildRecommendations({
    cwd: root,
    deps: { findWrapper: () => false, env: { PATH: '/nonexistent-path-for-tests' }, getenv: { PATH: '/nonexistent-path-for-tests' }, home: root, ...deps },
  });
  return { item: built.items.find((i) => i.key === 'sandbox-masks'), skip: built.skips.find((s) => s.key === 'sandbox-masks') };
};

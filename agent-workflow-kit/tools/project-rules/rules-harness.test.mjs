// The shared fixtures of the project-rules suites: a project tree in a temp dir, the digests a record
// holds, a byte snapshot of a tree, and the loader that imports a module of this directory inside a
// test, so a module the plan adds but the tree lacks fails that test, never the file's load. No case.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const KIT = 'docs/ai/rules/project-layout.md';
export const LOCAL = 'docs/ai/rules/local/project-layout.md';
export const EFFECTIVE = 'docs/ai/rules/effective/project-layout.md';
export const RECORD = 'docs/ai/rules/effective/sources.json';
export const UPGRADE = 'run /agent-workflow-kit upgrade';

export const KIT_TEXT = '---\ntype: rules\nmaxLines: 80\n---\n\n# Project layout\n\nA module is a directory.\n';
export const LOCAL_TEXT = '---\ntype: rules\n---\n\n# Project layout\n\nTests live in test/.\n';
export const MERGED_TEXT = '---\ntype: rules\nmaxLines: 80\n---\n\n# Project layout\n\nA module is a directory. Tests live in test/.\n';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// entryOf({ kit, local?, effective }) → the record entry those texts stand for; no local = 'absent'.
export const entryOf = ({ kit, local, effective }) =>
  ({ kit: sha(kit), local: local === undefined ? 'absent' : sha(local), effective: sha(effective) });

export const recordText = (themes, schema = 1) => `${JSON.stringify({ schema, themes }, null, 2)}\n`;

// makeProject(files) → a temp project root holding docs/ai/ and each { relative path: text } given.
export const makeProject = (files = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'project-rules-'));
  mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
};

// The two recorded states every suite starts from: a kit copy with no local file, and a merge.
export const copyProject = () => makeProject({
  [KIT]: KIT_TEXT,
  [EFFECTIVE]: KIT_TEXT,
  [RECORD]: recordText({ 'project-layout': entryOf({ kit: KIT_TEXT, effective: KIT_TEXT }) }),
});
export const mergedProject = () => makeProject({
  [KIT]: KIT_TEXT,
  [LOCAL]: LOCAL_TEXT,
  [EFFECTIVE]: MERGED_TEXT,
  [RECORD]: recordText({ 'project-layout': entryOf({ kit: KIT_TEXT, local: LOCAL_TEXT, effective: MERGED_TEXT }) }),
});

export const removeProject = (root) => rmSync(root, { recursive: true, force: true });

// snapshot(root) → one sorted line per entry under root: its path, its kind and its bytes' digest.
export const snapshot = (root) => {
  const lines = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, path));
      if (st.isSymbolicLink()) lines.push(`${path}\tlink\t${readlinkSync(join(root, path))}`);
      else if (st.isDirectory()) {
        lines.push(`${path}\tdir`);
        walk(path);
      } else lines.push(`${path}\tfile\t${sha(readFileSync(join(root, path)))}`);
    }
  };
  walk('');
  return lines;
};

// load(file) → the module of this directory, or {} when the tree lacks the file (any other load
// error surfaces); need(mod, name) → the export, or a throw naming the absent export.
export const load = (file) => import(new URL(file, import.meta.url)).catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw err;
});
export const need = (mod, name) => {
  if (!(name in mod)) throw new Error(`${name} is absent: the plan adds it`);
  return mod[name];
};

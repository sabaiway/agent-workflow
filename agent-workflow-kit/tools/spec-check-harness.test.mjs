// The shared harness of the spec-check suites — an INJECTED repo and the document builders both
// lanes need. It declares NO test of its own; the `.test.mjs` name is what keeps it out of the
// tarball (files[] excludes tools/**/*.test.mjs) and out of the changed-line coverage domain, which
// is where test-only code belongs. A suite that owns no test reports zero and passes.
//
// It imports nothing under test, so a suite that reaches for it still LOADS when the modules under
// test are absent — the red proof stays observable.

import { SPEC_SCHEMA } from '../references/scripts/spec-schema.mjs';

export const STORE = SPEC_SCHEMA.storePrefix;
export const ROOT = '/repo';
export const abs = (rel) => (rel === '' ? ROOT : `${ROOT}/${rel}`);
export const relOf = (path) => (path === ROOT ? '' : path.slice(ROOT.length + 1));

// `files` are the regular files by repo-relative path, `states` forces a probe state
// (absent|dir|symlink|unreadable) at a path, `escapes` makes a path's realpath leave the root, and
// `listFails` makes a directory unreadable to the walk. Every ancestor of a file is a directory;
// `reads` records the leaf paths the checker actually read, so a fail-closed order can be asserted.
const ancestorsOf = (rel) => rel.split('/').slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join('/'));
export const repoOf = (files, { states = {}, escapes = {}, listFails = [], reads = [] } = {}) => {
  const dirs = new Set(['', ...Object.keys(files).flatMap(ancestorsOf)]);
  const state = (rel) => states[rel] ?? (rel in files ? 'file' : dirs.has(rel) ? 'dir' : 'absent');
  return {
    reads,
    probe: (path) => state(relOf(path)),
    realpath: (path) => (relOf(path) in escapes ? escapes[relOf(path)] : state(relOf(path)) === 'absent' ? null : abs(relOf(path))),
    list: (path) => {
      const rel = relOf(path);
      if (listFails.includes(rel) || state(rel) !== 'dir') return null;
      const prefix = rel === '' ? '' : `${rel}/`;
      const inside = [...Object.keys(files), ...dirs].filter((p) => p !== rel && p.startsWith(prefix));
      return [...new Set(inside.map((p) => p.slice(prefix.length).split('/')[0]))];
    },
    read: (path) => {
      const rel = relOf(path);
      reads.push(rel);
      const forced = states[rel];
      if (forced === 'unreadable') return { outcome: 'error', code: 'EACCES' };
      if (forced === 'symlink' || forced === 'dir') return { outcome: 'foreign', className: forced };
      return rel in files && forced !== 'absent' ? { outcome: 'ok', content: files[rel] } : { outcome: 'absent' };
    },
  };
};

export const op = (verb, target) => ({ verb, target });
export const rename = (from, to) => ({ verb: 'rename', from, to });
export const rulesOf = (result, rule) => result.findings.filter((f) => f.rule === rule).map((f) => f.path);

export const FRONT = (kind, maxLines, extra = '') =>
  `---\ntype: spec\nlastUpdated: 2026-08-24\nscope: permanent\nstaleAfter: 90d\nowner: none\nmaxLines: ${maxLines}\nkind: ${kind}\n${extra}---\n`;
export const indexDoc = (title, children = [], preamble = '') => `${FRONT('index', 80)}\n# ${title}\n${preamble}\n## Children\n\n${children.join('\n')}\n`;
export const ROOT_DOC = (children = []) => indexDoc('Specs', children, `\n${SPEC_SCHEMA.upLinkLine}\n`);
export const specDoc = (slug, { scenario = `- S1 ok :: probe/${slug}.txt :: spec:${slug}/S1`, module = `- src/${slug}/`, parts = null } = {}) =>
  `${FRONT('spec', 150, 'status: live\nrevision: 1\n')}\n# Spec: ${slug}\n\n## Contract\n\nA contract.\n\n## Scenarios\n\n${scenario}\n\n## Out of scope\n\n- Everything else\n\n## Module\n\n${module}\n${parts ? `\n## Parts\n\n${parts.join('\n')}\n` : ''}`;
export const marker = (slug, times = 1) => Array.from({ length: times }, () => `spec:${slug}/S1\n`).join('');

// The ground a spec's `## Module` names — a module root that does NOT exist is itself a finding, so
// every store fixture that expects to be clean has to lay its ground down.
export const groundOf = (...slugs) => Object.fromEntries(slugs.map((slug) => [`src/${slug}/.keep`, '']));

export const FLAT_STORE = {
  [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)']),
  [`${STORE}login.md`]: specDoc('login'),
  'probe/login.txt': marker('login'),
  ...groundOf('login'),
};

// satellite-locator.test.mjs — the slug → satellite resolver and the handoff identity proof
// (delegation Plan 3, Phase 2). A NEW suite: the extraction is a characterization move, so every
// EXISTING worktrees assertion stays byte-identical and each new distinction lands here.
//
// The module is imported DYNAMICALLY inside each test so the file still LOADS before the module
// exists — a red-proof needs the named test to run and FAIL, not to be unresolvable.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, readdirSync, realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'aw-satellite-locator-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const load = () => import('./satellite-locator.mjs');

// The leaf owns NO read door: the content read arrives through this seam, in the family's
// structured outcome shape. A test-local reader is enough here — that the leaf really goes through
// the seam, and holds no body of its own, is proven in satellite-locator-door.test.mjs.
const readFileNoFollow = (abs) => {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return { unsafe: true };
    return { bytes: readFileSync(abs) };
  } catch (err) {
    return err?.code === 'ENOENT' ? { absent: true } : { error: err?.code ?? 'fs error' };
  }
};

const FS = { lstat: lstatSync, readdir: readdirSync, realpath: realpathSync, readFileNoFollow };

// The git seam answers ONE query — `worktree list --porcelain -z` — in the real NUL grammar:
// every attribute NUL-terminated, an extra NUL closing each entry.
const fakeGit = (entries) => (args) => {
  if (args[0] !== 'worktree' || args[1] !== 'list') {
    return { status: 1, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  }
  const stdout = entries.map((entry) => {
    const fields = [`worktree ${entry.path}`, `HEAD ${entry.head ?? 'a'.repeat(40)}`];
    if (entry.branch) fields.push(`branch refs/heads/${entry.branch}`);
    else fields.push('detached');
    if (entry.prunable) fields.push('prunable');
    return `${fields.map((f) => `${f}\0`).join('')}\0`;
  }).join('');
  return { status: 0, stdout, stderr: '' };
};

const recordText = ({ slug, branch }) => [
  `# Handoff — ${slug}`,
  '',
  'provisioned, nothing done yet',
  '',
  '## Provision record',
  '',
  `- slug: ${slug}`,
  `- branch: ${branch}`,
  '- include: (none)',
  '- node_modules: no-dependencies',
  '- vscode-settings: written',
  '',
].join('\n');

// A satellite checkout: docs/plans plus whatever handoff the case needs.
const makeSatellite = (name, { handoff = null, text = null, link = false } = {}) => {
  const wt = join(TMP, name);
  mkdirSync(join(wt, 'docs', 'plans'), { recursive: true });
  if (handoff !== null) {
    const abs = join(wt, 'docs', 'plans', handoff);
    if (link) symlinkSync('elsewhere.md', abs);
    else writeFileSync(abs, text ?? recordText({ slug: name, branch: `aw/${name}` }));
  }
  return wt;
};

const MAIN = join(TMP, 'main');
mkdirSync(MAIN, { recursive: true });

describe('satellite-locator — resolving a slug to its satellite', () => {
  it('resolves a slug to its satellite through the handoff, and reads the recorded identity', async () => {
    const { findSatelliteEntry, readSatelliteIdentity } = await load();
    const wt = makeSatellite('alpha', {
      handoff: 'handoff-alpha.md',
      text: recordText({ slug: 'alpha', branch: 'aw/alpha' }),
    });
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: wt, branch: 'aw/alpha' }]);
    const entry = findSatelliteEntry({ root: MAIN, slug: 'alpha', branch: null, git, fs: FS });
    assert.equal(entry.path, wt);
    const identity = readSatelliteIdentity({ entry, slug: 'alpha', fs: FS });
    assert.equal(identity.record.slug, 'alpha');
    assert.equal(identity.branch, 'aw/alpha');
    assert.equal(identity.path, join(wt, 'docs', 'plans', 'handoff-alpha.md'));
  });

  it('two worktrees carrying the same handoff refuse as a duplicate identity', async () => {
    const { findSatelliteEntry, WORKTREES_STOP } = await load();
    const a = makeSatellite('dup-a', { handoff: 'handoff-dup.md', text: recordText({ slug: 'dup', branch: 'aw/dup' }) });
    const b = makeSatellite('dup-b', { handoff: 'handoff-dup.md', text: recordText({ slug: 'dup', branch: 'aw/dup' }) });
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: a, branch: 'aw/dup' }, { path: b, branch: 'aw/dup-b' }]);
    assert.throws(
      () => findSatelliteEntry({ root: MAIN, slug: 'dup', branch: null, git, fs: FS }),
      (e) => e.code === WORKTREES_STOP && /multiple worktrees carry handoff-dup\.md/.test(e.message),
    );
  });

  it('falls back to the default branch when no handoff names the slug', async () => {
    const { findSatelliteEntry } = await load();
    const wt = makeSatellite('beta');
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: wt, branch: 'aw/beta' }]);
    assert.equal(findSatelliteEntry({ root: MAIN, slug: 'beta', branch: null, git, fs: FS }).path, wt);
  });

  it('an unregistered slug STOPs with no registered satellite worktree', async () => {
    const { findSatelliteEntry, WORKTREES_STOP } = await load();
    const git = fakeGit([{ path: MAIN, branch: 'main' }]);
    assert.throws(
      () => findSatelliteEntry({ root: MAIN, slug: 'zulu', branch: null, git, fs: FS }),
      (e) => e.code === WORKTREES_STOP && /no registered satellite worktree for zulu/.test(e.message),
    );
  });
});

describe('satellite-locator — the worktrees facade still carries every moved name', () => {
  it('findSatelliteEntry and readSatelliteIdentity import through worktrees.mjs as the same functions', async () => {
    const leaf = await import('./satellite-locator.mjs');
    const facade = await import('./worktrees.mjs');
    // Identity, not merely presence: a facade that re-implemented or wrapped either one would give a
    // caller a second behaviour under the same import site, which is exactly what the extraction
    // promised not to do.
    assert.equal(facade.findSatelliteEntry, leaf.findSatelliteEntry);
    assert.equal(facade.readSatelliteIdentity, leaf.readSatelliteIdentity);
    for (const name of ['WORKTREES_STOP', 'stop', 'EXIT', 'handoffBasename', 'parseWorktreeList', 'DEFAULT_BRANCH_PREFIX']) {
      assert.notEqual(facade[name], undefined, `the facade must still export ${name}`);
    }
  });
});

describe('satellite-locator — proving the handoff identity', () => {
  it('a handoff whose recorded branch differs from the live worktree is an identity mismatch', async () => {
    const { findSatelliteEntry, readSatelliteIdentity, WORKTREES_STOP } = await load();
    const wt = makeSatellite('drift', {
      handoff: 'handoff-drift.md',
      text: recordText({ slug: 'drift', branch: 'aw/other' }),
    });
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: wt, branch: 'aw/drift' }]);
    const entry = findSatelliteEntry({ root: MAIN, slug: 'drift', branch: null, git, fs: FS });
    assert.throws(
      () => readSatelliteIdentity({ entry, slug: 'drift', fs: FS }),
      (e) => e.code === WORKTREES_STOP && /handoff identity mismatch/.test(e.message),
    );
  });

  it('an identity mismatch renders foreign record values escaped, never raw', async () => {
    const { findSatelliteEntry, readSatelliteIdentity } = await load();
    const { hasControlByte } = await import('./worktrees-record.mjs');
    // The record is hand-editable and this message is read in a terminal: a C1 byte in the recorded
    // branch would otherwise forge a line at the exact moment the tool is reporting distrust.
    const hostileBranch = `aw/x${String.fromCharCode(0x9b)}1m`;
    const wt = makeSatellite('escaped', {
      handoff: 'handoff-escaped.md',
      text: recordText({ slug: 'escaped', branch: hostileBranch }),
    });
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: wt, branch: 'aw/escaped' }]);
    const entry = findSatelliteEntry({ root: MAIN, slug: 'escaped', branch: null, git, fs: FS });
    assert.throws(
      () => readSatelliteIdentity({ entry, slug: 'escaped', fs: FS }),
      (e) => hasControlByte(e.message) === false && e.message.includes('\\u009b'),
    );
  });

  it('a non-regular handoff node is an identity mismatch, never a read', async () => {
    const { findSatelliteEntry, readSatelliteIdentity, WORKTREES_STOP } = await load();
    const wt = makeSatellite('linked', { handoff: 'handoff-linked.md', link: true });
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: wt, branch: 'aw/linked' }]);
    const entry = findSatelliteEntry({ root: MAIN, slug: 'linked', branch: null, git, fs: FS });
    assert.throws(
      () => readSatelliteIdentity({ entry, slug: 'linked', fs: FS }),
      (e) => e.code === WORKTREES_STOP && /is not a regular file/.test(e.message),
    );
  });

  it('a handoff with no Provision record section refuses with the record parser own STOP', async () => {
    const { findSatelliteEntry, readSatelliteIdentity, WORKTREES_STOP } = await load();
    const wt = makeSatellite('bare', {
      handoff: 'handoff-bare.md',
      text: '# Handoff — bare\n\nnotes only, no record\n',
    });
    const git = fakeGit([{ path: MAIN, branch: 'main' }, { path: wt, branch: 'aw/bare' }]);
    const entry = findSatelliteEntry({ root: MAIN, slug: 'bare', branch: null, git, fs: FS });
    assert.throws(
      () => readSatelliteIdentity({ entry, slug: 'bare', fs: FS }),
      (e) => e.code === WORKTREES_STOP && /missing required "## Provision record" section/.test(e.message),
    );
  });
});

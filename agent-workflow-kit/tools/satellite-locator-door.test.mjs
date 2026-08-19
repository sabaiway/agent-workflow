// satellite-locator-door.test.mjs — the locator owns NO content-read door (delegation Plan 3,
// Phase 2, round-1 fold).
//
// Reverting the two worktrees tripwires to their recorded bytes proves the door did not LEAVE
// worktrees.mjs. It does not prove the new claim: that the locator leaf reads only through the
// INJECTED reader and holds no body of its own. A direct implementation there would satisfy every
// other suite in this phase. So the claim gets its own two-sided proof — a source scan for the
// primitives, and a spy showing the injected seam is what actually reads.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCATOR = new URL('./satellite-locator.mjs', import.meta.url);

const fakeGit = (entries) => (args) => {
  if (args[0] !== 'worktree' || args[1] !== 'list') {
    return { status: 1, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  }
  const stdout = entries.map((entry) => {
    const fields = [`worktree ${entry.path}`, `HEAD ${'a'.repeat(40)}`, `branch refs/heads/${entry.branch}`];
    return `${fields.map((f) => `${f}\0`).join('')}\0`;
  }).join('');
  return { status: 0, stdout, stderr: '' };
};

// A directory tree answered entirely from memory: no real filesystem, so a leaf that reached for one
// would fail rather than quietly succeed.
const stubFs = (handoffBytes, calls) => ({
  lstat: (path) => ({
    isSymbolicLink: () => false,
    isFile: () => path.endsWith('.md'),
    isDirectory: () => !path.endsWith('.md'),
  }),
  readdir: () => ['handoff-alpha.md'],
  realpath: (path) => path,
  readFileNoFollow: (abs) => {
    calls.push(abs);
    return handoffBytes === null ? { absent: true } : { bytes: Buffer.from(handoffBytes) };
  },
});

const RECORD = [
  '# Handoff — alpha', '', '## Provision record', '',
  '- slug: alpha', '- branch: aw/alpha', '- include: (none)',
  '- node_modules: no-dependencies', '- vscode-settings: written', '',
].join('\n');

describe('satellite-locator — the leaf holds no read door of its own', () => {
  it('the locator source carries no direct Node read or open call', () => {
    const source = readFileSync(LOCATOR, 'utf8');
    const count = (re) => (source.match(re) ?? []).length;
    assert.equal(count(/readFileSync\(/g), 0, 'no readFileSync( body may live here');
    assert.equal(count(/openSync\(/g), 0, 'no openSync( body may live here');
    assert.equal(count(/\breadFile\(/g), 0, 'no raw readFile( call may live here');
    assert.equal(count(/createReadStream|readSync\(|readvSync|readFile\b(?!NoFollow)/g), 0);
    assert.match(source, /fs\.readFileNoFollow\(/, 'the content read must go through the injected seam');
  });

  it('readSatelliteIdentity reads the handoff through the injected reader, never a path of its own', async () => {
    const { findSatelliteEntry, readSatelliteIdentity } = await import('./satellite-locator.mjs');
    const wt = '/virtual/main--alpha';
    const calls = [];
    const fs = stubFs(RECORD, calls);
    const git = fakeGit([{ path: '/virtual/main', branch: 'main' }, { path: wt, branch: 'aw/alpha' }]);
    const entry = findSatelliteEntry({ root: '/virtual/main', slug: 'alpha', branch: null, git, fs });
    const identity = readSatelliteIdentity({ entry, slug: 'alpha', fs });
    assert.equal(identity.record.slug, 'alpha');
    assert.deepEqual(calls, [join(wt, 'docs/plans', 'handoff-alpha.md')], 'exactly one read, through the seam');
  });

  it('a structured non-ok outcome from the injected reader is a typed identity mismatch', async () => {
    const { findSatelliteEntry, readSatelliteIdentity, WORKTREES_STOP } = await import('./satellite-locator.mjs');
    const calls = [];
    const fs = stubFs(null, calls);
    const git = fakeGit([{ path: '/virtual/main', branch: 'main' }, { path: '/virtual/main--alpha', branch: 'aw/alpha' }]);
    const entry = findSatelliteEntry({ root: '/virtual/main', slug: 'alpha', branch: null, git, fs });
    assert.throws(
      () => readSatelliteIdentity({ entry, slug: 'alpha', fs }),
      (e) => e.code === WORKTREES_STOP && /not readable as a regular file/.test(e.message),
    );
    assert.equal(calls.length, 1);
  });
});

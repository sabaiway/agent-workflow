// node-evidence.test.mjs — the four-state Node-evidence table (docs/ai/specs/kit/node-evidence.md).
// Dynamic import: the suite LOADS without the module, so the red proof observes assertion failures.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidence = await import('./node-evidence.mjs').catch(() => ({}));
const { NODE_EVIDENCE, NODE_EVIDENCE_SCRIPTS, NODE_EVIDENCE_PROBES, probeNodeEvidence, hasNodeEvidence, describeNodeProbes } = evidence;

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-evidence-'));
  dirs.push(dir);
  return dir;
};
const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

describe('probeNodeEvidence — enumerated by proof', () => {
  it('a root package.json answers package-json before any script is probed (spec:node-evidence/S1)', () => {
    const dir = project();
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'check-docs-size.mjs'), '// deployed\n');
    const probed = [];
    const lstat = (p) => { probed.push(p); return { isFile: () => true }; };
    const r = probeNodeEvidence(dir, lstat);
    assert.equal(r.state, NODE_EVIDENCE.PACKAGE_JSON);
    assert.equal(r.evidence, 'package.json');
    assert.equal(probed.length, 1, 'the first regular file answers — no script was probed');
    assert.equal(hasNodeEvidence(r), true);
  });

  it('a kit-seeded script without a package.json answers deployed-node-scripts naming the file (spec:node-evidence/S2)', () => {
    const dir = project();
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'check-docs-size.mjs'), '// deployed\n');
    const r = probeNodeEvidence(dir);
    assert.equal(r.state, NODE_EVIDENCE.DEPLOYED_SCRIPTS);
    assert.equal(r.evidence, 'scripts/check-docs-size.mjs');
    assert.equal(hasNodeEvidence(r), true);
  });

  it('neither answers none, and the probed list names package.json and every seed script (spec:node-evidence/S3)', () => {
    const r = probeNodeEvidence(project());
    assert.equal(r.state, NODE_EVIDENCE.NONE);
    assert.equal(r.evidence, null);
    assert.equal(hasNodeEvidence(r), false);
    assert.deepEqual([...r.probed], ['package.json', ...NODE_EVIDENCE_SCRIPTS.map((name) => `scripts/${name}`)]);
    assert.deepEqual([...NODE_EVIDENCE_PROBES], [...r.probed]);
    for (const name of NODE_EVIDENCE_SCRIPTS) assert.ok(describeNodeProbes().includes(name), `${name} is named in the description`);
    assert.ok(describeNodeProbes().startsWith('package.json'));
  });

  it('a probe failing with anything but ENOENT answers unreadable, and a wrong node kind is not evidence (spec:node-evidence/S4)', () => {
    const dir = project();
    mkdirSync(join(dir, 'package.json')); // a directory named package.json is not a package
    mkdirSync(join(dir, 'scripts'));
    symlinkSync(join(dir, 'nowhere'), join(dir, 'scripts', 'archive-caps.mjs')); // a dangling link is not a deployed script
    writeFileSync(join(dir, 'scripts', 'spec-schema.mjs'), '// deployed\n');
    const kinds = probeNodeEvidence(dir);
    assert.equal(kinds.state, NODE_EVIDENCE.DEPLOYED_SCRIPTS, 'the walk continues past the wrong kinds');
    assert.equal(kinds.evidence, 'scripts/spec-schema.mjs');
    assert.deepEqual([...kinds.wrongKind], ['package.json is a directory', 'scripts/archive-caps.mjs is a symlink']);
    assert.ok(
      describeNodeProbes(kinds).endsWith('— not evidence: package.json is a directory; scripts/archive-caps.mjs is a symlink'),
      'the skip line names every path of the wrong kind',
    );
    const clean = probeNodeEvidence(project());
    assert.deepEqual([...clean.wrongKind], [], 'nothing of the wrong kind sat at any probe');
    // A SYMLINKED scripts/ pointing at another checkout holds files that are not this tree's: the
    // directory is proven plain before any script inside it counts, so a link there is never evidence.
    const elsewhere = project();
    mkdirSync(join(elsewhere, 'real-scripts'));
    writeFileSync(join(elsewhere, 'real-scripts', 'check-docs-size.mjs'), '// someone else\n');
    symlinkSync(join(elsewhere, 'real-scripts'), join(elsewhere, 'scripts'));
    const linked = probeNodeEvidence(elsewhere);
    assert.equal(linked.state, NODE_EVIDENCE.NONE, 'a symlinked scripts/ proves nothing');
    assert.deepEqual([...linked.wrongKind], ['scripts is a symlink']);
    const asFile = project();
    writeFileSync(join(asFile, 'scripts'), 'not a directory\n');
    assert.deepEqual([probeNodeEvidence(asFile).state, [...probeNodeEvidence(asFile).wrongKind]], [NODE_EVIDENCE.NONE, ['scripts is a regular file']]);
    assert.doesNotMatch(describeNodeProbes(clean), /not evidence/);
    assert.doesNotMatch(describeNodeProbes(), /not evidence/);

    const lstat = (p) => { if (p.endsWith('package.json')) throw eacces(); return { isFile: () => true }; };
    const r = probeNodeEvidence(dir, lstat);
    assert.equal(r.state, NODE_EVIDENCE.UNREADABLE);
    assert.equal(r.evidence, null);
    assert.match(r.error, /EACCES on package\.json/);
    assert.equal(hasNodeEvidence(r), false);
    const plainDir = { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false };
    const late = (p) => {
      if (p.endsWith('/scripts')) return plainDir;
      if (p.endsWith('scripts/archive-changelog.mjs')) throw eacces();
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    assert.equal(probeNodeEvidence(dir, late).state, NODE_EVIDENCE.UNREADABLE, 'an unreadable probe later in the walk still answers unreadable');
  });

  it('the probed set equals the runnable bundled scripts, pinned against references/scripts (spec:node-evidence/S5)', () => {
    const bundled = readdirSync(join(KIT_ROOT, 'references', 'scripts'))
      .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && !name.startsWith('_'))
      .sort();
    assert.deepEqual([...NODE_EVIDENCE_SCRIPTS].sort(), bundled);
    assert.ok(Object.isFrozen(NODE_EVIDENCE_SCRIPTS));
    assert.deepEqual(Object.values(NODE_EVIDENCE).sort(), ['deployed-node-scripts', 'none', 'package-json', 'unreadable']);
  });
});

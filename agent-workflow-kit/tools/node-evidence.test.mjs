// node-evidence.test.mjs — the four-state Node-evidence table (docs/ai/specs/kit/node-evidence.md).
// Dynamic import: the suite LOADS without the module, so the red proof observes assertion failures.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripGitLocationEnv } from './git-env.mjs';

const evidence = await import('./node-evidence.mjs').catch(() => ({}));
const { NODE_EVIDENCE, readNodeEvidenceScripts, readNodeEvidenceProbes, readDeployedScripts, probeNodeEvidence, hasNodeEvidence, describeNodeProbes } = evidence;

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The nine flat runnable names probed before revision 8, frozen: a flat deployment keeps its evidence.
const FLAT_NAMES = Object.freeze([
  'archive-caps.mjs', 'archive-changelog.mjs', 'archive-decisions.mjs', 'archive-issues.mjs', 'check-docs-size.mjs',
  'install-git-hooks.mjs', 'markdown-blocks.mjs', 'migrate-gates.mjs', 'spec-schema.mjs',
]);
const KIT_DIR = 'scripts/agent-workflow';
const KIT_INSTALLER = `${KIT_DIR}/git-hooks/install-git-hooks.mjs`;
// The kit mirror's manifest, read through its one reader (imported here so the suite loads without it).
const kitFamily = async () => (await import('../references/scripts/family.mjs')).readFamily(join(KIT_ROOT, 'references', 'scripts'));
const deployedOf = (family) => family.filter(({ role }) => role === 'deployed');
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

  it('without a package.json, a deployed script at scripts/agent-workflow/<path> answers deployed-node-scripts naming that path, and so does a flat scripts/check-docs-size.mjs alone (spec:node-evidence/S2)', async () => {
    const lone = (rel) => {
      const dir = project();
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), '// deployed\n');
      const r = probeNodeEvidence(dir);
      return [r.state, r.evidence, hasNodeEvidence(r)];
    };
    assert.deepEqual(lone(KIT_INSTALLER), [NODE_EVIDENCE.DEPLOYED_SCRIPTS, KIT_INSTALLER, true]);
    for (const { path } of deployedOf(await kitFamily())) {
      assert.deepEqual(lone(`${KIT_DIR}/${path}`), [NODE_EVIDENCE.DEPLOYED_SCRIPTS, `${KIT_DIR}/${path}`, true], path);
    }
    assert.deepEqual(lone('scripts/check-docs-size.mjs'), [NODE_EVIDENCE.DEPLOYED_SCRIPTS, 'scripts/check-docs-size.mjs', true]);
  });

  it('neither answers none, and the probed list names package.json, the nine flat names at scripts/ and every deployed path under scripts/agent-workflow/ (spec:node-evidence/S3)', async () => {
    const r = probeNodeEvidence(project());
    assert.equal(r.state, NODE_EVIDENCE.NONE);
    assert.equal(r.evidence, null);
    assert.equal(hasNodeEvidence(r), false);
    assert.ok(r.probed.includes(KIT_INSTALLER), `${KIT_INSTALLER} is probed`);
    const deployed = deployedOf(await kitFamily()).map(({ path }) => path);
    assert.deepEqual([...r.probed], ['package.json', ...FLAT_NAMES.map((name) => `scripts/${name}`), ...[...deployed].sort().map((path) => `${KIT_DIR}/${path}`)]);
    assert.deepEqual([...readNodeEvidenceProbes()], [...r.probed]);
    for (const name of [...FLAT_NAMES, ...deployed]) assert.ok(describeNodeProbes().includes(name), `${name} is named in the description`);
    assert.ok(describeNodeProbes().startsWith('package.json'));
  });

  it('a probe failing with anything but ENOENT answers unreadable, and a wrong node kind is not evidence, a linked or non-directory folder on the way skipping the probes beneath it (spec:node-evidence/S4)', () => {
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

    // The kit folder and each module folder are proven plain before a script beneath them counts.
    const shaped = (build) => {
      const root = project();
      mkdirSync(join(root, 'elsewhere', 'git-hooks'), { recursive: true });
      writeFileSync(join(root, 'elsewhere', 'git-hooks', 'install-git-hooks.mjs'), '// someone else\n');
      build(root);
      const r = probeNodeEvidence(root);
      return [r.state, [...r.wrongKind]];
    };
    assert.deepEqual(shaped((root) => {
      mkdirSync(join(root, 'scripts'));
      symlinkSync(join(root, 'elsewhere'), join(root, KIT_DIR));
    }), [NODE_EVIDENCE.NONE, [`${KIT_DIR} is a symlink`]], 'a symlinked kit folder proves nothing');
    assert.deepEqual(shaped((root) => {
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, KIT_DIR), 'not a directory\n');
    }), [NODE_EVIDENCE.NONE, [`${KIT_DIR} is a regular file`]]);
    assert.deepEqual(shaped((root) => {
      mkdirSync(join(root, KIT_DIR), { recursive: true });
      symlinkSync(join(root, 'elsewhere', 'git-hooks'), join(root, KIT_DIR, 'git-hooks'));
    }), [NODE_EVIDENCE.NONE, [`${KIT_DIR}/git-hooks is a symlink`]], 'a symlinked module folder proves nothing');
    assert.deepEqual(shaped((root) => {
      mkdirSync(join(root, KIT_DIR), { recursive: true });
      writeFileSync(join(root, KIT_DIR, 'git-hooks'), 'not a directory\n');
    }), [NODE_EVIDENCE.NONE, [`${KIT_DIR}/git-hooks is a regular file`]]);
    const linkedScript = project();
    mkdirSync(join(linkedScript, KIT_DIR, 'archives'), { recursive: true });
    mkdirSync(join(linkedScript, KIT_DIR, 'git-hooks'));
    symlinkSync(join(linkedScript, 'nowhere'), join(linkedScript, KIT_DIR, 'archives', 'archive-caps.mjs'));
    writeFileSync(join(linkedScript, KIT_INSTALLER), '// deployed\n');
    const pastLink = probeNodeEvidence(linkedScript);
    assert.deepEqual([pastLink.state, pastLink.evidence, [...pastLink.wrongKind]],
      [NODE_EVIDENCE.DEPLOYED_SCRIPTS, KIT_INSTALLER, [`${KIT_DIR}/archives/archive-caps.mjs is a symlink`]], 'a symlink at a deployed path is named and passed');
    const kitDenied = (p) => {
      if (p.endsWith('/scripts')) return plainDir;
      if (p.endsWith('/scripts/agent-workflow')) throw eacces();
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const denied = probeNodeEvidence(dir, kitDenied);
    assert.equal(denied.state, NODE_EVIDENCE.UNREADABLE, 'an unreadable kit folder answers unreadable');
    assert.match(denied.error, /EACCES on scripts\/agent-workflow$/);
  });

  describe('the family readers defer manifest reads (spec:node-evidence/S5)', () => {
    it('returns the manifest deployed entries and flat probes as stable frozen values without retired exports', async () => {
      const family = await kitFamily(), deployed = deployedOf(family);
      const scripts = [...FLAT_NAMES, ...deployed.map(({ path }) => path).sort().map((path) => `agent-workflow/${path}`)];
      assert.deepEqual(readNodeEvidenceScripts(), scripts);
      assert.deepEqual(readNodeEvidenceProbes(), ['package.json', ...scripts.map((path) => `scripts/${path}`)]);
      assert.deepEqual(readDeployedScripts(), deployed.map(({ path, module, seed }) => ({ path, module, seed, deployed: `${KIT_DIR}/${path}`, bundled: `references/scripts/${path}` })));
      for (const read of [readDeployedScripts, readNodeEvidenceScripts, readNodeEvidenceProbes]) {
        const value = read();
        assert.equal(read(), value);
        assert.ok(Object.isFrozen(value));
      }
      for (const { path, role } of family.filter(({ role }) => role !== 'deployed')) assert.equal(readNodeEvidenceProbes().includes(`${KIT_DIR}/${path}`), false, `${role} ${path}`);
      assert.equal(evidence.INSTALLER_REL, KIT_INSTALLER);
      assert.deepEqual(readDeployedScripts().filter(({ module }) => module === 'git-hooks').map(({ deployed }) => deployed), [evidence.INSTALLER_REL]);
      const { KIT_FOLDER_ROOT } = await import('./source-size-config.mjs');
      assert.equal(evidence.KIT_SCRIPTS_DIR, KIT_FOLDER_ROOT);
      for (const name of ['DEPLOYED_SCRIPTS', 'NODE_EVIDENCE_SCRIPTS', 'NODE_EVIDENCE_PROBES', 'BUNDLED_SCRIPT_NAMES']) assert.equal(name in evidence, false, name);
      assert.deepEqual(Object.values(NODE_EVIDENCE).sort(), ['deployed-node-scripts', 'none', 'package-json', 'unreadable']);
    });
    it('imports without reading, checking status or listing files', () => {
      const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        const calls = [];
        for (const name of ['readFileSync', 'readFile', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'readdir']) {
          const original = fs[name];
          fs[name] = (...args) => {
            if (!(new Error().stack.split('\\n')[2] ?? '').includes('node:')) calls.push([name, String(args[0])]);
            return original.apply(fs, args);
          };
        }
        syncBuiltinESMExports(); await import(${JSON.stringify(new URL('./node-evidence.mjs', import.meta.url).href)});
        console.log(JSON.stringify(calls));`;
      const env = Object.fromEntries(Object.entries(stripGitLocationEnv(process.env)).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env, encoding: 'utf8' });
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), []);
    });
    for (const name of ['readDeployedScripts', 'probeNodeEvidence']) it(`${name} throws the refused manifest message from its first call`, async () => {
      const { readFamily } = await import('../references/scripts/family.mjs');
      const original = fs.readFileSync, refused = {}, manifest = join(KIT_ROOT, 'references/scripts/family.json');
      fs.readFileSync = (path, ...args) => String(path) === manifest ? '{}' : original(path, ...args);
      syncBuiltinESMExports();
      try {
        assert.throws(() => readFamily(), (error) => { refused.message = error.message; return true; });
        const fresh = await import(`./node-evidence.mjs?refused-${name}`);
        assert.throws(() => fresh[name](...(name === 'probeNodeEvidence' ? [project()] : [])), { message: refused.message });
      } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    });
  });
});

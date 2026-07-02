import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT,
  resolvePackageDir,
  readSkillMetadataVersion,
  readChangelogHeadingVersion,
  collectSources,
  checkPackage,
  runCli,
} from './version-sync.mjs';

const tempDirs = [];
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'version-sync-'));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Seed a fixture package dir carrying the standard four sources (overridable per source).
const seedPackage = (root, dir, { pkg = '1.2.0', cap = '1.2.0', skill = '1.2.0', changelog = '1.2.0' } = {}) => {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  if (pkg !== null) writeFileSync(join(full, 'package.json'), JSON.stringify({ name: dir, version: pkg }, null, 2));
  if (cap !== null) writeFileSync(join(full, 'capability.json'), JSON.stringify({ schema: 1, name: dir, version: cap }, null, 2));
  if (skill !== null) {
    writeFileSync(
      join(full, 'SKILL.md'),
      `---\nname: ${dir}\ndescription: x\nmetadata:\n  version: '${skill}'\n---\n\n# ${dir}\n`,
    );
  }
  if (changelog !== null) writeFileSync(join(full, 'CHANGELOG.md'), `# Changelog\n\n## ${changelog}\n\n- stuff\n`);
  return full;
};

const run = (argv, root) => {
  const out = [];
  const err = [];
  const code = runCli([...argv, '--root', root], { log: (l) => out.push(l), logError: (l) => err.push(l) });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
};

describe('source parsers', () => {
  it('reads the SKILL.md frontmatter metadata.version (quoted or bare), never the body', () => {
    assert.equal(readSkillMetadataVersion(`---\nmetadata:\n  version: '2.3.4'\n---\nbody 9.9.9`), '2.3.4');
    assert.equal(readSkillMetadataVersion(`---\nmetadata:\n  version: 2.3.4\n---\n`), '2.3.4');
    assert.equal(readSkillMetadataVersion('no frontmatter\nversion: 1.0.0'), null);
  });

  it('is indent-aware: a decoy version nested DEEPER under metadata never matches (direct child only)', () => {
    const nestedDecoy = `---\nmetadata:\n  extra:\n    version: 9.9.9\n  version: '2.3.4'\n---\n`;
    assert.equal(readSkillMetadataVersion(nestedDecoy), '2.3.4', 'the direct child wins, not the nested decoy');
    const onlyDecoy = `---\nmetadata:\n  extra:\n    version: 9.9.9\n---\n`;
    assert.equal(readSkillMetadataVersion(onlyDecoy), null, 'a nested-only version is NOT a metadata.version');
    const afterDedent = `---\nmetadata:\n  version: '2.3.4'\nother:\n  version: 8.8.8\n---\n`;
    assert.equal(readSkillMetadataVersion(afterDedent), '2.3.4', 'a version under a LATER top-level key never matches');
  });

  it('reads the NEWEST (first) CHANGELOG heading', () => {
    assert.equal(readChangelogHeadingVersion('# C\n\n## 1.5.0\n\n## 1.4.0\n'), '1.5.0');
    assert.equal(readChangelogHeadingVersion('# C\n\nno headings\n'), null);
  });

  it('resolves short aliases to package dirs and rejects unknowns loudly', () => {
    assert.equal(resolvePackageDir('kit'), 'agent-workflow-kit');
    assert.equal(resolvePackageDir('agent-workflow-memory'), 'agent-workflow-memory');
    assert.throws(() => resolvePackageDir('nope'), /unknown package "nope"/);
  });
});

describe('collectSources — per-package source set is resolved, never assumed', () => {
  it('a bridge-shaped package (no package.json) contributes only what it carries', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-memory', { pkg: null, changelog: null });
    const sources = collectSources(root, 'agent-workflow-memory');
    assert.deepEqual(sources.map((s) => s.file), ['agent-workflow-memory/capability.json', 'agent-workflow-memory/SKILL.md']);
  });
});

describe('checkPackage / runCli — mismatch detection', () => {
  it('a fully-synced fixture is in sync → exit 0', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-memory');
    const { code, text } = run([], root);
    assert.equal(code, 0);
    assert.match(text, /agent-workflow-memory: 1\.2\.0 — in sync \(4 sources\)/);
    assert.match(text, /all sources in sync/);
  });

  it('a one-source mismatch → exit 1 naming the FILE and the VALUE', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-memory', { cap: '1.1.0' });
    const { code, errText } = run([], root);
    assert.equal(code, 1);
    assert.match(errText, /agent-workflow-memory\/capability\.json: 1\.1\.0 ≠ 1\.2\.0/);
  });

  it('a package.json ⟷ SKILL.md divergence is caught (package.json is authoritative)', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit', { skill: '1.1.0' });
    const { code, errText } = run([], root);
    assert.equal(code, 1);
    assert.match(errText, /agent-workflow-kit\/SKILL\.md: 1\.1\.0 ≠ 1\.2\.0 \(authoritative package\.json\)/);
  });

  it('a stale CHANGELOG heading is caught', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-engine', { changelog: '1.1.0' });
    const report = checkPackage(root, 'agent-workflow-engine');
    assert.equal(report.inSync, false);
    assert.match(report.problems[0], /CHANGELOG\.md: 1\.1\.0 ≠ 1\.2\.0/);
  });

  it('a present-but-unparseable source is a defect, never silently skipped', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-memory', { changelog: null });
    writeFileSync(join(root, 'agent-workflow-memory', 'CHANGELOG.md'), '# Changelog\n\nno version headings yet\n');
    const { code, errText } = run([], root);
    assert.equal(code, 1);
    assert.match(errText, /CHANGELOG\.md: carries no parseable version/);
  });
});

describe('--expect assertions', () => {
  it('an expectation met (with full sync) → exit 0; wrong version → exit 1 with both values', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit');
    assert.equal(run(['--expect', 'kit=1.2.0'], root).code, 0);
    const { code, errText } = run(['--expect', 'kit=1.3.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /expected 1\.3\.0, found 1\.2\.0/);
  });

  it('an expectation on an out-of-sync package fails even at the right base version', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit', { cap: '1.1.9' });
    const { code, errText } = run(['--expect', 'kit=1.2.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /not in sync/);
  });

  it('usage errors are loud: bad --expect shape, unknown package', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit');
    assert.equal(run(['--expect', 'kit'], root).code, 2);
    assert.equal(run(['--expect', 'nope=1.0.0'], root).code, 2);
  });
});

describe('--json', () => {
  it('emits a machine-readable report with inSync + per-package sources', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-memory', { skill: '9.9.9' });
    const { code, text } = run(['--json'], root);
    assert.equal(code, 1);
    const parsed = JSON.parse(text);
    assert.equal(parsed.inSync, false);
    assert.equal(parsed.packages[0].dir, 'agent-workflow-memory');
    assert.ok(parsed.problems.some((p) => p.includes('SKILL.md: 9.9.9')));
  });
});

describe('the real tree', () => {
  it('the current repo is fully in sync (release invariant)', () => {
    const { code, errText } = run([], REPO_ROOT);
    assert.equal(code, 0, `real tree out of sync:\n${errText}`);
  });
});

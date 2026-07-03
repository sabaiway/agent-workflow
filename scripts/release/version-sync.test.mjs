import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT,
  resolvePackageDir,
  readSkillMetadataVersion,
  readChangelogHeadingVersion,
  writeSkillMetadataVersion,
  makeChangelogStubHeading,
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

const run = (argv, root, extraDeps = {}) => {
  const out = [];
  const err = [];
  const code = runCli([...argv, '--root', root], { log: (l) => out.push(l), logError: (l) => err.push(l), ...extraDeps });
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

// ── the --bump writer (D3–D5) ─────────────────────────────────────────────────────────

const TODAY = '2026-07-03';

describe('--bump writer — happy path', () => {
  it('--bump kit=1.3.0 edits exactly the four kit sources; the separate verify pass + --expect both pass', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit');
    const { code, text } = run(['--bump', 'kit=1.3.0'], root, { today: TODAY });
    assert.equal(code, 0);
    assert.match(text, /agent-workflow-kit\/package\.json: 1\.2\.0 → 1\.3\.0/);
    assert.match(text, /agent-workflow-kit\/capability\.json: 1\.2\.0 → 1\.3\.0/);
    assert.match(text, /agent-workflow-kit\/SKILL\.md: 1\.2\.0 → 1\.3\.0/);
    assert.match(text, /agent-workflow-kit\/CHANGELOG\.md: RELEASE-STUB heading inserted above 1\.2\.0/);
    assert.equal(run([], root).code, 0, 'the no-flag verify pass reports in sync at the new version');
    assert.equal(run(['--expect', 'kit=1.3.0'], root).code, 0, 'the --expect verify pass (separate invocation) passes');
  });

  it('the diff is version-lines-only: JSON formatting, SKILL body decoy and CHANGELOG history byte-preserved', () => {
    const root = makeRoot();
    const dir = seedPackage(root, 'agent-workflow-memory');
    const skillText = `---\nname: m\ndescription: x\nmetadata:\n  version: '1.2.0'\n---\n\n# m\n\nbody decoy version: 9.9.9\n`;
    writeFileSync(join(dir, 'SKILL.md'), skillText);
    const pkgBefore = readFileSync(join(dir, 'package.json'), 'utf8');
    const capBefore = readFileSync(join(dir, 'capability.json'), 'utf8');
    const changelogBefore = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    assert.equal(run(['--bump', 'memory=1.3.0'], root, { today: TODAY }).code, 0);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), pkgBefore.replace('"version": "1.2.0"', '"version": "1.3.0"'));
    assert.equal(readFileSync(join(dir, 'capability.json'), 'utf8'), capBefore.replace('"version": "1.2.0"', '"version": "1.3.0"'));
    assert.equal(
      readFileSync(join(dir, 'SKILL.md'), 'utf8'),
      skillText.replace("version: '1.2.0'", "version: '1.3.0'"),
      'only the metadata.version line changed — the body decoy is untouched',
    );
    assert.equal(
      readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'),
      changelogBefore.replace('## 1.2.0', `${makeChangelogStubHeading('1.3.0', TODAY)}\n\n## 1.2.0`),
      'the stub is inserted above the previous newest heading; history bytes preserved',
    );
  });

  it('CHANGELOG stub parses as newest, carries the marker + date; a re-run never duplicates it', () => {
    const root = makeRoot();
    const dir = seedPackage(root, 'agent-workflow-engine');
    assert.equal(run(['--bump', 'engine=1.3.0'], root, { today: TODAY }).code, 0);
    const text = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    assert.equal(readChangelogHeadingVersion(text), '1.3.0', 'the stub heading is the newest version');
    assert.match(text, /RELEASE-STUB/);
    assert.match(text, new RegExp(TODAY));
    const rerun = run(['--bump', 'engine=1.3.0'], root, { today: TODAY });
    assert.equal(rerun.code, 0);
    assert.match(rerun.text, /newest heading already at 1\.3\.0 \(no duplicate stub\)/);
    assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), text, 'idempotent — bytes unchanged');
    assert.equal(text.match(/RELEASE-STUB/g).length, 1);
  });

  it('a bridge bump writes its 2 canon sources AND re-syncs the kit mirror byte-identical (D5)', () => {
    const root = makeRoot();
    const canon = seedPackage(root, 'codex-cli-bridge', { pkg: null, changelog: null });
    const mirror = join(root, 'agent-workflow-kit', 'bridges', 'codex-cli-bridge');
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, 'capability.json'), 'stale mirror\n');
    writeFileSync(join(mirror, 'SKILL.md'), 'stale mirror\n');
    const { code, text } = run(['--bump', 'codex=1.3.0'], root, { today: TODAY });
    assert.equal(code, 0);
    assert.match(text, /codex-cli-bridge: kit bridge mirror re-synced \(2 file\(s\) changed\)/);
    for (const file of ['capability.json', 'SKILL.md']) {
      assert.deepEqual(readFileSync(join(mirror, file)), readFileSync(join(canon, file)), `${file} mirror byte-identical`);
    }
    assert.match(readFileSync(join(canon, 'capability.json'), 'utf8'), /"version": "1\.3\.0"/);
  });

  it('repair: a source already at the target is skipped with a stated note; only lagging sources written', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit', { pkg: '1.3.0' }); // a killed half-write left package.json ahead
    const { code, text } = run(['--bump', 'kit=1.3.0'], root, { today: TODAY });
    assert.equal(code, 0);
    assert.match(text, /package\.json: skipped — already at 1\.3\.0/);
    assert.match(text, /capability\.json: 1\.2\.0 → 1\.3\.0/);
    assert.equal(run(['--expect', 'kit=1.3.0'], root).code, 0, 'the repair converges to full sync');
  });
});

describe('--bump writer — refusals (no partial write, distinct exits)', () => {
  it('usage (exit 2): --bump with --expect, non-semver, unknown pkg, duplicate pkg', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit');
    const combined = run(['--bump', 'kit=1.3.0', '--expect', 'kit=1.3.0'], root);
    assert.equal(combined.code, 2);
    assert.match(combined.errText, /cannot share one invocation/);
    assert.equal(run(['--bump', 'kit=1.3'], root).code, 2);
    assert.equal(run(['--bump', 'nope=1.3.0'], root).code, 2);
    assert.equal(run(['--bump', 'kit=1.3.0', '--bump', 'kit=1.4.0'], root).code, 2);
  });

  it('an unparseable target source → loud refusal naming the file, zero writes', () => {
    const root = makeRoot();
    const dir = seedPackage(root, 'agent-workflow-kit');
    writeFileSync(join(dir, 'capability.json'), '{ not json\n');
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const { code, errText } = run(['--bump', 'kit=1.3.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /agent-workflow-kit\/capability\.json: carries no parseable version/);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before, 'zero writes — package.json untouched');
  });

  it('an npm package missing one of its four sources → loud refusal naming it; the OTHER bump target is untouched too', () => {
    const root = makeRoot();
    const memory = seedPackage(root, 'agent-workflow-memory');
    seedPackage(root, 'agent-workflow-kit', { changelog: null }); // kit ships without CHANGELOG.md
    const memoryBefore = readFileSync(join(memory, 'package.json'), 'utf8');
    const { code, errText } = run(['--bump', 'memory=1.3.0', '--bump', 'kit=1.3.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /agent-workflow-kit\/CHANGELOG\.md: expected source is ABSENT/);
    assert.equal(readFileSync(join(memory, 'package.json'), 'utf8'), memoryBefore, 'global preflight: the first target saw zero writes');
  });

  it('a target below the current authoritative version → downgrade refusal', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit');
    const { code, errText } = run(['--bump', 'kit=1.1.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /downgrade refused/);
  });
});

describe('writeSkillMetadataVersion mirrors the reader scoping (decoy-proof)', () => {
  it('rewrites the direct child only — nested and later-top-level decoys never touched', () => {
    const nested = `---\nmetadata:\n  extra:\n    version: 9.9.9\n  version: '2.3.4'\n---\n`;
    assert.equal(writeSkillMetadataVersion(nested, '3.0.0'), `---\nmetadata:\n  extra:\n    version: 9.9.9\n  version: '3.0.0'\n---\n`);
    const afterDedent = `---\nmetadata:\n  version: 2.3.4\nother:\n  version: 8.8.8\n---\nbody 9.9.9\n`;
    assert.equal(writeSkillMetadataVersion(afterDedent, '3.0.0'), `---\nmetadata:\n  version: 3.0.0\nother:\n  version: 8.8.8\n---\nbody 9.9.9\n`);
    assert.equal(writeSkillMetadataVersion('no frontmatter\nversion: 1.0.0', '3.0.0'), null);
  });
});

describe('the real tree', () => {
  it('the current repo is fully in sync (release invariant)', () => {
    const { code, errText } = run([], REPO_ROOT);
    assert.equal(code, 0, `real tree out of sync:\n${errText}`);
  });
});

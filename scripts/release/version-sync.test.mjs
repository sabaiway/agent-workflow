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
  findBridgeVersionAnchors,
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

// A review wrapper with the AW_BRIDGE_VERSION anchor; and a sibling wrapper carrying no anchor.
const SH = (backend, version) => `#!/usr/bin/env bash\nAW_RECEIPT_BACKEND="${backend}"\nAW_BRIDGE_VERSION="${version}"\necho review\n`;
const NO_ANCHOR_SH = '#!/usr/bin/env bash\necho no version anchor here\n';
const BACKEND = { 'codex-cli-bridge': 'codex', 'antigravity-cli-bridge': 'agy' };

// Seed a bridge (canonical + byte-identical kit mirror): capability.json + SKILL.md + a
// bin/<backend>-review.sh carrying the AW_BRIDGE_VERSION anchor, plus the mirror under
// agent-workflow-kit/bridges/<dir>. Each surface is overridable so a test can inject drift.
const seedBridge = (root, dir, {
  cap = '1.2.0', skill = '1.2.0', canonWrapper = '1.2.0', mirrorWrapper = '1.2.0',
  canonAnchor = true, mirrorAnchor = true, extraCanonSh = null, extraMirrorSh = null,
} = {}) => {
  const backend = BACKEND[dir];
  const wrapperName = `${backend}-review.sh`;
  seedPackage(root, dir, { pkg: null, changelog: null, cap, skill });
  const canonBin = join(root, dir, 'bin');
  mkdirSync(canonBin, { recursive: true });
  writeFileSync(join(canonBin, wrapperName), canonAnchor ? SH(backend, canonWrapper) : NO_ANCHOR_SH);
  if (extraCanonSh) writeFileSync(join(canonBin, `${backend}-exec.sh`), extraCanonSh);

  const mirrorDir = join(root, 'agent-workflow-kit', 'bridges', dir);
  const mirrorBin = join(mirrorDir, 'bin');
  mkdirSync(mirrorBin, { recursive: true });
  writeFileSync(join(mirrorDir, 'capability.json'), readFileSync(join(root, dir, 'capability.json')));
  writeFileSync(join(mirrorDir, 'SKILL.md'), readFileSync(join(root, dir, 'SKILL.md')));
  writeFileSync(join(mirrorBin, wrapperName), mirrorAnchor ? SH(backend, mirrorWrapper) : NO_ANCHOR_SH);
  if (extraMirrorSh) writeFileSync(join(mirrorBin, `${backend}-exec.sh`), extraMirrorSh);
  return { backend, wrapperName, canonBin, mirrorBin, mirrorDir };
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

  it('a bridge bump moves its 2 sources AND the AW_BRIDGE_VERSION wrapper anchor on BOTH the canonical and the kit mirror (D5 + 4.1)', () => {
    const root = makeRoot();
    const canon = join(root, 'codex-cli-bridge');
    const { canonBin, mirrorBin, mirrorDir, wrapperName } = seedBridge(root, 'codex-cli-bridge');
    const { code, text } = run(['--bump', 'codex=1.3.0'], root, { today: TODAY });
    assert.equal(code, 0, text);
    assert.match(text, /codex-cli-bridge\/bin\/codex-review\.sh: AW_BRIDGE_VERSION 1\.2\.0 → 1\.3\.0/);
    assert.match(text, /codex-cli-bridge: kit bridge mirror re-synced \(3 file\(s\) changed\)/);
    assert.match(readFileSync(join(canon, 'capability.json'), 'utf8'), /"version": "1\.3\.0"/);
    // The wrapper anchor moved on BOTH constants — the canonical wrapper and its kit mirror.
    assert.match(readFileSync(join(canonBin, wrapperName), 'utf8'), /AW_BRIDGE_VERSION="1\.3\.0"/);
    assert.match(readFileSync(join(mirrorBin, wrapperName), 'utf8'), /AW_BRIDGE_VERSION="1\.3\.0"/, 'the mirror wrapper moved via syncBridgeMirror');
    for (const rel of ['capability.json', 'SKILL.md', `bin/${wrapperName}`]) {
      assert.deepEqual(readFileSync(join(mirrorDir, rel)), readFileSync(join(canon, rel)), `${rel} mirror byte-identical`);
    }
    assert.equal(checkPackage(root, 'codex-cli-bridge').inSync, true, 'the bridge verify converges — wrapper + mirror included');
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

// ── the AW_BRIDGE_VERSION wrapper constant lane (Phase 4 — the AD-053 drift class) ──────
// The wrapper's OWN receipt-emits-the-manifest-version pin lives in the bridge bin tests
// (codex-review.test.mjs / agy-review.test.mjs) — cited, never duplicated here. This block owns the
// version-sync side: the bump moves the anchor + the verify catches its drift (canonical + mirror).
describe('the AW_BRIDGE_VERSION wrapper constant lane (Phase 4)', () => {
  it('a fully-synced bridge (wrapper + kit-mirror anchors == base) is in sync', () => {
    const root = makeRoot();
    seedBridge(root, 'codex-cli-bridge');
    const report = checkPackage(root, 'codex-cli-bridge');
    assert.equal(report.inSync, true, report.problems.join('; '));
  });

  it('a CANONICAL wrapper drift reds verify, naming the file and both values', () => {
    const root = makeRoot();
    seedBridge(root, 'codex-cli-bridge', { canonWrapper: '1.1.0' });
    const report = checkPackage(root, 'codex-cli-bridge');
    assert.equal(report.inSync, false);
    assert.ok(report.problems.some((p) => /codex-cli-bridge\/bin\/codex-review\.sh: AW_BRIDGE_VERSION 1\.1\.0 ≠ 1\.2\.0/.test(p)), report.problems.join('; '));
  });

  it('a MIRROR-ONLY wrapper drift also reds verify (the AD-053 defect spanned the mirror too)', () => {
    const root = makeRoot();
    seedBridge(root, 'codex-cli-bridge', { mirrorWrapper: '1.1.0' });
    const report = checkPackage(root, 'codex-cli-bridge');
    assert.equal(report.inSync, false);
    assert.ok(report.problems.some((p) => /agent-workflow-kit\/bridges\/codex-cli-bridge\/bin\/codex-review\.sh: AW_BRIDGE_VERSION 1\.1\.0/.test(p)), report.problems.join('; '));
  });

  it('a MISSING anchor reds verify (expected exactly one, found 0)', () => {
    const root = makeRoot();
    seedBridge(root, 'codex-cli-bridge', { canonAnchor: false });
    const report = checkPackage(root, 'codex-cli-bridge');
    assert.equal(report.inSync, false);
    assert.ok(report.problems.some((p) => /codex-cli-bridge\/bin\/\*\.sh: expected EXACTLY ONE AW_BRIDGE_VERSION anchor, found 0/.test(p)), report.problems.join('; '));
  });

  it('a DUPLICATE anchor across two bin/*.sh reds verify (found 2)', () => {
    const root = makeRoot();
    seedBridge(root, 'codex-cli-bridge', { extraCanonSh: SH('codex', '1.2.0') });
    const report = checkPackage(root, 'codex-cli-bridge');
    assert.equal(report.inSync, false);
    assert.ok(report.problems.some((p) => /found 2/.test(p)), report.problems.join('; '));
  });

  it('findBridgeVersionAnchors counts one entry per anchor OCCURRENCE (two in ONE file are not undercounted to 1)', () => {
    const root = makeRoot();
    const bin = join(root, 'codex-cli-bridge', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex-review.sh'), '#!/usr/bin/env bash\nAW_BRIDGE_VERSION="1.2.0"\nAW_BRIDGE_VERSION="1.3.0"\n');
    assert.equal(findBridgeVersionAnchors(join(root, 'codex-cli-bridge')).length, 2);
  });

  it('a multi-.sh bridge bump changes ONLY the anchored review wrapper; a sibling bin/*.sh is byte-identical', () => {
    const root = makeRoot();
    const { canonBin } = seedBridge(root, 'codex-cli-bridge', { extraCanonSh: NO_ANCHOR_SH, extraMirrorSh: NO_ANCHOR_SH });
    const execBefore = readFileSync(join(canonBin, 'codex-exec.sh'), 'utf8');
    assert.equal(run(['--bump', 'codex=1.3.0'], root, { today: TODAY }).code, 0);
    assert.match(readFileSync(join(canonBin, 'codex-review.sh'), 'utf8'), /AW_BRIDGE_VERSION="1\.3\.0"/);
    assert.equal(readFileSync(join(canonBin, 'codex-exec.sh'), 'utf8'), execBefore, 'the non-anchored sibling wrapper is untouched');
  });

  it('a MISSING-anchor bump refuses with ZERO writes across every target (a co-bumped npm package + the mirror untouched)', () => {
    const root = makeRoot();
    const kit = seedPackage(root, 'agent-workflow-kit');
    const { mirrorBin, wrapperName } = seedBridge(root, 'codex-cli-bridge', { canonAnchor: false });
    const kitPkgBefore = readFileSync(join(kit, 'package.json'), 'utf8');
    const mirrorBefore = readFileSync(join(mirrorBin, wrapperName), 'utf8');
    const { code, errText } = run(['--bump', 'kit=1.3.0', '--bump', 'codex=1.3.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /found 0 — refusing the bump/);
    assert.equal(readFileSync(join(kit, 'package.json'), 'utf8'), kitPkgBefore, 'global preflight: the co-bumped kit saw zero writes');
    assert.equal(readFileSync(join(mirrorBin, wrapperName), 'utf8'), mirrorBefore, 'the mirror wrapper is untouched (refusal precedes syncBridgeMirror)');
  });

  it('a DUPLICATE-anchor bump refuses with ZERO writes (found 2)', () => {
    const root = makeRoot();
    const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge', { extraCanonSh: SH('codex', '1.2.0') });
    const reviewBefore = readFileSync(join(canonBin, wrapperName), 'utf8');
    const { code, errText } = run(['--bump', 'codex=1.3.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /found 2 — refusing the bump/);
    assert.equal(readFileSync(join(canonBin, wrapperName), 'utf8'), reviewBefore, 'zero writes on the duplicate-anchor refusal');
  });

  it('a non-bridge (npm) bump never fires the wrapper lane — a stray bin/*.sh is ignored', () => {
    const root = makeRoot();
    seedPackage(root, 'agent-workflow-kit');
    const bin = join(root, 'agent-workflow-kit', 'bin');
    mkdirSync(bin, { recursive: true });
    const strayBefore = '#!/usr/bin/env bash\nAW_BRIDGE_VERSION="9.9.9"\n';
    writeFileSync(join(bin, 'stray.sh'), strayBefore);
    const { code, text } = run(['--bump', 'kit=1.3.0'], root, { today: TODAY });
    assert.equal(code, 0);
    assert.ok(!/AW_BRIDGE_VERSION/.test(text), 'the wrapper lane never fires for an npm package');
    assert.equal(readFileSync(join(bin, 'stray.sh'), 'utf8'), strayBefore, 'the stray bin/*.sh is untouched');
  });

  it('R1 fold: the wrapper-drift message names capability.json (the true comparison source), never a misleading "authoritative" label', () => {
    const root = makeRoot();
    seedBridge(root, 'codex-cli-bridge', { canonWrapper: '1.1.0' });
    const drift = checkPackage(root, 'codex-cli-bridge').problems.find((p) => /AW_BRIDGE_VERSION 1\.1\.0/.test(p));
    assert.ok(drift, 'the drift is reported');
    assert.match(drift, /\(capability\.json\)$/, 'the message names capability.json as the compared source');
    assert.doesNotMatch(drift, /authoritative capability\.json/, 'no misleading "authoritative capability.json" label');
  });

  it('R2 fold: a SHADOWING assignment (a canonical anchor + a later malformed one) is caught — anchors count BOTH, bump AND verify red', () => {
    const root = makeRoot();
    const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge');
    // Append a second, non-canonical assignment: bash uses the LAST, so the receipt would drift — the
    // check must count EVERY assignment, not only well-formed ones.
    writeFileSync(join(canonBin, wrapperName), `${readFileSync(join(canonBin, wrapperName), 'utf8')}AW_BRIDGE_VERSION=9.9.9\n`);
    assert.equal(findBridgeVersionAnchors(join(root, 'codex-cli-bridge')).length, 2, 'both assignments counted, not just the canonical one');
    assert.ok(checkPackage(root, 'codex-cli-bridge').problems.some((p) => /found 2/.test(p)), 'verify reds on the shadowing pair');
    const { code, errText } = run(['--bump', 'codex=1.3.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /found 2 — refusing the bump/);
  });

  it('#5 fold: an EXPORT-prefixed shadow (export/declare/readonly/…) is counted too — not only a bare statement-start assignment', () => {
    const root = makeRoot();
    const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge');
    // `export AW_BRIDGE_VERSION="9.9.9"` is a valid shell shadow bash resolves LAST; a bare-only
    // regex missed it, so verify stayed green while the receipt drifted. It must count as a second anchor.
    writeFileSync(join(canonBin, wrapperName), `${readFileSync(join(canonBin, wrapperName), 'utf8')}export AW_BRIDGE_VERSION="9.9.9"\n`);
    assert.equal(findBridgeVersionAnchors(join(root, 'codex-cli-bridge')).length, 2, 'the export-prefixed shadow is detected, not skipped');
    assert.ok(checkPackage(root, 'codex-cli-bridge').problems.some((p) => /found 2/.test(p)), 'verify reds on the export shadow');
  });

  it('#5 R2/R3 fold: append (+=), option-terminator (export --), and +x-flag (declare/typeset +x) shadows are all counted', () => {
    for (const shadow of ['AW_BRIDGE_VERSION+=".1"', 'export -- AW_BRIDGE_VERSION="9.9.9"', 'declare +x AW_BRIDGE_VERSION="9.9.9"', 'typeset +x AW_BRIDGE_VERSION="9.9.9"']) {
      const root = makeRoot();
      const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge');
      writeFileSync(join(canonBin, wrapperName), `${readFileSync(join(canonBin, wrapperName), 'utf8')}${shadow}\n`);
      assert.equal(findBridgeVersionAnchors(join(root, 'codex-cli-bridge')).length, 2, `the shadow "${shadow}" is detected, not skipped`);
      assert.ok(checkPackage(root, 'codex-cli-bridge').problems.some((p) => /found 2/.test(p)), `verify reds on "${shadow}"`);
    }
  });

  it('#5 R2/R3 fold: a SINGLE non-canonical anchor via +=/terminator/+x-flag reds as not canonical (detected then rejected, never rewritten)', () => {
    for (const form of ['#!/usr/bin/env bash\nAW_BRIDGE_VERSION+="1.2.0"\necho x\n', '#!/usr/bin/env bash\nexport -- AW_BRIDGE_VERSION="1.2.0"\necho x\n', '#!/usr/bin/env bash\ndeclare +x AW_BRIDGE_VERSION="1.2.0"\necho x\n']) {
      const root = makeRoot();
      const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge');
      writeFileSync(join(canonBin, wrapperName), form);
      const before = readFileSync(join(canonBin, wrapperName), 'utf8');
      const report = checkPackage(root, 'codex-cli-bridge');
      assert.ok(report.problems.some((p) => /not a canonical/.test(p)), `${form.split('\n')[1]} → not canonical: ${report.problems.join('; ')}`);
      const { code } = run(['--bump', 'codex=1.5.0'], root);
      assert.equal(code, 1);
      assert.equal(readFileSync(join(canonBin, wrapperName), 'utf8'), before, 'a non-canonical anchor is never rewritten');
    }
  });

  it('R2 fold: a single NON-CANONICAL AW_BRIDGE_VERSION (unquoted) reds verify as not canonical', () => {
    const root = makeRoot();
    const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge');
    writeFileSync(join(canonBin, wrapperName), '#!/usr/bin/env bash\nAW_BRIDGE_VERSION=1.2.0\necho x\n');
    const report = checkPackage(root, 'codex-cli-bridge');
    assert.equal(report.inSync, false);
    assert.ok(report.problems.some((p) => /not a canonical/.test(p)), report.problems.join('; '));
  });

  it('R4 fold: a bump REFUSES a non-canonical (unquoted) anchor — never canonicalizes it down (the downgrade-bypass hole)', () => {
    const root = makeRoot();
    const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge');
    // An unquoted anchor AHEAD of the target: shell-valid (9.9.9) but not canonical — the bump must
    // never rewrite it (rewriting down to 1.5.0 would be a silent downgrade past the valid-only guard).
    writeFileSync(join(canonBin, wrapperName), '#!/usr/bin/env bash\nAW_BRIDGE_VERSION=9.9.9\necho x\n');
    const before = readFileSync(join(canonBin, wrapperName), 'utf8');
    const { code, errText } = run(['--bump', 'codex=1.5.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /not a canonical/);
    assert.equal(readFileSync(join(canonBin, wrapperName), 'utf8'), before, 'zero writes — a non-canonical anchor is never rewritten');
  });

  it('R3 fold: a bump that would DOWNGRADE the wrapper anchor (anchor ahead of target) is refused, zero writes', () => {
    const root = makeRoot();
    const { canonBin, wrapperName } = seedBridge(root, 'codex-cli-bridge', { canonWrapper: '2.0.0', mirrorWrapper: '2.0.0' });
    const before = readFileSync(join(canonBin, wrapperName), 'utf8');
    const { code, errText } = run(['--bump', 'codex=1.5.0'], root);
    assert.equal(code, 1);
    assert.match(errText, /downgrade refused/i);
    assert.equal(readFileSync(join(canonBin, wrapperName), 'utf8'), before, 'zero writes on the wrapper-downgrade refusal');
  });

  it('R2 fold: the wrapper bump + verify cover BOTH bridges (the agy/antigravity path is exercised too)', () => {
    for (const [dir, alias] of [['codex-cli-bridge', 'codex'], ['antigravity-cli-bridge', 'agy']]) {
      const root = makeRoot();
      const { canonBin, mirrorBin, wrapperName } = seedBridge(root, dir);
      assert.equal(run(['--bump', `${alias}=1.3.0`], root, { today: TODAY }).code, 0, `${dir} bump succeeds`);
      assert.match(readFileSync(join(canonBin, wrapperName), 'utf8'), /AW_BRIDGE_VERSION="1\.3\.0"/, `${dir} canonical wrapper moved`);
      assert.match(readFileSync(join(mirrorBin, wrapperName), 'utf8'), /AW_BRIDGE_VERSION="1\.3\.0"/, `${dir} kit-mirror wrapper moved`);
      assert.equal(checkPackage(root, dir).inSync, true, `${dir} verify converges`);
      writeFileSync(join(canonBin, wrapperName), readFileSync(join(canonBin, wrapperName), 'utf8').replace('1.3.0', '1.1.0'));
      assert.equal(checkPackage(root, dir).inSync, false, `${dir} wrapper drift reds verify`);
    }
  });
});

describe('the real tree', () => {
  it('the current repo is fully in sync (release invariant)', () => {
    const { code, errText } = run([], REPO_ROOT);
    assert.equal(code, 0, `real tree out of sync:\n${errText}`);
  });
});

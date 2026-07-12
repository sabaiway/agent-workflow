// Release-records guard (REC-UX-REWORK): every released package's CHANGELOG must lead
// with a REAL entry for the package's CURRENT version — a leftover `RELEASE-STUB` heading or a
// newest entry whose version lags the bumped metadata means the release records were not written.
// The dispatcher refuses a stub at dispatch time; this repo test catches the same class at the
// gate matrix, before a review round is spent on a records-less tree. In any committed tree this
// is always green (version-sync inserts the stub and the bump atomically; the entry replaces the
// stub before the commit ask) — a red here is the honest mid-release "records pending" state.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// dir → the authoritative current-version source (package.json where one exists, else SKILL.md
// frontmatter — the same split version-sync syncs).
const PACKAGES = [
  ['agent-workflow-kit', 'package.json'],
  ['agent-workflow-engine', 'package.json'],
  ['agent-workflow-memory', 'package.json'],
];

const newestHeading = (changelogText) => changelogText.split('\n').find((l) => l.startsWith('## '));
// Exact-equality version extraction — a substring check would let 1.4.0 match a hypothetical
// 11.4.0 heading; the FIRST semver in the newest heading must equal the package version.
const firstSemver = (text) => text?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;

describe('release records — every package CHANGELOG leads with a real entry for the current version', () => {
  for (const [dir, versionSource] of PACKAGES) {
    it(`${dir}: newest CHANGELOG heading carries the current version and no RELEASE-STUB`, () => {
      const version = JSON.parse(readFileSync(join(ROOT, dir, versionSource), 'utf8')).version;
      const heading = newestHeading(readFileSync(join(ROOT, dir, 'CHANGELOG.md'), 'utf8'));
      assert.ok(heading, `${dir}/CHANGELOG.md has a newest entry heading`);
      assert.equal(firstSemver(heading), version, `${dir} newest entry (${heading}) leads with the current version ${version}`);
      assert.ok(!heading.includes('RELEASE-STUB'), `${dir} newest entry is a real entry, not the version-sync stub: ${heading}`);
    });
  }

  it('the root CHANGELOG newest family entry names the current kit version', () => {
    const kitVersion = JSON.parse(readFileSync(join(ROOT, 'agent-workflow-kit', 'package.json'), 'utf8')).version;
    const heading = newestHeading(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
    assert.ok(heading, 'the root CHANGELOG has a newest entry heading');
    const kitSemver = heading.match(/kit (\d+\.\d+\.\d+)/)?.[1] ?? null;
    assert.equal(kitSemver, kitVersion, `the root newest entry (${heading}) names kit ${kitVersion} exactly`);
  });
});

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, scanText, classifyTarget, TARGET } from './release-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// main() reports on stdout for every outcome (findings, accounting, refusals) — capture it and
// return the exit code so a refusal is an assertion, never a killed runner.
const runMain = (argv) => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    return { code: main(argv), out: logs.join('\n') };
  } finally {
    console.log = original;
  }
};

const COAUTHOR = 'Co-' + 'Authored-By: Claude <noreply@anthropic.com>';
const LONG_REVIEWER = ['Co', 'dex'].join('');
const SHORT_REVIEWER = ['a', 'gy'].join('');
const ROUND_ONE = ['R', '1'].join('');
const ROUND_TWO = ['r', '2'].join('');

describe('main — a clean tree states the clean verdict', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'aw-release-scan-'));
  after(() => rmSync(TMP, { recursive: true, force: true }));
  it('prints the clean line and returns without exiting', () => {
    writeFileSync(join(TMP, 'clean.mjs'), 'export const ok = 1;\n');
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      main([TMP]);
    } finally {
      console.log = original;
    }
    assert.match(logs.join('\n'), /clean — no AI attribution or reviewer-round identity found/);
  });
});

describe('scanText — attribution detection', () => {
  it('flags a co-author trailer', () => {
    const f = scanText(`fix: thing\n\n${COAUTHOR}\n`);
    assert.ok(f.some((x) => x.kind === 'attribution' && /co-author/.test(x.detail)));
  });

  it('flags an AI "Generated with" footer', () => {
    const f = scanText('🤖 Generated with Claude Code\n');
    assert.ok(f.some((x) => x.kind === 'attribution'));
  });

  it('flags "Reviewed by <AI>"', () => {
    const f = scanText('Reviewed by Codex and approved.\n');
    assert.ok(f.some((x) => x.kind === 'attribution' && /review/.test(x.detail)));
  });

  it('does NOT flag a legitimate review-tool description', () => {
    const ok = 'You are a meticulous staff-level reviewer giving a second opinion.\n';
    assert.deepEqual(scanText(ok), []);
  });

  it('does NOT flag "auto-generated navigator"', () => {
    assert.deepEqual(scanText('the auto-generated index.md navigator\n'), []);
  });

  it('does NOT flag legitimate product names (Claude, Codex, Gemini, GPT-OSS) as prose', () => {
    const ok = 'agy reaches Gemini, Claude, and GPT-OSS; codex-exec runs in a sandbox.\n';
    assert.deepEqual(scanText(ok), []);
  });

  it('does NOT flag clean prose with emoji, math symbols, em-dash, and accents', () => {
    const clean = '## 🧭 Memory Map — caps ≤ 100, provides ⊇ roles · café façade naïve\n';
    assert.deepEqual(scanText(clean), []);
  });

  it('flags a reviewer-round identity in a comment case-insensitively', () => {
    const fixture = ['// finding retained (', LONG_REVIEWER, ' ', ROUND_ONE, ' major)'].join('');
    const f = scanText(fixture);
    assert.ok(f.some((x) => x.kind === 'reviewer-identity' && /reviewer-round/.test(x.detail)));
  });

  it('flags a reviewer-round identity in a test title', () => {
    const fixture = ['it("boundary pin — ', SHORT_REVIEWER, ' ', ROUND_TWO, '", () => {})'].join('');
    assert.ok(scanText(fixture).some((x) => x.kind === 'reviewer-identity'));
  });

  it('flags a hyphen-separated reviewer-round identity', () => {
    const fixture = '// finding retained (' + ['co', 'dex-R2'].join('') + ')';
    assert.ok(scanText(fixture).some((x) => x.kind === 'reviewer-identity'));
  });

  it('flags the REVERSE-ORDER round-then-backend identity — the release-review gap', () => {
    const fixture = '// a Phase-4 ' + [ROUND_TWO, ' ', SHORT_REVIEWER].join('') + ' REWORK';
    assert.ok(scanText(fixture).some((x) => x.kind === 'reviewer-identity' && /reviewer-round/.test(x.detail)));
  });

  it('does NOT flag literal bridge product names OR a versioned product mention', () => {
    const fixture = 'codex-review agy-review codex-exec agy-run codex-cli-bridge antigravity-cli-bridge\ncodex-cli-bridge 3.1.0 and agy bridge 4.1.0\n';
    assert.deepEqual(scanText(fixture), []);
  });

  // The scanner scans the whole kit tree INCLUDING its own source, so a literal reviewer-identity
  // example in a COMMENT would make the release-scan gate flag the scanner itself. Pin the TOOL
  // self-clean (its comments must describe the patterns without spelling a literal identity). The
  // test file is deliberately NOT checked here — it necessarily holds attribution fixtures and is
  // self-excluded by the scanner (EXCLUDE_FILE_NAMES), which the real-tree scan below exercises.
  it('the release-scan tool carries no reviewer identity of its own (self-clean source)', () => {
    const src = readFileSync(join(HERE, 'release-scan.mjs'), 'utf8');
    assert.deepEqual(scanText(src), [], 'release-scan.mjs must be self-clean under its own scanner');
  });

  it('the whole kit tools/ tree scans clean via main() — the fixture-holding test is self-excluded', () => {
    const { code, out } = runMain([HERE]); // includes this fixture-laden, self-excluded test file
    assert.equal(code, 0, 'the tool source is clean');
    assert.match(out, /clean — no AI attribution or reviewer-round identity found/,
      'the fixture-laden test file is self-excluded; the tool source is clean');
  });
});

// A target the caller NAMED that contributes no file must never fold into the clean verdict: an
// empty file list is indistinguishable from a clean one in the report, so a mis-aimed scan reads
// as proof of cleanliness. The directory-name exclusions make this reachable by accident.
describe('main — per-target contribution accounting (a named target that scans nothing is a mis-aim)', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'aw-release-scan-targets-'));
  after(() => rmSync(TMP, { recursive: true, force: true }));

  const seedPlans = () => {
    const dir = join(TMP, 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'draft.md'), `fold applied per ${['co', 'dex R5'].join('')} blocker\n`);
    return dir;
  };

  it('refuses a directory target excluded by its own basename instead of calling it clean', () => {
    const dir = seedPlans();
    const { code, out } = runMain([dir]);
    assert.equal(code, 1, 'an excluded target is a refusal, not a clean verdict');
    assert.doesNotMatch(out, /clean — no AI attribution/, 'the false-green line must not appear');
    assert.match(out, /plans/, 'the refusal names the target');
    assert.match(out, /excluded/, 'the refusal names the CAUSE, not just the count');
  });

  it('scans the same excluded-directory content when the file is named directly', () => {
    const dir = seedPlans();
    const { code, out } = runMain([join(dir, 'draft.md')]);
    assert.equal(code, 1, 'the direct file path reaches the scanner');
    assert.match(out, /reviewer-identity/, 'the finding the directory form hid');
  });

  it('refuses an existing directory that holds nothing scannable', () => {
    const dir = join(TMP, 'hollow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'logo.png'), 'not text\n');
    const { code, out } = runMain([dir]);
    assert.equal(code, 1, 'zero contribution from an existing target is a refusal');
    assert.match(out, /hollow/, 'the refusal names the target');
  });

  it('refuses a missing target that carries no glob metacharacter — a mis-aimed path', () => {
    const { code, out } = runMain([join(TMP, 'no-such-dir')]);
    assert.equal(code, 1, 'a plain path that does not exist is a mis-aim, not an optional target');
    assert.match(out, /no-such-dir/, 'the refusal names the target');
  });

  // The declared gate lists shell globs (scripts/sync-mirrors*.mjs). bash passes an UNMATCHED glob
  // through literally, so refusing every missing path would break a legitimate optional target.
  it('treats an unmatched glob target as an optional skip, never a refusal', () => {
    writeFileSync(join(TMP, 'kept.md'), 'clean prose\n');
    const { code, out } = runMain([join(TMP, 'kept.md'), join(TMP, 'absent-*.mjs')]);
    assert.equal(code, 0, 'an unmatched glob never fails the scan');
    assert.match(out, /absent-\*\.mjs/, 'the skip is still stated, never silent');
  });

  it('refuses a mixed invocation when any single target contributes nothing', () => {
    writeFileSync(join(TMP, 'real.md'), 'clean prose\n');
    const { code } = runMain([join(TMP, 'real.md'), seedPlans()]);
    assert.equal(code, 1, 'one productive target never covers for a mis-aimed one');
  });

  it('refuses a non-text file named directly as a target — naming it does not make it scannable', () => {
    const png = join(TMP, 'logo.png');
    writeFileSync(png, 'not text\n');
    assert.equal(classifyTarget(png).status, TARGET.excluded);
    const { code, out } = runMain([png]);
    assert.equal(code, 1);
    assert.match(out, /logo\.png/, 'the refusal names the target');
  });

  it('refuses the scanner test file named directly — a self-excluded file is still a zero contribution', () => {
    assert.equal(classifyTarget(join(HERE, 'release-scan.test.mjs')).status, TARGET.excluded);
  });

  it('states a usage refusal when no target is named at all', () => {
    const errs = [];
    const original = console.error;
    console.error = (line) => errs.push(String(line));
    try {
      assert.equal(main([]), 2, 'no target is a usage error, never an empty clean verdict');
    } finally {
      console.error = original;
    }
    assert.match(errs.join('\n'), /usage: release-scan\.mjs/);
  });

  it('classifies each target form distinctly so the refusal can name its cause', () => {
    assert.equal(classifyTarget(join(TMP, 'no-such-dir')).status, TARGET.missing);
    assert.equal(classifyTarget(join(TMP, 'absent-*.mjs')).status, TARGET.unmatchedGlob);
    assert.equal(classifyTarget(seedPlans()).status, TARGET.excluded);
    assert.equal(classifyTarget(join(TMP, 'real.md')).status, TARGET.scanned);
  });
});

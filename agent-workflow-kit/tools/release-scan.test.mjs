import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, scanText, scanVersionPins, classifyTarget, TARGET } from './release-scan.mjs';

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

// A harness version pin is a documentation claim frozen in code: it goes stale by default and
// nothing reports it. The catcher refuses a BARE pin under tools/ and demands a runtime probe
// beside it — the probe is what turns silent staleness into a loud degrade. A literal in a test
// fixture or a changelog entry records history rather than asserting a live platform fact.
describe('scanVersionPins — the version-pin class-catcher', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'aw-version-pin-'));
  after(() => rmSync(TMP, { recursive: true, force: true }));

  const PIN_LINE = "  degrades.push('claude 2.1.185 has NO sandbox credential denial');\n";

  const seed = (relDir, name, body) => {
    const dir = join(TMP, relDir);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  const pinsIn = (p) => scanVersionPins(readFileSync(p, 'utf8'), p);

  it('scan-refuses-a-bare-harness-version-literal-in-tools', () => {
    const p = seed('tools', 'velocity.mjs', PIN_LINE);
    assert.ok(pinsIn(p).some((x) => x.kind === 'version-pin'),
      'a harness version literal with no probe beside it is a frozen claim, not code');
  });

  it('scan-accepts-a-literal-paired-with-a-runtime-probe', () => {
    const p = seed('tools', 'probed.mjs',
      `import { probeHarnessVersion } from './harness-version.mjs';\nconst h = probeHarnessVersion(deps);\n${PIN_LINE}`);
    assert.deepEqual(pinsIn(p), [],
      'a probe CALLED beside the literal makes staleness loud — that is the whole exemption');
  });

  it('scan-exempts-a-literal-in-a-test-fixture', () => {
    const p = seed('tools', 'velocity.test.mjs', PIN_LINE);
    assert.deepEqual(pinsIn(p), []);
  });

  it('scan-exempts-a-literal-in-a-changelog-entry', () => {
    const p = seed('tools', 'CHANGELOG.md', '## 1.2.0\n\n- claude 2.1.185 had no credential denial.\n');
    assert.deepEqual(pinsIn(p), [], 'a changelog records what was true then, it does not claim it now');
  });

  it('scan-names-path-cause-and-remedy-on-refusal', () => {
    const p = seed('tools', 'velocity.mjs', PIN_LINE);
    const [finding] = pinsIn(p);
    assert.equal(finding.line, 1, 'the finding carries the line');
    assert.match(finding.detail, /2\.1\.185/, 'the refusal quotes the pinned literal');
    assert.match(finding.detail, /probeHarnessVersion/, 'the refusal names the remedy, not just the cause');
  });

  // Every JS-file shape that REFERENCES the probe exempts, and that is the whole contract — see the
  // residual argued in the scanner source. What these cases pin is that the bar is stable across the
  // shapes an author actually writes, not that the scanner can tell a call from a mention.
  for (const [label, body] of [
    ['a plain call', 'const v = probeHarnessVersion(deps);'],
    ['a member call', 'const v = harness.probeHarnessVersion(deps);'],
    ['an import', "import { probeHarnessVersion } from './x.mjs';"],
    ['a declaration', 'export function probeHarnessVersion(deps) { return null; }'],
  ]) {
    it(`${label} exempts a JS file — the bar is that a probe sits beside the literal`, () => {
      const p = seed('tools', `ref-${label.replace(/\W+/g, '-')}.mjs`, `${body}\n${PIN_LINE}`);
      assert.deepEqual(pinsIn(p), []);
    });
  }

  // The exemption is scoped to files that could call anything at all: prose earns nothing, whatever
  // it says. This is what stops a shell comment or a Markdown line from disarming a whole file.
  it('a shell-comment reference in a .sh does NOT exempt — prose cannot hold a probe', () => {
    const p = seed('tools', 'wrapper.sh', `# probeHarnessVersion(deps)\n${PIN_LINE}`);
    assert.ok(pinsIn(p).some((x) => x.kind === 'version-pin'), 'the exemption is for files that can call it');
  });

  it('Markdown prose naming the probe does NOT exempt', () => {
    const p = seed('tools', 'notes.md', `Call probeHarnessVersion(deps) to check.\n${PIN_LINE}`);
    assert.ok(pinsIn(p).some((x) => x.kind === 'version-pin'));
  });

  // A scanner that CRASHES is worse than one that misses — it runs as a commit/CI gate. A pathological
  // file must be classified, not choke the run.
  it('a pathological unbalanced JS file is classified without exhausting anything', () => {
    const p = seed('tools', 'unbalanced.mjs', `const x = someOther(${'a,'.repeat(20000)}\n${PIN_LINE}`);
    assert.ok(pinsIn(p).some((x) => x.kind === 'version-pin'), 'no probe reference, so no exemption');
  });

  it('does NOT flag an unrelated package version sharing the harness major.minor series', () => {
    const p = seed('tools', 'shared-series.mjs', `${PIN_LINE}export const DEP_VERSION = '2.1.0';\n`);
    const lines = pinsIn(p).map((f) => f.line);
    assert.deepEqual(lines, [1], 'only the line that names the harness is a claim');
  });

  it('does NOT flag a package version — only a literal claiming a harness fact', () => {
    const p = seed('tools', 'pkg.mjs', "export const EXPECTED_WORKFLOW_VERSION = '3.0.0';\n");
    assert.deepEqual(pinsIn(p), []);
  });

  it('does NOT flag a harness pin outside tools/ — the check is scoped where claims are made', () => {
    const p = seed('docs', 'notes.md', PIN_LINE);
    assert.deepEqual(pinsIn(p), []);
  });

  it('the catcher carries no harness pin of its own — it would be an instance of its own class', () => {
    const src = join(HERE, 'release-scan.mjs');
    assert.deepEqual(scanVersionPins(readFileSync(src, 'utf8'), src), [],
      'the harness series is discovered from the scanned file, never hardcoded in the scanner');
  });

  // The join: the catcher and the instance ship together, so the catcher must be OBSERVED refusing
  // the file that motivated it. The pre-fix text is frozen here on purpose — reading the live file
  // would pass now and fail again the moment the instance is fixed, proving nothing either time.
  it('class-catcher-refuses-the-pre-fix-velocity-profile', () => {
    const PRE_FIX = [
      '  // network — 2.1.185 regular settings cannot HARD-BLOCK egress; both values render as no allowedDomains',
      "    degrades.push('network=deny requested, but claude 2.1.185 regular settings cannot HARD-BLOCK egress — rendered as prompt-on-egress (the sandbox default: no domains pre-allowed, a new domain still prompts). A silent hard block needs managed settings (allowManagedDomainsOnly).');",
      '  // credentials — 2.1.185 has NO sandbox.credentials at all (deny added 2.1.187, mask 2.1.199). BOTH',
      "  degrades.push('credentials requested, but claude 2.1.185 has NO sandbox credential denial (deny added in 2.1.187, mask in 2.1.199) — NPM_TOKEN/GITHUB_TOKEN and ~/.ssh are NOT hidden from sandboxed commands. Upgrade to 2.1.187+ for sandbox.credentials.');",
      '  // fs_outside_repo — the sandbox default is a HARD confine to cwd+$TMPDIR; 2.1.185 has no',
      "    degrades.push('fs_outside_repo=ask requested, but claude 2.1.185 has no prompt-on-outside-write — rendered as the deny form (writes hard-confined to cwd+$TMPDIR; an outside write is blocked, then auto-retried through the normal permission flow).');",
      '',
    ].join('\n');
    const p = seed('tools', 'velocity-profile.mjs', PRE_FIX);
    const findings = pinsIn(p);
    assert.ok(findings.length > 0, 'the catcher refuses the file that motivated it');
    const lines = findings.map((f) => f.line);
    assert.ok(lines.includes(4), 'the unconditional credentials claim is among the refusals');
    assert.ok(findings.every((f) => f.kind === 'version-pin'));
  });
});

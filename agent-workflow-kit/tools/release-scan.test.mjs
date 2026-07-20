import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, scanText } from './release-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

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
    // main() prints findings then process.exit(1) on any hit (never throws), so a dirty tree fails
    // this test loudly by killing the runner; the try/finally only restores console.log.
    const logs = [];
    const original = console.log;
    console.log = (line) => logs.push(String(line));
    try {
      main([HERE]); // the release-scan tool's own directory — includes this fixture-laden test file
    } finally {
      console.log = original;
    }
    assert.match(logs.join('\n'), /clean — no AI attribution or reviewer-round identity found/,
      'the fixture-laden test file is self-excluded; the tool source is clean');
  });
});

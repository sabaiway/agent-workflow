import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from './release-scan.mjs';

const COAUTHOR = 'Co-' + 'Authored-By: Claude <noreply@anthropic.com>';

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
});

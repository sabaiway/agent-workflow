// grounding-extra-parent-arm.test.mjs — the parent-realpath catch arm of --extra. Own file: both
// grounding test files are byte-frozen under red-proof custody, and a missing-LEAF @file now
// travels the descriptor's absent arm instead — only a missing PARENT reaches this catch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './grounding.mjs';

describe('grounding --extra — a missing PARENT directory is a loud unreadable STOP', () => {
  it('realpath of the parent failing (ENOENT) refuses before any surface check', () => {
    const root = mkdtempSync(join(tmpdir(), 'grounding-noparent-'));
    const r = main(['--extra', `@${join(root, 'no-such-dir', 'facts.md')}`], { cwd: root, env: {} });
    rmSync(root, { recursive: true, force: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--extra file .*unreadable \(ENOENT\)/);
    assert.equal(r.stdout, '');
  });
});

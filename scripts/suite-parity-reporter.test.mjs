// suite-parity-reporter.test.mjs — in-process drive of the reporter generator (Phase-5
// coverage fill; the E2E child in suite-parity.test.mjs strips NODE_V8_COVERAGE by design, so
// the generator body needs its own in-process pin; that spec file is parity-frozen).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import suiteParityReporter from './suite-parity-reporter.mjs';

const event = (dataOver = {}, type = 'test:pass') => ({
  type,
  data: { file: '/repo/a.test.mjs', name: 'adds', nesting: 0, details: { duration_ms: 2 }, skip: false, todo: false, ...dataOver },
});

describe('suiteParityReporter — the generator end-to-end (in-process)', () => {
  it('yields one NDJSON line per point and closes with the per-file wall table', async () => {
    const source = [
      event({ name: 'suite', nesting: 0, details: { duration_ms: 5, type: 'suite' } }),
      event({ name: 'adds', nesting: 1, details: { duration_ms: 2 } }),
      { type: 'test:diagnostic', data: { message: 'ignored' } },
      event({ file: '/repo/b.test.mjs', name: 'boom', nesting: 0, details: { duration_ms: 1 } }, 'test:fail'),
    ];
    const lines = [];
    for await (const chunk of suiteParityReporter(source)) lines.push(chunk);
    const points = lines.filter((l) => !l.startsWith('#'));
    assert.equal(points.length, 3, 'one NDJSON line per pass/fail point, diagnostics ignored');
    assert.equal(JSON.parse(points[2]).fail, true);
    const tail = lines.filter((l) => l.startsWith('#'));
    assert.equal(tail[0], '# per-file wall totals (nesting-0 ms, descending)\n');
    assert.ok(tail.some((l) => /^# file-ms 5\.0 points 2 \/repo\/a\.test\.mjs\n$/.test(l)), 'nesting-0 ms only, per-file point counts');
    assert.ok(tail.some((l) => /^# file-ms 1\.0 points 1 \/repo\/b\.test\.mjs\n$/.test(l)));
  });
});

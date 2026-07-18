// suite-parity-branches.test.mjs — checker branch pins (Phase-5 coverage fill; the main spec
// file is red-proof-frozen, so these ride a colocated file): nested braces inside a template
// `${}`, the unreadable-corpus-file STOP, the unreadable-baseline STOP, and the new-file
// report lines of an in-process check.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAssertionExpressions, buildCorpus, runCli } from './suite-parity.mjs';

const point = (over = {}) =>
  JSON.stringify({
    file: '/repo/a.test.mjs', name: 'adds', nesting: 0, suite: false, skip: false, todo: false, fail: false, ms: 1, ...over,
  });
const run = (lines) => {
  const tail = ['# per-file wall totals (nesting-0 ms, descending)'];
  const counts = new Map();
  for (const line of lines) {
    const p = JSON.parse(line);
    counts.set(p.file, (counts.get(p.file) ?? 0) + 1);
  }
  for (const [file, n] of counts) tail.push(`# file-ms 1.0 points ${n} ${file}`);
  return `${lines.join('\n')}\n${tail.join('\n')}\n`;
};

describe('suite-parity checker branches', () => {
  it('nested braces inside a template ${} stay one balanced expression', () => {
    const exprs = extractAssertionExpressions('assert.equal(t, `x ${ ({ a: 1 }).a } y`);\nassert.ok(z);\n');
    assert.equal(exprs.length, 2);
    assert.match(exprs[0], /^assert\.equal\(t, `x \$\{ \(\{ a: 1 \}\)\.a \} y`\)$/);
  });

  it('an unreadable corpus file is a loud STOP naming it', () => {
    assert.throws(
      () => buildCorpus(run([point()]), { root: '/repo', readTestFile: () => { throw new Error('EACCES'); } }),
      /cannot read corpus file a\.test\.mjs/,
    );
  });

  it('an unreadable baseline is a loud STOP naming it (exit 1)', () => {
    const err = [];
    const code = runCli(['check', '--run', 'run.ndjson', '--baseline', 'missing.json'], {
      root: '/repo',
      log: () => {},
      logError: (s) => err.push(s),
      readFile: (path) => {
        if (path.endsWith('run.ndjson')) return run([point()]);
        if (path.endsWith('a.test.mjs')) return 'assert.ok(1);\n';
        throw new Error(`ENOENT ${path}`);
      },
    });
    assert.equal(code, 1);
    assert.match(err.join('\n'), /cannot read baseline missing\.json/);
  });

  it('an in-process check REPORTS each new file (counted separately)', () => {
    const files = {};
    const base = {};
    runCli(['snapshot', '--run', 'run.ndjson', '--out', 'base.json'], {
      root: '/repo',
      log: () => {},
      logError: () => {},
      readFile: (path) => {
        if (path.endsWith('run.ndjson')) return run([point()]);
        if (path.endsWith('a.test.mjs')) return 'assert.ok(1);\n';
        throw new Error(`ENOENT ${path}`);
      },
      writeFile: (path, text) => { base[path] = text; },
    });
    const out = [];
    const code = runCli(['check', '--run', 'run.ndjson', '--baseline', 'base.json'], {
      root: '/repo',
      log: (s) => out.push(s),
      logError: () => {},
      readFile: (path) => {
        if (path.endsWith('run.ndjson')) return run([point(), point({ file: '/repo/b.test.mjs', name: 'extra' })]);
        if (path.endsWith('a.test.mjs')) return 'assert.ok(1);\n';
        if (path.endsWith('b.test.mjs')) return 'assert.ok(2);\n';
        if (path.endsWith('base.json')) return files.base ?? base['/repo/base.json'];
        throw new Error(`ENOENT ${path}`);
      },
    });
    assert.equal(code, 0);
    assert.match(out.join('\n'), /new file \(counted separately\): b\.test\.mjs — 1 cases, 1 assert sites/);
  });
});

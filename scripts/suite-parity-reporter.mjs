// suite-parity-reporter.mjs — NDJSON test-point reporter for `node --test` (repo-only tooling,
// never shipped). One line per test point (suites included): the raw material suite-parity.mjs
// freezes into the D12 survivor-corpus baseline and re-derives at Phase-5 exit. Skip/todo ride
// as booleans so "zero new skip/todo" is checkable; failures ride through so a non-green run
// can never silently become a parity source. The stream ends with `#`-comment per-file wall
// totals (nesting-0 points only — module-level setup time is not attributed), descending, so
// one run also yields the speedup targeting table; suite-parity.mjs skips `#` lines.

export const formatEvent = (event) => {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') return null;
  const data = event.data;
  return JSON.stringify({
    file: data.file ?? null,
    name: data.name,
    nesting: data.nesting ?? 0,
    suite: data.details?.type === 'suite',
    skip: Boolean(data.skip),
    todo: Boolean(data.todo),
    fail: event.type === 'test:fail',
    ms: data.details?.duration_ms ?? null,
  });
};

export default async function* suiteParityReporter(source) {
  const perFile = new Map();
  for await (const event of source) {
    const line = formatEvent(event);
    if (line === null) continue;
    yield `${line}\n`;
    const data = event.data;
    const file = data.file ?? '(unattributed)';
    if (!perFile.has(file)) perFile.set(file, { ms: 0, points: 0 });
    const entry = perFile.get(file);
    entry.points += 1;
    if ((data.nesting ?? 0) === 0) entry.ms += data.details?.duration_ms ?? 0;
  }
  const rows = [...perFile.entries()].sort((a, b) => b[1].ms - a[1].ms);
  yield '# per-file wall totals (nesting-0 ms, descending)\n';
  for (const [file, { ms, points }] of rows) {
    yield `# file-ms ${ms.toFixed(1)} points ${points} ${file}\n`;
  }
}

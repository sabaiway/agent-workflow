import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_MAX_PROMPT_BYTES, trimToBudget } from './grounding.mjs';
import { GIT_MAX_BUFFER, hermeticGitEnv } from './git-env.mjs';
import {
  MIB, load, commit, makeRepo, row, record, putRecord, invoke, clean,
} from './feedback-record-cli-harness.test.mjs';

describe('feedback record check [spec:feedback-triage/S7]', () => {
  it('accepts a checked record and lists every defective row', async () => clean(async (repo) => {
    const accepted = await invoke(repo, ['--check', putRecord(repo)]);
    assert.equal(accepted.code, 0, accepted.errors.join('\n'));
    assert.equal(accepted.errors.some((line) => /: (?:row-cells|claim-id|anchor-|verdict|disposition):/u.test(line)), false);
    assert.equal((await invoke(repo, ['--check', putRecord(repo, record(repo.head.toUpperCase()), 'upper.md')])).code, 0);
    const bad = record(repo.head, { rows: [
      '| 1 | Too | many | `anchor.txt:1` | confirmed | queue ROW-A |',
      row({ id: 2, evidence: '`../outside:1`' }),
      row({ id: 3, verdict: 'maybe' }),
    ] });
    const refused = await invoke(repo, ['--check', putRecord(repo, bad, 'bad.md')]);
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.errors.map((line) => /: ([a-z-]+):/u.exec(line)?.[1]), ['row-cells', 'anchor-path', 'verdict']);
    assert.ok(refused.errors.every((line) => /bad\.md:\d+: [a-z-]+:/u.test(line)));
  }));

  it('stops on a fatal parse refusal with that one finding', async () => clean(async (repo) => {
    const malformed = record(repo.head).replace(`Head: ${repo.head}`, 'Head: not-an-object-id');
    const result = await invoke(repo, ['--check', putRecord(repo, malformed)]);
    assert.equal(result.code, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(/: ([a-z-]+):/u.exec(result.errors[0])?.[1], 'head');
    assert.deepEqual(result.calls, []);
  }));
});

describe('feedback git identity [spec:feedback-triage/S8]', () => {
  it('refuses a non-work-tree location and a mismatched head by name', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'feedback-record-plain-'));
    const plainRepo = { root: plain, env: hermeticGitEnv(process.env, join(plain, 'home')), head: 'a'.repeat(40) };
    try {
      writeFileSync(join(plain, 'anchor.txt'), 'one\n');
      const location = await invoke(plainRepo, ['--check', putRecord(plainRepo)]);
      assert.equal(location.code, 1);
      assert.match(location.errors.join('\n'), /git-location:/);
    } finally { rmSync(plain, { recursive: true, force: true }); }
    await clean(async (repo) => {
      const other = 'b'.repeat(repo.head.length);
      const mismatch = await invoke(repo, ['--check', putRecord(repo, record(other))]);
      assert.equal(mismatch.code, 1);
      assert.match(mismatch.errors.join('\n'), /head-mismatch:/);
      assert.ok(mismatch.errors.join('\n').includes(other) && mismatch.errors.join('\n').includes(repo.head));
    });
  });

  it('refuses redirected git environment and failed spawn outcomes', async () => clean(async (repo) => {
    const foreign = makeRepo();
    try {
      const redirected = await invoke({ ...repo, env: { ...repo.env, GIT_DIR: join(foreign.root, '.git') } }, ['--check', putRecord(repo)]);
      assert.equal(redirected.code, 1);
      assert.match(redirected.errors.join('\n'), /git-location:.*redirected|git-location:.*differs/u);
      for (const failingSpawn of [
        () => ({ error: { code: 'ENOENT' } }),
        () => { throw new Error('synchronous fixture failure'); },
      ]) {
        const failed = await invoke(repo, ['--check', putRecord(repo)], { spawn: failingSpawn });
        assert.equal(failed.code, 1);
        assert.match(failed.errors.join('\n'), /git-location:/);
        assert.match(failed.errors.join('\n'), /ENOENT|synchronous fixture failure/);
      }
    } finally { rmSync(foreign.root, { recursive: true, force: true }); }
  }));

  it('names a work-tree top that vanishes after the location probes', async () => clean(async (repo) => {
    const path = putRecord(repo);
    const spawn = (command, args, options) => {
      const result = spawnSync(command, args, options);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') rmSync(repo.root, { recursive: true, force: true });
      return result;
    };
    const result = await invoke(repo, ['--check', path], { spawn });
    const locations = result.errors.filter((line) => line.includes(': git-location:'));
    const headLine = record(repo.head).split('\n').findIndex((line) => line.startsWith('Head: ')) + 1;
    assert.equal(result.code, 1);
    assert.equal(locations.length, 1);
    assert.match(locations[0], new RegExp(`:${headLine}: git-location:.*ENOENT`, 'u'));
    assert.equal(result.errors.some((line) => line.includes(': anchor-dirty:')), false);
    assert.equal(result.calls.some(({ args }) => args[0] === 'status'), false);
  }));
});

describe('feedback queue rows mode [spec:feedback-triage/S10]', () => {
  it('renders rows and ratchet states while sharing all check refusals', async () => clean(async (repo) => {
    mkdirSync(join(repo.root, 'sub'));
    writeFileSync(join(repo.root, 'sub', 'anchor.txt'), 'one\ntwo\nthree\nfour\n');
    repo.head = commit(repo);
    const path = putRecord(repo);
    const missingFile = await invoke(repo, ['--rows', path]);
    assert.equal(missingFile.code, 0);
    assert.match(missingFile.logs.join('\n'), /gates\.json.*absent|absent.*gates\.json/u);
    writeFileSync(join(repo.root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [] }));
    const missingGate = await invoke(repo, ['--rows', path]);
    assert.equal(missingGate.code, 0);
    assert.match(missingGate.logs.join('\n'), /queue-audit.*absent|absent.*queue-audit/u);
    writeFileSync(join(repo.root, 'docs', 'ai', 'gates.json'), JSON.stringify({ gates: [{ id: 'queue', cmd: 'node queue-audit-cli.mjs --check q --max-rows 236' }] }));
    const rendered = await invoke(repo, ['--rows', path]);
    assert.equal(rendered.code, 0, rendered.errors.join('\n'));
    assert.match(rendered.logs.join('\n'), /ROW-A/);
    assert.match(rendered.logs.join('\n'), /236 \u2192 237/u);
    const nested = await invoke(repo, ['--rows', path], { cwd: join(repo.root, 'sub') });
    assert.equal(nested.code, 0, nested.errors.join('\n'));
    assert.match(nested.logs.join('\n'), /236 \u2192 237/u);
    const defective = putRecord(repo, record(repo.head, { rows: [row({ verdict: 'maybe' })] }), 'defective.md');
    const [checked, rows] = await Promise.all([invoke(repo, ['--check', defective]), invoke(repo, ['--rows', defective])]);
    assert.deepEqual([rows.code, rows.errors], [checked.code, checked.errors]);
  }));
});

describe('feedback CLI usage and process surface [spec:feedback-triage/S11]', () => {
  it('returns usage for malformed modes and non-regular records', async () => clean(async (repo) => {
    const path = putRecord(repo);
    const out = join(repo.root, 'scratch', 'facts.md');
    mkdirSync(dirname(out), { recursive: true });
    for (const argv of [[], ['--check'], ['--nope'], ['--check', path, '--rows', path], ['--excerpts', out]]) {
      assert.equal((await invoke(repo, argv)).code, 2, argv.join(' '));
    }
    symlinkSync(path, join(repo.root, 'record-link.md'));
    mkdirSync(join(repo.root, 'record-directory'));
    writeFileSync(join(repo.root, 'record-large.md'), Buffer.alloc(MIB + 1, 0x61));
    writeFileSync(join(repo.root, 'record-latin.md'), Buffer.from([0x23, 0x20, 0xe9, 0x0a]));
    for (const name of ['record-link.md', 'record-directory', 'missing.md', 'record-large.md', 'record-latin.md']) {
      assert.equal((await invoke(repo, ['--check', join(repo.root, name)])).code, 2, name);
    }
  }));

  it('routes only the declared git probes through the spawn seam', async () => clean(async (repo) => {
    const path = putRecord(repo);
    const checked = await invoke(repo, ['--check', path]);
    assert.deepEqual([...new Set(checked.calls.map(({ args }) => args[0]))].sort(), ['ls-files', 'rev-parse', 'status']);
    assert.equal(checked.calls.filter(({ args }) => args[0] === 'rev-parse' && args[1] === 'HEAD').length, 1);
    assert.equal(checked.calls.filter(({ args }) => args[0] === 'status').length, 1);
    assert.deepEqual(checked.calls.find(({ args }) => args[0] === 'status').args, ['status', '--porcelain', '-z', '--untracked-files=all', '--ignored=traditional', '--', ':(literal)anchor.txt']);
    const listed = checked.calls.filter(({ args }) => args[0] === 'ls-files');
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].args, ['ls-files', '-v', '-z', '--', ':(literal)anchor.txt']);
    assert.equal(listed[0].options.cwd, repo.root);
    for (const call of checked.calls) assert.equal(call.command, 'git');
    for (const call of checked.calls.filter(({ args }) => args[1] === 'HEAD' || ['status', 'ls-files'].includes(args[0]))) {
      assert.equal(call.options.env.LC_ALL, 'C');
      assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, '0');
      assert.equal(call.options.maxBuffer, GIT_MAX_BUFFER);
    }
    const noAnchors = await invoke(repo, ['--check', putRecord(repo, record(repo.head, { rows: [row({ evidence: '`src/a b.mjs:1`' })] }), 'empty.md')]);
    assert.equal(noAnchors.code, 1);
    assert.deepEqual([...new Set(noAnchors.calls.map(({ args }) => args[0]))], ['rev-parse']);
    const out = join(repo.root, 'scratch', 'facts.md');
    mkdirSync(dirname(out), { recursive: true });
    const excerpted = await invoke(repo, ['--check', path, '--excerpts', out]);
    assert.equal(excerpted.code, 0, excerpted.errors.join('\n'));
    assert.deepEqual([...new Set(excerpted.calls.map(({ args }) => args[0]))].sort(), ['ls-files', 'rev-parse', 'status']);
    assert.ok(excerpted.calls.every(({ command }) => command === 'git'));
    assert.equal(excerpted.calls.filter(({ args }) => args[0] === 'rev-parse' && args[1] === 'HEAD').length, 1);
  }));
});

describe('feedback excerpts mode [spec:feedback-triage/S15]', () => {
  it('writes verbatim ranges and refuses every overwrite destination', async () => clean(async (repo) => {
    const outDir = mkdtempSync(join(tmpdir(), 'feedback-excerpts-'));
    try {
      const path = putRecord(repo);
      const fresh = join(outDir, 'fresh.md');
      const written = await invoke(repo, ['--check', path, '--excerpts', fresh]);
      assert.equal(written.code, 0, written.errors.join('\n'));
      assert.equal(readFileSync(fresh, 'utf8'), 'anchor.txt:1: one\nanchor.txt:2: two\nanchor.txt:3: three');
      const existing = join(outDir, 'existing.md');
      writeFileSync(existing, 'keep');
      const collision = await invoke(repo, ['--check', path, '--excerpts', existing]);
      assert.equal(collision.code, 1);
      assert.match(collision.errors.join('\n'), /EEXIST/);
      assert.equal(readFileSync(existing, 'utf8'), 'keep');
      mkdirSync(join(repo.root, 'scratch'), { recursive: true });
      const ignoredExisting = join(repo.root, 'scratch', 'existing.md');
      writeFileSync(ignoredExisting, 'keep');
      const linkedDestination = join(repo.root, 'scratch', 'linked.md');
      symlinkSync('../anchor.txt', linkedDestination);
      const notIgnored = join(repo.root, 'not-ignored.md');
      for (const destination of [ignoredExisting, linkedDestination, notIgnored, join(repo.root, 'anchor.txt')]) {
        const refused = await invoke(repo, ['--check', path, '--excerpts', destination]);
        assert.equal(refused.code, 2);
        assert.match(refused.errors.join('\n'), /excerpts-destination:.*--excerpts/u);
        assert.doesNotMatch(refused.errors.join('\n'), /--out/u);
      }
      assert.equal(readdirSync(repo.root).includes('not-ignored.md'), false);
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  }));

  it('keeps check and rows read-only', async () => clean(async (repo) => {
    const outDir = mkdtempSync(join(tmpdir(), 'feedback-read-only-'));
    try {
      const path = putRecord(repo);
      const before = readdirSync(outDir);
      assert.equal((await invoke(repo, ['--check', path])).code, 0);
      assert.equal((await invoke(repo, ['--rows', path])).code, 0);
      assert.deepEqual(readdirSync(outDir), before);
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  }));

  it('refuses an exhausted budget and loudly trims a larger payload', async () => clean(async (repo) => {
    const outDir = mkdtempSync(join(tmpdir(), 'feedback-budget-'));
    try {
      const { EXCERPTS_FRAMING_RESERVE_BYTES } = await load();
      const exhaustedText = record(repo.head, { notes: 'x'.repeat(DEFAULT_MAX_PROMPT_BYTES - EXCERPTS_FRAMING_RESERVE_BYTES) });
      const exhaustedOut = join(outDir, 'exhausted.md');
      const exhausted = await invoke(repo, ['--check', putRecord(repo, exhaustedText, 'exhausted-record.md'), '--excerpts', exhaustedOut]);
      assert.equal(exhausted.code, 1);
      assert.match(exhausted.errors.join('\n'), /excerpts-budget/);
      assert.equal(readdirSync(outDir).includes('exhausted.md'), false);
      writeFileSync(join(repo.root, 'anchor.txt'), Array.from({ length: 30 }, (_, index) => `${index}-${'a'.repeat(100)}`).join('\n') + '\n');
      const accented = '\u00e9-anchor.txt';
      writeFileSync(join(repo.root, accented), `${'x'.repeat(500)}\n`);
      const head = commit(repo);
      const probe = trimToBudget('a'.repeat(1000), 500).text;
      const marker = probe.slice(probe.indexOf('\n'));
      const markerBytes = Buffer.byteLength(marker);
      const recordForBudget = (remaining) => {
        const base = record(head, { rows: [row({ evidence: '`anchor.txt:1-30`' })], notes: 'x' });
        const target = DEFAULT_MAX_PROMPT_BYTES - EXCERPTS_FRAMING_RESERVE_BYTES - remaining;
        const padded = record(head, { rows: [row({ evidence: '`anchor.txt:1-30`' })], notes: 'x'.repeat(1 + target - Buffer.byteLength(base)) });
        assert.equal(Buffer.byteLength(padded), target);
        return padded;
      };
      for (const remaining of [1, 50, markerBytes - 1, markerBytes]) {
        const out = join(outDir, `boundary-${remaining}.md`);
        const bounded = await invoke(repo, ['--check', putRecord(repo, recordForBudget(remaining), `boundary-record-${remaining}.md`), '--excerpts', out]);
        assert.equal(bounded.code, 1, `remaining budget ${remaining}`);
        assert.match(bounded.errors.join('\n'), /excerpts-budget/);
        assert.equal(readdirSync(outDir).includes(`boundary-${remaining}.md`), false);
      }
      const markerOut = join(outDir, 'marker.md');
      const markerResult = await invoke(repo, ['--check', putRecord(repo, recordForBudget(markerBytes + 40), 'marker-record.md'), '--excerpts', markerOut]);
      assert.equal(markerResult.code, 0, markerResult.errors.join('\n'));
      assert.ok(readFileSync(markerOut, 'utf8').endsWith(marker));
      const accentedBase = record(head, { rows: [row({ evidence: `\`${accented}:1\`` })], notes: 'x' });
      const accentedTarget = DEFAULT_MAX_PROMPT_BYTES - EXCERPTS_FRAMING_RESERVE_BYTES - markerBytes - 1;
      const accentedRecord = record(head, { rows: [row({ evidence: `\`${accented}:1\`` })], notes: 'x'.repeat(1 + accentedTarget - Buffer.byteLength(accentedBase)) });
      const accentedOut = join(outDir, 'accented.md');
      const accentedResult = await invoke(repo, ['--check', putRecord(repo, accentedRecord, 'accented-record.md'), '--excerpts', accentedOut]);
      assert.equal(accentedResult.code, 1);
      assert.match(accentedResult.errors.join('\n'), /excerpts-budget/u);
      assert.equal(readdirSync(outDir).includes('accented.md'), false);
      const base = record(head, { rows: [row({ evidence: '`anchor.txt:1-30`' })], notes: 'x' });
      const target = DEFAULT_MAX_PROMPT_BYTES - EXCERPTS_FRAMING_RESERVE_BYTES - 300;
      const padded = record(head, { rows: [row({ evidence: '`anchor.txt:1-30`' })], notes: 'x'.repeat(Math.max(1, target - Buffer.byteLength(base) + 1)) });
      const trimmedOut = join(outDir, 'trimmed.md');
      const trimmed = await invoke(repo, ['--check', putRecord(repo, padded, 'trimmed-record.md'), '--excerpts', trimmedOut]);
      assert.equal(trimmed.code, 0, trimmed.errors.join('\n'));
      const payload = readFileSync(trimmedOut, 'utf8');
      assert.match(payload, /\[grounding\] TRIMMED/);
      assert.ok(Buffer.byteLength(payload) <= DEFAULT_MAX_PROMPT_BYTES - EXCERPTS_FRAMING_RESERVE_BYTES - Buffer.byteLength(padded));
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  }));
});

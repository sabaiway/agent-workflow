// smoke-candidate.test.mjs — the pre-publish candidate smoke, pinned at its PURE halves and driven
// through an INJECTED exec. The live run packs and installs a tarball; that is a release-lane step,
// never a suite-time dependency on npm or the network (the smoke-init.test.mjs pattern).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import {
  REQUIRED_VARIANT,
  FORBIDDEN_LINE,
  SMOKE_RECEIPT_SCHEMA,
  SMOKE_RECEIPT_BASENAME,
  parseArgs,
  candidateDeclaration,
  evaluateAdvisorRun,
  buildReceipt,
  readSmokeReceipt,
  smokeReceiptPath,
  candidateSmokeViolation,
  soleTarballIn,
  runCli,
} from './smoke-candidate.mjs';
import { matchesCoverageProducer } from '../../agent-workflow-kit/tools/coverage-producer.mjs';
import { RECOMMENDATIONS_EMPTY_LINE } from '../../agent-workflow-kit/tools/recommendations.mjs';

describe('smoke-candidate — argument parsing', () => {
  it('--tarball takes a path, --keep is a flag, an unknown argument is usage (exit 2)', () => {
    assert.deepEqual(parseArgs(['--tarball', '/tmp/k.tgz', '--keep']), { tarball: '/tmp/k.tgz', keep: true, help: false });
    assert.throws(() => parseArgs(['--tarball']), (err) => err.exitCode === 2);
    assert.throws(() => parseArgs(['--nope']), (err) => err.exitCode === 2);
  });
});

describe('smoke-candidate — the fixture declaration is the LIVE pair the narrow outcome needs', () => {
  const gates = candidateDeclaration('/opt/kit/tools');

  it('the producer is one the closed world RECOGNIZES, and it precedes the checker', () => {
    assert.equal(matchesCoverageProducer(gates[0].cmd), true, 'a body the advisor cannot recognize would reach the DEAD-pair arm instead');
    assert.equal(gates[gates.length - 1].id, 'coverage-check');
  });

  it('the checker names the INSTALLED copy — the advisor anchors canonicity on its own sibling', () => {
    assert.equal(gates[1].cmd, 'node "/opt/kit/tools/coverage-check.mjs" --check');
  });
});

describe('smoke-candidate — the advisor verdict is read off the VARIANT, never off prose', () => {
  const payloadWith = (...variants) => JSON.stringify({ root: '/x', items: variants.map((variant) => ({ key: 'k', variant })), skips: [] });

  it('the required variant present and the flow-optimal line absent is the only pass', () => {
    const verdict = evaluateAdvisorRun({ jsonText: payloadWith('gates-declaration', REQUIRED_VARIANT), plainText: 'Recommendations\n1 attention' });
    assert.deepEqual(verdict.violations, []);
    assert.equal(verdict.ok, true);
  });

  it('the required variant missing is a NAMED violation carrying what did fire', () => {
    const verdict = evaluateAdvisorRun({ jsonText: payloadWith('gates-inert'), plainText: '' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations[0], new RegExp(REQUIRED_VARIANT));
    assert.match(verdict.violations[0], /variants: gates-inert/);
  });

  it('the flow-optimal line is a violation on its own — the exact line the advisor renders', () => {
    assert.equal(FORBIDDEN_LINE, RECOMMENDATIONS_EMPTY_LINE, 'the smoke and the renderer share ONE constant');
    const verdict = evaluateAdvisorRun({ jsonText: payloadWith(REQUIRED_VARIANT), plainText: `Recommendations\n\n${FORBIDDEN_LINE}\n` });
    assert.equal(verdict.ok, false);
    assert.match(verdict.violations[0], /attested/);
  });

  it('unparsable or item-less JSON is a violation, never a thrown parse error', () => {
    const broken = evaluateAdvisorRun({ jsonText: 'not json', plainText: '' });
    assert.equal(broken.ok, false);
    assert.match(broken.violations[0], /did not parse/);
    const itemless = evaluateAdvisorRun({ jsonText: '{"root":"/x"}', plainText: '' });
    assert.equal(itemless.ok, false);
    assert.match(itemless.violations[0], /no items array/);
  });
});

describe('smoke-candidate — the receipt and the refusal it feeds', () => {
  const PASSING = { kitVersion: '5.7.0', headSha: 'abc123', dirty: false, packedFrom: 'repo', at: '2026-08-13T00:00:00.000Z' };

  it('a pass receipt round-trips through the git dir, and an unreadable one reads as ABSENT', () => {
    const receipt = buildReceipt(PASSING);
    const files = { [smokeReceiptPath('/g')]: JSON.stringify(receipt) };
    const read = (path) => {
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[path];
    };
    assert.deepEqual(readSmokeReceipt('/g', read), receipt);
    assert.equal(readSmokeReceipt('/absent', read), null);
    assert.equal(readSmokeReceipt('/g', () => '{ not json'), null, 'a receipt nobody can parse is not evidence of anything');
    assert.equal(readSmokeReceipt('/g', () => '[]'), null, 'nor is a non-object one');
    assert.ok(smokeReceiptPath('/g').endsWith(SMOKE_RECEIPT_BASENAME));
  });

  it('a receipt covering the exact candidate is the ONE state that dispatches', () => {
    assert.equal(candidateSmokeViolation({ receipt: buildReceipt(PASSING), kitVersion: '5.7.0', headSha: 'abc123' }), null);
  });

  it('every way a passing receipt can be about OTHER bytes refuses, and says which way', () => {
    const receipt = buildReceipt(PASSING);
    const cases = [
      [{ receipt: null }, /no candidate smoke receipt/],
      [{ receipt: { ...receipt, schema: SMOKE_RECEIPT_SCHEMA + 1 } }, /schema/],
      [{ receipt: { ...receipt, outcome: 'fail' } }, /not a pass/],
      [{ receipt, kitVersion: '5.8.0' }, /passed for kit 5\.7\.0/],
      [{ receipt, headSha: 'deadbee' }, /passed at abc123/],
    ];
    for (const [override, expected] of cases) {
      const violation = candidateSmokeViolation({ receipt, kitVersion: '5.7.0', headSha: 'abc123', ...override });
      assert.match(violation ?? '', expected);
      assert.match(violation ?? '', /smoke-candidate\.mjs/, 'and every refusal carries the command that clears it');
    }
  });

  it('a DIRTY or hand-supplied smoke clears NO dispatch, dry-run included', () => {
    // Neither earns a dry-run exception. A dirty smoke packs bytes no commit names and nothing keeps
    // stable, so a receipt recording HEAD would read as covering a commit it never saw — and in the
    // worst case (a dirty tree AT the dispatched sha) no mismatch note would warn about it either.
    for (const [override, expected] of [[{ dirty: true }, /DIRTY tree/], [{ packedFrom: 'supplied' }, /hand-supplied/]]) {
      const receipt = buildReceipt({ ...PASSING, ...override });
      assert.match(candidateSmokeViolation({ receipt, kitVersion: '5.7.0', headSha: 'abc123' }) ?? '', expected);
    }
  });
});

describe('smoke-candidate — soleTarballIn', () => {
  it('one tarball in a dir this run created empty is the candidate; anything else is a loud refusal', () => {
    assert.equal(soleTarballIn('/pack', () => ['kit-5.7.0.tgz']), join('/pack', 'kit-5.7.0.tgz'));
    assert.throws(() => soleTarballIn('/pack', () => []), /expected exactly 1/);
    assert.throws(() => soleTarballIn('/pack', () => ['a.tgz', 'b.tgz']), /expected exactly 1/);
  });
});

// ── the CLI against a fully stubbed pack / install / advisor run ───────────────────────

const GIT_DIR = '/repo/.git';
const HEAD = 'cafe1234';

const runStubbed = ({ argv = [], advisorJson, advisorPlain = 'Recommendations\n1 attention', statusAfter = null, failStep = null, statusRereadFails = false, receiptWriteFails = false, teardown = () => {} } = {}) => {
  const writes = {};
  const removed = [];
  const calls = [];
  // ONE journal for every side effect, in the order they really happened. Two separate lists can
  // only prove each side's internal order — moving the receipt removal one step later would leave
  // an assertion over `calls` alone perfectly green.
  const events = [];
  const status = ['', statusAfter];
  let statusReads = 0;
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    events.push(`exec ${[cmd, ...args].join(' ')}`);
    if (failStep !== null && [cmd, ...args].join(' ').includes(failStep)) return { status: 1, stdout: '', stderr: 'stub failure' };
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return { status: 0, stdout: `${GIT_DIR}\n` };
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n` };
    if (cmd === 'git' && args[0] === 'status') {
      if (statusRereadFails && statusReads > 0) return { status: 1, stdout: '', stderr: 'injected: cannot read the index' };
      const value = status[Math.min(statusReads, 1)] ?? status[0];
      statusReads += 1;
      return { status: 0, stdout: `${value}\n` };
    }
    if (cmd === 'npm') return { status: 0, stdout: '' };
    if (cmd === 'node' && args.includes('--json')) return { status: 0, stdout: advisorJson };
    if (cmd === 'node') return { status: 0, stdout: advisorPlain };
    return { status: 0, stdout: '' };
  };
  const out = [];
  const code = runCli(argv, {
    log: (line) => out.push(String(line)),
    logError: (line) => out.push(String(line)),
    exec,
    buildFixture: () => ({ root: '/fixture', teardown, census: { assessable: 0, unsupported: 3 } }),
    readFile: () => JSON.stringify({ version: '5.7.0' }),
    writeFile: (path, body) => {
      if (receiptWriteFails && path.endsWith(SMOKE_RECEIPT_BASENAME)) throw new Error('injected: EROFS');
      writes[path] = body;
    },
    readDir: () => ['agent-workflow-kit-5.7.0.tgz'],
    removeFile: (path) => {
      removed.push(path);
      events.push(`remove ${path}`);
      delete writes[path];
    },
    baseEnv: { PATH: '/usr/bin', HOME: '/home/real', AGENT_WORKFLOW_KIT_CHANNEL: 'dev' },
    root: '/repo',
    now: () => '2026-08-13T00:00:00.000Z',
  });
  return { code, writes, removed, calls, events, text: out.join('\n') };
};

const PASSING_JSON = JSON.stringify({ root: '/fixture', items: [{ key: 'gates-inert', variant: REQUIRED_VARIANT }], skips: [] });

describe('smoke-candidate — runCli against a stubbed pack + install + advisor', () => {
  it('packs, installs the CANDIDATE into the fixture, runs the packed advisor and writes the receipt', () => {
    const { code, writes, calls, text } = runStubbed({ advisorJson: PASSING_JSON });
    assert.equal(code, 0, text);
    assert.ok(calls.some((c) => c.startsWith('npm pack --pack-destination')), 'the pack lands in a temp dir, never the package dir');
    assert.ok(calls.some((c) => c.includes('npm install') && c.endsWith('.tgz')), 'the tarball installed is the packed candidate');
    assert.ok(calls.some((c) => c.includes('recommendations.mjs') && c.includes('--json')));
    const receipt = JSON.parse(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)]);
    assert.deepEqual(receipt, {
      schema: SMOKE_RECEIPT_SCHEMA,
      outcome: 'pass',
      kitVersion: '5.7.0',
      headSha: HEAD,
      dirty: false,
      packedFrom: 'repo',
      variant: REQUIRED_VARIANT,
      at: '2026-08-13T00:00:00.000Z',
    });
    assert.equal(candidateSmokeViolation({ receipt, kitVersion: '5.7.0', headSha: HEAD }), null, 'and the dispatcher accepts it');
  });

  it('the declaration written into the fixture points at the INSTALLED tools, not this repo', () => {
    const { writes } = runStubbed({ advisorJson: PASSING_JSON });
    const declared = JSON.parse(writes[join('/fixture', 'docs', 'ai', 'gates.json')]).gates;
    assert.match(declared[1].cmd, /\/fixture\/node_modules\/@sabaiway\/agent-workflow-kit\/tools\/coverage-check\.mjs/);
  });

  it('a candidate that stays silent over the foreign tree FAILS and writes NO receipt', () => {
    const { code, writes, text } = runStubbed({ advisorJson: JSON.stringify({ items: [], skips: [] }), advisorPlain: `x\n${FORBIDDEN_LINE}\n` });
    assert.equal(code, 1);
    assert.equal(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], undefined, 'a stale pass must never survive a red run');
    assert.match(text, new RegExp(REQUIRED_VARIANT));
    assert.match(text, /attested/);
    assert.match(text, /FAIL/);
  });

  it('a smoke that DIRTIES the repo working tree cannot report a pass, and leaves NO receipt', () => {
    const { code, writes, text } = runStubbed({ advisorJson: PASSING_JSON, statusAfter: '?? agent-workflow-kit/kit-5.7.0.tgz' });
    assert.equal(code, 1, 'the next preflight it feeds is a clean-tree refusal — a dirtying smoke is its own defect');
    assert.match(text, /CHANGED the repo working tree/);
    assert.equal(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], undefined, 'the receipt is a licence to publish — a red run never issues one');
  });

  it('a cleanup that THROWS is reported and never skips the tree assertion', () => {
    // The one path where a stray artifact could both survive and go unreported: the cleanup blew up
    // BEFORE the comparison, so an unguarded cleanup would have swallowed both facts at once.
    const { code, writes, text } = runStubbed({
      advisorJson: PASSING_JSON,
      statusAfter: '?? stray.tgz',
      teardown: () => {
        throw new Error('injected: EBUSY');
      },
    });
    assert.equal(code, 1);
    assert.match(text, /cleanup failed for 1 dir\(s\)/);
    assert.match(text, /\/fixture \(injected: EBUSY\)/, 'the survivor is named by PATH — "the dirs above" is not an instruction anyone can follow');
    assert.match(text, /CHANGED the repo working tree/, 'the assertion still ran');
    assert.equal(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], undefined);
  });

  it('one dir that will not go never strands the others', () => {
    const { code, text } = runStubbed({
      advisorJson: PASSING_JSON,
      teardown: () => {
        throw new Error('injected: EBUSY');
      },
    });
    assert.equal(code, 1, 'a cleanup this run could not finish is its own red');
    assert.match(text, /cleanup failed for 1 dir\(s\)/, 'exactly one survivor — the temp sandboxes were still removed');
  });

  it('--tarball skips the pack and records that the bytes were supplied by hand', () => {
    const { code, writes, calls } = runStubbed({ argv: ['--tarball', '/tmp/hand.tgz'], advisorJson: PASSING_JSON });
    assert.equal(code, 0);
    assert.ok(!calls.some((c) => c.startsWith('npm pack')), 'nothing is packed when the tarball is given');
    assert.ok(calls.some((c) => c.includes('npm install') && c.includes('/tmp/hand.tgz')));
    assert.equal(JSON.parse(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)]).packedFrom, 'supplied');
  });

  it('a failed step is a loud exit 1 with the step NAMED, and no receipt', () => {
    const { code, writes, text } = runStubbed({ advisorJson: PASSING_JSON, failStep: 'npm install' });
    assert.equal(code, 1);
    assert.match(text, /npm install \(candidate tarball\) failed/);
    assert.equal(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], undefined);
  });

  it('--help prints the usage and runs nothing at all', () => {
    const { code, calls, text } = runStubbed({ argv: ['--help'], advisorJson: PASSING_JSON });
    assert.equal(code, 0);
    assert.match(text, /usage: smoke-candidate\.mjs/);
    assert.deepEqual(calls, [], 'a usage request packs nothing and reads no git state');
  });

  it('--keep names EVERY retained dir, the fixture included, instead of removing them', () => {
    const { code, text } = runStubbed({ argv: ['--keep'], advisorJson: PASSING_JSON });
    assert.equal(code, 0);
    const retained = /--keep: dirs retained \(([^)]+)\)/.exec(text);
    assert.ok(retained, `the retained dirs are named for triage: ${text}`);
    const named = retained[1].split(', ');
    assert.ok(named.includes('/fixture'), 'the fixture is retained too — a triager told only about the sandboxes would look in the wrong place');
    for (const dir of named.filter((d) => d !== '/fixture')) {
      assert.equal(existsSync(dir), true, `${dir} is still on disk`);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tree that cannot be PROVEN unchanged is a failure, not a note — and issues no receipt', () => {
    // The receipt is a claim about a tree. A tree nobody can re-read is not one this run may vouch
    // for, so the unprovable case fails closed exactly like the proven-changed one.
    const { code, writes, text } = runStubbed({ advisorJson: PASSING_JSON, statusRereadFails: true });
    assert.equal(code, 1);
    assert.match(text, /could not re-read the repo status/);
    assert.match(text, /could not be proven unchanged/);
    assert.equal(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], undefined);
  });

  it('a RED re-run invalidates the previous PASS receipt — a stale licence never survives it', () => {
    // The dispatcher compares only version + HEAD, so over the same commit a leftover PASS would go
    // on clearing the very dispatch this re-run was made to question. Invalidation happens BEFORE
    // the first step that can fail, so it holds however the run dies.
    const { code, removed, writes, events } = runStubbed({
      advisorJson: JSON.stringify({ items: [], skips: [] }),
      advisorPlain: `x\n${FORBIDDEN_LINE}\n`,
    });
    assert.equal(code, 1);
    assert.deepEqual(removed, [join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], 'the previous receipt is invalidated, exactly once');
    assert.equal(writes[join(GIT_DIR, SMOKE_RECEIPT_BASENAME)], undefined);
    // The ORDER over one journal, not two: the invalidation must sit between the git-dir read that
    // makes the path knowable and the very next step that can fail. Asserting only that the git-dir
    // read came first would stay green if the removal slid past HEAD, the pack, or the install.
    assert.deepEqual(
      events.slice(0, 3),
      ['exec git rev-parse --absolute-git-dir', `remove ${join(GIT_DIR, SMOKE_RECEIPT_BASENAME)}`, 'exec git rev-parse HEAD'],
    );
  });

  it('a receipt that cannot be WRITTEN is a red run, not a silent pass', () => {
    // The PASS line is printed from the receipt, so a write that failed must never be followed by it:
    // the dispatcher would then be told a licence exists that nothing on disk backs.
    const { code, text } = runStubbed({ advisorJson: PASSING_JSON, receiptWriteFails: true });
    assert.equal(code, 1);
    assert.match(text, /the receipt could not be written \(injected: EROFS\)/);
    assert.doesNotMatch(text, /PASS —/, 'no pass line over a receipt that does not exist');
  });

  it('the child env is the sanitized one — the host HOME and family overrides never reach it', () => {
    const seen = [];
    runCli([], {
      log: () => {},
      logError: () => {},
      exec: (cmd, args, options) => {
        seen.push(options?.env ?? null);
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--absolute-git-dir') return { status: 0, stdout: GIT_DIR };
        if (cmd === 'git') return { status: 0, stdout: cmd === 'git' && args[0] === 'status' ? '' : HEAD };
        if (cmd === 'node' && args.includes('--json')) return { status: 0, stdout: PASSING_JSON };
        return { status: 0, stdout: 'ok' };
      },
      buildFixture: () => ({ root: '/fixture', teardown: () => {}, census: { assessable: 0, unsupported: 3 } }),
      readFile: () => JSON.stringify({ version: '5.7.0' }),
      writeFile: () => {},
      readDir: () => ['kit.tgz'],
      baseEnv: { PATH: '/usr/bin', HOME: '/home/real', AGENT_WORKFLOW_KIT_CHANNEL: 'dev', npm_config_cache: '/home/real/.npm' },
      root: '/repo',
      now: () => 'now',
    });
    const childEnv = seen.find((env) => env != null);
    assert.ok(childEnv, 'the pack/install/advisor children all carry an env');
    assert.equal(childEnv.AGENT_WORKFLOW_KIT_CHANNEL, undefined, 'family overrides are stripped');
    assert.notEqual(childEnv.HOME, '/home/real', 'HOME points into the sandbox');
    assert.notEqual(childEnv.npm_config_cache, '/home/real/.npm');
  });
});

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hermeticGitEnv } from '../git-env.mjs';
import { KNOWN_FOOTPRINT } from '../known-footprint.mjs';
import { main as dispatchMain } from '../dispatch.mjs';
import { DELEGATION_STORE_BASENAME, readDelegationStore } from '../dispatch-store.mjs';
import { contractDigest } from '../dispatch-record.mjs';
import { EXEC_RECEIPT_SCHEMA_VERSION, EXEC_RECEIPT_KIND, execReceiptBasename, execReportBasename } from '../exec-receipt.mjs';

const ABSENT = 'absent ../checkpoint.mjs';
const loaded = await import('../checkpoint.mjs').catch(() => ({}));
const main = loaded.main ?? (() => { throw new Error(ABSENT); });
const TMP = mkdtempSync(join(tmpdir(), 'aw-checkpoint-mint-test-'));
const ENV = hermeticGitEnv(process.env, TMP);
const ACCEPT = 0;
const REFUSE = 1;
const USAGE = 2;
const PREFIX = 'refs/agent-workflow/checkpoints/';
const EXPORTS = ['main', 'mintCheckpoint', 'newestCheckpoint', 'verifyCheckpoint', 'pruneCheckpoints'];
const ALPHA = 'story-alpha';
const BETA = 'story-beta';
const BASE = 'base.txt';
const SNAPSHOT_ONLY = 'snapshot-only.txt';
const CHILD = `${SNAPSHOT_ONLY}/child.txt`;
const INITIAL = 'base\n';
const CHANGED = 'changed\n';
const STAGED = 'staged\n';
const PLAN_TITLE = '# Synthetic plan\n';
const EXCLUDE = '.git/info/exclude';
const HIDDEN = '/docs/ai/\n/AGENTS.md\n';
const INCLUDED = ['untracked.txt', 'docs/ai/x.md', 'AGENTS.md'];
const EXCLUDED = ['docs/plans/x.md', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json',
  'node_modules/x.js', 'src/node_modules/x.js', ...KNOWN_FOOTPRINT.map(({ pattern }) =>
    pattern.slice(1).replace('*', 'fixture.md') + (pattern.endsWith('/') ? 'x.md' : ''))];
const UNSAFE = 'bad..name';
const INVALID_PLANS = ['docs/other/x.md', 'docs/plans/nested/x.md', 'docs/plans/EXECUTE-x.md',
  'docs/plans/TASK-x-T1.md', 'docs/plans/FEEDBACK-x.md', 'docs/plans/x-PROMPT.md',
  'docs/plans/x-prompt.md', 'docs/plans/x-handoff.md', 'docs/plans/queue.md', `docs/plans/${UNSAFE}.md`];
const UNKNOWN_OID = 'f'.repeat(40);
const TAG = 'snapshot-tag';
const WAVE = 'wave-a';
const NONCE = 'thread-a';
const CAP_S = 600;
const GRACE_S = 15;
const LAST_NUMBER = 10;
const ELSEWHERE_REF = 'refs/agent-workflow/elsewhere'; const PRUNE_NUMBERS = [0, 1, 2]; const SECOND_DELETE = 2;
const REPORT = Buffer.from('the requested file was written\n');
const RECEIPT_DETAILS = { owner: 'owner-token-1', wrapperVersion: '3.4.1', sessionId: 'session-a',
  posture: { model: 'gpt-5-codex', effort: 'high', tier: 'priority' } };
const CONTRACT = { schema: 1, nonce: NONCE, stepClass: 'code', vehicle: { requested: 'codex-exec', selected: 'codex-exec' },
  scope: 'write the requested file', inputs: 'the current tree', acceptance: 'the file matches the brief',
  returnShape: 'a diff and report', producerContract: 'record the returned artifacts', deadlineS: 900, retry: { cap: 2, index: 0 } };
const REGISTER = ['register', '--wave', WAVE, '--step-classes', 'code', '--pairing-key', 'stepClass',
  '--min-per-class', '1', '--mean-l-threshold', '1', '--first-pass-num', '0', '--first-pass-den', '1'];
const USAGE_CELLS = [[], ['unknown'], ['mint'], ['mint', '--plan'], ['newest', '--plan'],
  ['prune', '--plan'], ['verify'], ['verify', UNKNOWN_OID, 'extra'], ['mint', '--plan', `docs/plans/${ALPHA}.md`, 'extra']];
after(() => rmSync(TMP, { recursive: true, force: true }));
const runGit = (args, cwd, input, env = ENV) => spawnSync('git', args, { cwd, input, env });
const readGit = (ws, args) => {
  const result = runGit(args, ws.cwd, undefined, ws.env);
  assert.equal(result.status, ACCEPT, `git ${args.join(' ')}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const sh = (ws, args) => readGit(ws, args).toString('utf8').trimEnd();
const put = (ws, path, bytes = INITIAL) => {
  mkdirSync(dirname(join(ws.cwd, path)), { recursive: true });
  writeFileSync(join(ws.cwd, path), bytes);
};
const getPlan = (stem = ALPHA) => `docs/plans/${stem}.md`;
const makeRepo = () => {
  const cwd = mkdtempSync(join(TMP, 'repo-'));
  const store = join(cwd, '.git', DELEGATION_STORE_BASENAME);
  const ws = { cwd, store, env: { ...ENV, AW_DELEGATION_STORE: store, AW_CORE_EVIDENCE: join(cwd, '.git', 'evidence.jsonl') } };
  sh(ws, ['init', '-q', '-b', 'main']);
  sh(ws, ['config', 'user.email', 'coder-tools@proton.me']);
  sh(ws, ['config', 'user.name', 'coder-tool']);
  put(ws, BASE);
  sh(ws, ['add', '-A']);
  sh(ws, ['commit', '-q', '-m', 'initial tree']);
  put(ws, getPlan(), PLAN_TITLE);
  return ws;
};
const run = (ws, argv, io = {}) => {
  const result = main(argv, { cwd: ws.cwd, env: ws.env, ...io });
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  return result;
};
const assertAccepted = (result) => { assert.equal(result.code, ACCEPT, result.stderr); return result; };
const readState = (ws) => ({ refs: readGit(ws, ['for-each-ref', PREFIX]),
  index: readGit(ws, ['ls-files', '-s']), status: readGit(ws, ['status', '--porcelain']) });
const assertRefused = (ws, argv, reason, io = {}) => {
  const before = readState(ws);
  const result = run(ws, argv, io);
  assert.equal(result.code, REFUSE, result.stderr);
  if (reason) assert.match(result.stderr, reason);
  assert.deepEqual(readState(ws), before);
  return result;
};
const matchName = (name) => new RegExp('\\b' + name + '\\b');
const readCheckpoint = (ws, verb = 'mint', stem = ALPHA, n = 0, io = {}) => {
  const result = assertAccepted(run(ws, [verb, '--plan', getPlan(stem)], io));
  const oid = sh(ws, ['rev-parse', `${PREFIX}${stem}/${n}`]);
  assert.equal(result.stdout, `checkpoint ${stem}/${n} ${oid}\n`);
  assert.equal(sh(ws, ['cat-file', '-t', oid]), 'tree');
  return { oid, line: result.stdout };
};
const readPaths = (ws, oid) => sh(ws, ['ls-tree', '-r', '--name-only', oid]).split('\n').filter(Boolean);
const readRefs = (ws, stem) => sh(ws, ['for-each-ref', '--format=%(refname)', `${PREFIX}${stem}/`]).split('\n').filter(Boolean);
const spyIO = (fail = () => false) => {
  const calls = [];
  return { calls, runGit: (args, cwd, input, env) => {
    calls.push({ args, index: env?.GIT_INDEX_FILE });
    if (fail(args)) throw new Error('injected git failure');
    return runGit(args, cwd, input, env);
  } };
};
const assertRemoved = (calls) => {
  const indexes = [...new Set(calls.map(({ index }) => index).filter(Boolean))];
  assert.ok(indexes.length > 0);
  for (const index of indexes) {
    assert.equal(existsSync(dirname(index)), false, index);
    assert.equal(dirname(dirname(index)), tmpdir());
  }
};
const openThread = (ws, oid) => {
  assertAccepted(dispatchMain(REGISTER, ws));
  const path = join(mkdtempSync(join(TMP, 'contract-')), 'dispatch.md');
  writeFileSync(path, `\`\`\`aw-dispatch-contract\n${JSON.stringify(CONTRACT)}\n\`\`\`\n`);
  assertAccepted(dispatchMain(['open', '--contract', path, '--wave', WAVE, '--backend', 'codex',
    '--rationale', 'a bounded change', '--wrapper-cap-s', String(CAP_S), '--kill-grace-s', String(GRACE_S), '--checkpoint', oid], ws));
};
const degradeThread = (ws) => assertAccepted(dispatchMain(['degrade', '--wave', WAVE, '--nonce', NONCE,
  '--step-class', 'code', '--rationale', 'withdraw this thread'], ws));
const returnSuccess = (ws) => {
  const ledger = readDelegationStore(ws.store);
  assert.equal(ledger.malformed, ACCEPT);
  const dispatch = ledger.records.find((record) => record.kind === 'dispatch' && record.nonce === NONCE);
  const { backend } = dispatch;
  put(ws, join('.git', execReportBasename(backend, NONCE)), REPORT);
  put(ws, join('.git', execReceiptBasename(backend, NONCE)), JSON.stringify({
    schema: EXEC_RECEIPT_SCHEMA_VERSION, kind: EXEC_RECEIPT_KIND, state: 'terminal', backend,
    ...RECEIPT_DETAILS, nonce: NONCE, contractDigest: contractDigest(CONTRACT),
    capS: CAP_S, killGraceS: GRACE_S, exitStatus: ACCEPT, outcome: 'success',
    reportDigest: createHash('sha256').update(REPORT).digest('hex'), reportLength: REPORT.length, timestamp: new Date().toISOString(),
  }));
  assertAccepted(dispatchMain(['return', '--nonce', NONCE], ws));
};
const assertVerdict = (result, word, target, recomputed) => {
  assert.match(result.stdout, new RegExp(`\\b${word}\\b`));
  for (const oid of [target, recomputed]) assert.match(result.stdout, new RegExp(`\\b${oid}\\b`));
  assert.match(result.stdout, /^[^\n]+\n$/);
};

describe('mint scope — spec:checkpoint/S1', () => {
  it('forces hidden deliverables into the scope tree and excludes plans, settings and every footprint category', () => {
    const ws = makeRepo();
    put(ws, EXCLUDE, HIDDEN + `${BASE}\n`);
    for (const path of [...INCLUDED, ...EXCLUDED]) put(ws, path);
    const { oid } = readCheckpoint(ws);
    assert.deepEqual(readPaths(ws, oid), [BASE, ...INCLUDED].sort());
    for (const path of [BASE, ...INCLUDED]) assert.equal(sh(ws, ['show', `${oid}:${path}`]), INITIAL.trimEnd());
  });
  it('preserves staged bytes, work tree and other refs while using and removing temporary indexes', () => {
    const ws = makeRepo();
    put(ws, BASE, STAGED);
    sh(ws, ['add', '--', BASE]);
    put(ws, BASE, CHANGED);
    const before = readState(ws);
    const refs = readGit(ws, ['show-ref']);
    const io = spyIO();
    const { oid } = readCheckpoint(ws, 'mint', ALPHA, 0, io);
    assert.equal(sh(ws, ['show', `${oid}:${BASE}`]), CHANGED.trimEnd());
    assert.deepEqual(readGit(ws, ['ls-files', '-s']), before.index);
    assert.deepEqual(readGit(ws, ['status', '--porcelain']), before.status);
    assert.equal(readFileSync(join(ws.cwd, BASE), 'utf8'), CHANGED);
    assert.equal(readFileSync(join(ws.cwd, getPlan()), 'utf8'), PLAN_TITLE);
    assert.equal(sh(ws, ['show', `:${BASE}`]), STAGED.trimEnd());
    assert.deepEqual(readGit(ws, ['show-ref']).toString().split('\n').filter((line) => !line.includes(PREFIX)).join('\n'), refs.toString());
    for (const verb of ['ls-files', 'add', 'write-tree']) {
      const calls = io.calls.filter(({ args }) => args[0] === verb);
      assert.ok(calls.length > 0, verb);
      assert.ok(calls.every(({ index }) => index), verb);
    }
    assert.ok(io.calls.filter(({ args }) => args[0] === 'add').every(({ args }) => args.includes('-f')));
    assert.equal(io.calls.filter(({ args }) => args[0] === 'write-tree').length, 1);
    assert.ok(io.calls.some(({ args }) => args[0] === 'update-ref' && args.includes(`${PREFIX}${ALPHA}/0`) && args.includes(oid)));
    assertRemoved(io.calls);
  });
  it('keeps an ignored path held only by the newest checkpoint in the next snapshot', () => {
    const ws = makeRepo();
    put(ws, SNAPSHOT_ONLY);
    readCheckpoint(ws);
    put(ws, EXCLUDE, `${SNAPSHOT_ONLY}\n`);
    put(ws, SNAPSHOT_ONLY, CHANGED);
    const { oid } = readCheckpoint(ws, 'mint', ALPHA, 1);
    assert.equal(sh(ws, ['show', `${oid}:${SNAPSHOT_ONLY}`]), CHANGED.trimEnd());
  });
  it('drops an absent leaf from the newest checkpoint tree', () => {
    const ws = makeRepo();
    put(ws, SNAPSHOT_ONLY);
    readCheckpoint(ws);
    rmSync(join(ws.cwd, SNAPSHOT_ONLY));
    const { oid } = readCheckpoint(ws, 'mint', ALPHA, 1);
    assert.deepEqual(readPaths(ws, oid), [BASE]);
  });
  it('drops a former file leaf and includes its directory descendants', () => {
    const ws = makeRepo();
    put(ws, SNAPSHOT_ONLY);
    readCheckpoint(ws);
    rmSync(join(ws.cwd, SNAPSHOT_ONLY));
    put(ws, CHILD, CHANGED);
    const { oid } = readCheckpoint(ws, 'mint', ALPHA, 1);
    assert.deepEqual(readPaths(ws, oid), [BASE, CHILD].sort());
    assert.equal(sh(ws, ['show', `${oid}:${CHILD}`]), CHANGED.trimEnd());
  });
  it('refuses a present FIFO at a base-tree path by path without writes', () => {
    const ws = makeRepo();
    rmSync(join(ws.cwd, BASE));
    assert.equal(spawnSync('mkfifo', [join(ws.cwd, BASE)], { env: ws.env }).status, ACCEPT);
    assert.ok(lstatSync(join(ws.cwd, BASE)).isFIFO());
    const io = spyIO();
    assertRefused(ws, ['mint', '--plan', getPlan()], /base\.txt/, io);
    assertRemoved(io.calls);
  });
  it('refuses a thrown git runner and removes its temporary index without writes', () => {
    const ws = makeRepo();
    const io = spyIO((args) => args[0] === 'write-tree');
    assertRefused(ws, ['mint', '--plan', getPlan()], undefined, io);
    assert.ok(io.calls.some(({ args }) => args[0] === 'write-tree'));
    assertRemoved(io.calls);
  });
  it('refuses an unreadable scope path without writes', () => {
    const ws = makeRepo();
    assertRefused(ws, ['mint', '--plan', getPlan()], undefined, { lstat: (path) => {
      if (path === join(ws.cwd, BASE)) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return lstatSync(path);
    } });
  });
});

describe('plan sequences — spec:checkpoint/S2', () => {
  it('keeps a symbolic ref under the namespace from redirecting a mint or a prune outside it', () => { const ws = makeRepo(); const ref = `${PREFIX}${ALPHA}/0`; const before = readGit(ws, ['show-ref']); sh(ws, ['symbolic-ref', ref, ELSEWHERE_REF]); const { oid } = readCheckpoint(ws); for (const args of [['rev-parse', '--verify', ELSEWHERE_REF], ['symbolic-ref', ref]]) assert.ok(runGit(args, ws.cwd, undefined, ws.env).status > ACCEPT, args.join(' ')); assert.equal(sh(ws, ['rev-parse', ref]), oid);
    assertAccepted(run(ws, ['prune', '--plan', getPlan()])); assert.deepEqual(readRefs(ws, ALPHA), []); assert.ok(runGit(['rev-parse', '--verify', ref], ws.cwd, undefined, ws.env).status > ACCEPT); assert.deepEqual(Buffer.from(readGit(ws, ['show-ref']).toString('utf8').split('\n').filter((line) => !line.includes(PREFIX)).join('\n')), before); });
  it('leaves a contiguous sequence when a prune is interrupted, so the next prune completes', () => { const ws = makeRepo(); for (const n of PRUNE_NUMBERS) { put(ws, BASE, `${CHANGED}${n}\n`); readCheckpoint(ws, 'mint', ALPHA, n); } const deletions = []; const before = readState(ws); const io = spyIO((args) => { if (args[0] !== 'update-ref' || !args.includes('-d')) return false; deletions.push(args); return deletions.length === SECOND_DELETE; }); const result = run(ws, ['prune', '--plan', getPlan()], io); assert.equal(result.code, REFUSE, result.stderr); assert.equal(deletions.length, SECOND_DELETE);
    assert.deepEqual(readRefs(ws, ALPHA), PRUNE_NUMBERS.slice(0, -1).map((n) => `${PREFIX}${ALPHA}/${n}`)); assert.deepEqual(readState(ws).index, before.index); assert.deepEqual(readState(ws).status, before.status); assertAccepted(run(ws, ['prune', '--plan', getPlan()])); assert.deepEqual(readRefs(ws, ALPHA), []); });
  it('exports the five functions and checkpoint ref prefix', () => {
    const ws = makeRepo();
    assert.equal(run(ws, []).code, USAGE);
    for (const name of EXPORTS) assert.equal(typeof loaded[name], 'function', name);
    assert.equal(loaded.CHECKPOINT_REF_PREFIX, PREFIX);
  });
  it('starts at zero, advances contiguously, suppresses equal trees and reads the greatest number', () => {
    const ws = makeRepo();
    const first = readCheckpoint(ws);
    assert.deepEqual(readRefs(ws, ALPHA), [`${PREFIX}${ALPHA}/0`]);
    put(ws, BASE, CHANGED);
    const second = readCheckpoint(ws, 'mint', ALPHA, 1);
    assert.notEqual(second.oid, first.oid);
    const before = readState(ws);
    assert.deepEqual(readCheckpoint(ws, 'mint', ALPHA, 1), second);
    assert.deepEqual(readState(ws), before);
    assert.deepEqual(readCheckpoint(ws, 'newest', ALPHA, 1), second);
    assert.deepEqual(readState(ws), before);
    assert.deepEqual(readRefs(ws, ALPHA), [`${PREFIX}${ALPHA}/0`, `${PREFIX}${ALPHA}/1`]);
    for (const n of Array.from({ length: LAST_NUMBER - 1 }, (_, index) => index + 2)) {
      put(ws, BASE, `${CHANGED}${n}\n`);
      readCheckpoint(ws, 'mint', ALPHA, n);
    }
    assert.equal(readRefs(ws, ALPHA).length, LAST_NUMBER + 1);
    readCheckpoint(ws, 'newest', ALPHA, LAST_NUMBER);
  });
  it('refuses newest over an empty sequence without writes', () => {
    const ws = makeRepo();
    assertRefused(ws, ['newest', '--plan', getPlan()], matchName('no-checkpoint'));
  });
  it('keeps two sequences separate and prunes only the selected plan', () => {
    const ws = makeRepo();
    put(ws, getPlan(BETA), PLAN_TITLE);
    readCheckpoint(ws);
    put(ws, BASE, CHANGED);
    readCheckpoint(ws, 'mint', ALPHA, 1);
    const beta = readCheckpoint(ws, 'mint', BETA);
    assertAccepted(run(ws, ['prune', '--plan', getPlan()]));
    assert.deepEqual(readRefs(ws, ALPHA), []);
    assert.deepEqual(readCheckpoint(ws, 'newest', BETA), beta);
    assert.deepEqual(readRefs(ws, BETA), [`${PREFIX}${BETA}/0`]);
  });
  it('prunes an empty sequence as a clean no-op', () => {
    const ws = makeRepo();
    const before = readState(ws);
    assertAccepted(run(ws, ['prune', '--plan', getPlan()]));
    assert.deepEqual(readState(ws), before);
  });
  it('refuses prune under an open thread on an older tree and proceeds after degrade', () => {
    const ws = makeRepo();
    const first = readCheckpoint(ws);
    put(ws, BASE, CHANGED);
    readCheckpoint(ws, 'mint', ALPHA, 1);
    openThread(ws, first.oid);
    assertRefused(ws, ['prune', '--plan', getPlan()], matchName('open-thread'));
    degradeThread(ws);
    assertAccepted(run(ws, ['prune', '--plan', getPlan()]));
    assert.deepEqual(readRefs(ws, ALPHA), []);
  });
  it('keeps an unfolded success return open for prune', () => {
    const ws = makeRepo();
    const { oid } = readCheckpoint(ws);
    openThread(ws, oid);
    returnSuccess(ws);
    assertRefused(ws, ['prune', '--plan', getPlan()], matchName('open-thread'));
  });
  for (const shared of [false, true]) it(`judges another sequence's open thread by ${shared ? 'shared' : 'disjoint'} tree oid`, () => {
    const ws = makeRepo();
    put(ws, getPlan(BETA), PLAN_TITLE);
    const alpha = readCheckpoint(ws);
    if (!shared) put(ws, BASE, CHANGED);
    const beta = readCheckpoint(ws, 'mint', BETA);
    assert.equal(alpha.oid === beta.oid, shared);
    openThread(ws, beta.oid);
    if (shared) assertRefused(ws, ['prune', '--plan', getPlan()], matchName('open-thread'));
    else {
      assertAccepted(run(ws, ['prune', '--plan', getPlan()]));
      assert.deepEqual(readRefs(ws, ALPHA), []);
    }
    assert.deepEqual(readCheckpoint(ws, 'newest', BETA), beta);
  });
  it('refuses prune over a malformed ledger without deleting refs', () => {
    const ws = makeRepo();
    const { oid } = readCheckpoint(ws);
    openThread(ws, oid);
    degradeThread(ws);
    appendFileSync(ws.store, '{malformed\n');
    assertRefused(ws, ['prune', '--plan', getPlan()]);
  });
  for (const path of INVALID_PLANS) it(`refuses stem operand ${path} without writes`, () => {
    const ws = makeRepo();
    put(ws, path, PLAN_TITLE);
    if (path === getPlan(UNSAFE)) assert.equal(runGit(['check-ref-format', `${PREFIX}${UNSAFE}/0`], ws.cwd).status, REFUSE);
    assertRefused(ws, ['mint', '--plan', path], matchName('stem'));
  });
  for (const kind of ['absent', 'directory', 'unreadable']) it(`refuses a ${kind} plan without writes`, () => {
    const ws = makeRepo();
    if (kind !== 'unreadable') rmSync(join(ws.cwd, getPlan()));
    if (kind === 'directory') mkdirSync(join(ws.cwd, getPlan()));
    const io = kind !== 'unreadable' ? {} : { lstat: (path) => {
      if (path === join(ws.cwd, getPlan())) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return lstatSync(path);
    } };
    assertRefused(ws, ['mint', '--plan', getPlan()], matchName('stem'), io);
  });
  for (const argv of USAGE_CELLS) it(`returns usage without writes for ${JSON.stringify(argv)}`, () => {
    const ws = makeRepo();
    const before = readState(ws);
    assert.equal(run(ws, argv).code, USAGE);
    assert.deepEqual(readState(ws), before);
  });
});

describe('verify tree proof — spec:checkpoint/S3', () => {
  it('reports CLEAN immediately after mint with the target and recomputed oid', () => {
    const ws = makeRepo();
    const { oid } = readCheckpoint(ws);
    const before = readState(ws);
    assertVerdict(assertAccepted(run(ws, ['verify', oid])), 'CLEAN', oid, oid);
    assert.deepEqual(readState(ws), before);
  });
  it('uses the target tree to retain an ignored snapshot-only path during verify', () => {
    const ws = makeRepo();
    put(ws, SNAPSHOT_ONLY);
    const { oid } = readCheckpoint(ws);
    put(ws, EXCLUDE, `${SNAPSHOT_ONLY}\n`);
    const before = readState(ws);
    assertVerdict(assertAccepted(run(ws, ['verify', oid])), 'CLEAN', oid, oid);
    assert.deepEqual(readState(ws), before);
  });
  for (const deletion of [false, true]) it(`reports DIRTY with both oids after ${deletion ? 'deleting a snapshot-only path' : 'changing scope bytes'}`, () => {
    const ws = makeRepo();
    if (deletion) put(ws, SNAPSHOT_ONLY);
    const { oid } = readCheckpoint(ws);
    if (deletion) rmSync(join(ws.cwd, SNAPSHOT_ONLY));
    else put(ws, BASE, CHANGED);
    const result = assertRefused(ws, ['verify', oid]);
    const recomputed = readCheckpoint(ws, 'mint', ALPHA, 1).oid;
    assert.notEqual(recomputed, oid);
    if (deletion) assert.equal(recomputed, sh(ws, ['rev-parse', 'HEAD^{tree}']));
    assertVerdict(result, 'DIRTY', oid, recomputed);
  });
  for (const type of ['commit', 'blob', 'tag', 'unresolvable']) it(`refuses a ${type} id through the tree proof without writes`, () => {
    const ws = makeRepo();
    if (type === 'tag') sh(ws, ['tag', '-a', TAG, '-m', 'annotated tag']);
    const oid = type === 'unresolvable' ? UNKNOWN_OID : sh(ws, ['rev-parse', type === 'commit' ? 'HEAD' : type === 'blob' ? `HEAD:${BASE}` : TAG]);
    assertRefused(ws, ['verify', oid], type === 'unresolvable' ? /unresolvable/ : new RegExp(`names a ${type}, not a tree`));
  });
});

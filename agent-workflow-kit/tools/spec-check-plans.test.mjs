import assert from 'node:assert/strict';
import { chmodSync, cpSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { PLANS_REL } from './plan-files.mjs';
import { DEFAULT_ROW, ledgerOf, makeTree, planWith, write } from './plan-shape-harness.test.mjs';
import { FLAT_STORE, ROOT, STORE, op, repoOf, rulesOf, specDoc } from './spec-check-harness.test.mjs';

const { checkSpecs } = await import('./spec-check.mjs').catch(() => ({}));

const LOGIN = 'login';
const LOGIN_SPEC = `${STORE}${LOGIN}.md`;
const BILLING_SPEC = `${STORE}billing/index.md`;
const SOURCE = 'src';
const GROUNDED_MODULE = `${SOURCE}/billing/`;
const PENDING_MODULE = `${SOURCE}/pending/`;
const PENDING_MAIN = `${PENDING_MODULE}main.mjs`;
const PENDING_FILES = [`${PENDING_MODULE}a.mjs`, `${PENDING_MODULE}b.mjs`];
const LIVE = 'status: live';
const DRAFT = 'status: draft';
const FILE = 'file';
const CREATE = 'create';
const MODIFY = 'modify';
const MODULE_RULE = 'module';
const ACCEPT = 0;
const REFUSE = 1;
const USAGE = 2;
const NO_CALLS = 0;
const ONE_CALL = 1;
const ROOT_UID = 0;
const UNREADABLE_MODE = 0;
const ACCEPT_LINE = /^spec-check: ACCEPT/;
const ACCESS_DENIED = /\bEACCES\b/;
const READER_ERROR = 'the plans reader failed';
const OTHER_PLAN = `${PLANS_REL}/other.md`;
const JUDGED_PLAN = `${PLANS_REL}/judged.md`;
const OPS_LIST = 'ops.list';
const TREE_PREFIX = 'spec-check-plans';
const STORE_FIXTURE = new URL('../test/fixtures/spec-check/store-ok/', import.meta.url);
const UTF8 = 'utf8';
const CLI_OP = '--op';
const CLI_OPS_FILE = '--ops-file';
const CLI_ALL = '--all';
const CLI_PLAN = '--plan';
const CLI_ROOT = '--root';
const STORE_LANES = [CLI_OP, CLI_OPS_FILE, CLI_ALL];
const UNREADABLE_PATHS = [PLANS_REL, OTHER_PLAN];

const ACCEPTED_PLANS = [{
  identity: JUDGED_PLAN,
  accepted: true,
  rows: [LOGIN_SPEC, ...PENDING_FILES].map((path) => ({ verb: CREATE, path })),
}];
const LOGIN_OPS = [op(MODIFY, LOGIN_SPEC)];

const buildLoginStore = (paths, status = LIVE) => ({
  ...FLAT_STORE,
  [LOGIN_SPEC]: specDoc(LOGIN, { module: paths.map((path) => `- ${path}`).join('\n') }).replace(LIVE, status),
});
const run = (files, plans, options) => checkSpecs({ root: ROOT, ops: LOGIN_OPS, plans }, repoOf(files, options));

const makeReader = ({ plans, error }) => {
  const calls = [];
  const read = () => {
    calls.push(true);
    if (error) throw error;
    return plans;
  };
  return { calls, read };
};

const expectModuleVerdict = (result, exit, paths) => {
  assert.deepEqual(rulesOf(result, MODULE_RULE), paths);
  assert.equal(result.exit, exit, result.lines.join('\n'));
};

const trees = [];
after(() => trees.forEach((root) => rmSync(root, { recursive: true, force: true })));

const makePlanTree = (pending) => {
  const root = makeTree(TREE_PREFIX);
  trees.push(root);
  cpSync(STORE_FIXTURE, root, { recursive: true });
  const plan = planWith({ ledger: ledgerOf(DEFAULT_ROW) });
  write(root, OTHER_PLAN, plan);
  write(root, JUDGED_PLAN, plan);
  if (pending) {
    const billing = readFileSync(join(root, BILLING_SPEC), UTF8);
    write(root, BILLING_SPEC, billing.replace(GROUNDED_MODULE, PENDING_MODULE));
  }
  const operation = `${MODIFY}=${pending ? BILLING_SPEC : LOGIN_SPEC}`;
  write(root, OPS_LIST, `${operation}\n`);
  const lanes = {
    [CLI_OP]: [CLI_OP, operation],
    [CLI_OPS_FILE]: [CLI_OPS_FILE, join(root, OPS_LIST)],
    [CLI_ALL]: [CLI_ALL],
    [CLI_PLAN]: [CLI_PLAN, JUDGED_PLAN],
  };
  return { root, lanes };
};

const withoutRead = (t, path, check) => {
  if (process.getuid?.() === ROOT_UID) {
    t.diagnostic(`root can read ${path} with mode ${UNREADABLE_MODE}`);
    t.skip();
    return;
  }
  const mode = statSync(path).mode;
  chmodSync(path, UNREADABLE_MODE);
  t.after(() => chmodSync(path, mode));
  check();
};

const runWithUnreadable = async (t, lane, path, pending, expectResult) => {
  const { main } = await import('./spec-check-cli.mjs');
  const { root, lanes } = makePlanTree(pending);
  withoutRead(t, join(root, path), () => expectResult(main([CLI_ROOT, root, ...lanes[lane]])));
};

describe('spec:spec-check/S13 reads the plans in flight only on demand', () => {
  const draft = buildLoginStore(PENDING_FILES, DRAFT);

  it('refuses an absent live Module without calling the plans reader', () => {
    const { calls, read } = makeReader({ error: new Error(READER_ERROR) });
    const result = run(buildLoginStore([PENDING_MAIN]), read);
    assert.equal(calls.length, NO_CALLS);
    expectModuleVerdict(result, REFUSE, [LOGIN_SPEC]);
  });

  it('refuses an absent draft Module under a file without calling the plans reader', () => {
    const { calls, read } = makeReader({ error: new Error(READER_ERROR) });
    const result = run(buildLoginStore([PENDING_MAIN], DRAFT), read, { states: { [SOURCE]: FILE } });
    assert.equal(calls.length, NO_CALLS);
    expectModuleVerdict(result, REFUSE, [LOGIN_SPEC]);
  });

  it('calls the plans reader once to cover two absent draft Modules', () => {
    const { calls, read } = makeReader({ plans: ACCEPTED_PLANS });
    const result = run(draft, read);
    assert.equal(calls.length, ONE_CALL);
    expectModuleVerdict(result, ACCEPT, []);
  });

  it('accepts two absent draft Modules covered by a supplied list of plans', () => {
    expectModuleVerdict(run(draft, ACCEPTED_PLANS), ACCEPT, []);
  });

  it('propagates the reader error object only when the run demands plans', () => {
    const error = new Error(READER_ERROR);
    const { calls, read } = makeReader({ error });
    assert.equal(run(FLAT_STORE, read).exit, ACCEPT);
    assert.equal(calls.length, NO_CALLS);
    assert.throws(() => run(draft, read), (thrown) => thrown === error);
    assert.equal(calls.length, ONE_CALL);
  });

  for (const path of UNREADABLE_PATHS) {
    for (const lane of STORE_LANES) {
      it(`${lane} accepts a grounded store with ${path} unreadable`, (t) =>
        runWithUnreadable(t, lane, path, false, (result) => {
          assert.equal(result.code, ACCEPT, result.stderr || result.stdout);
          assert.match(result.stdout, ACCEPT_LINE);
        }));
    }

    for (const lane of [...STORE_LANES, CLI_PLAN]) {
      it(`${lane} reports EACCES for ${path} when plans are needed`, (t) =>
        runWithUnreadable(t, lane, path, true, (result) => {
          assert.equal(result.code, USAGE, result.stderr || result.stdout);
          assert.ok(result.stderr.split(/\s+/).some((word) => word === path || word.endsWith(`/${path}`)), result.stderr);
          assert.match(result.stderr, ACCESS_DENIED);
        }));
    }
  }
});

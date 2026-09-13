// spec:checkpoint — docs/ai/specs/kit/checkpoint/index.md
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveTreeObject } from './dispatch-baseline.mjs';
import { readDelegationLedger } from './dispatch-store-read.mjs';
import { PLANS_REL, isScratchPlanName } from './plan-files.mjs';
import { isDirectRun } from './direct-run.mjs';
import { CHECKPOINT_REF_PREFIX, refuse, withRepository, readGit, readCheckpointRefs, writeSnapshot,
  findOpenCheckpointThread } from './checkpoint-core.mjs';
import { restoreCheckpoint } from './checkpoint-restore.mjs';

export { CHECKPOINT_REF_PREFIX } from './checkpoint-core.mjs';
const ACCEPT = 0;
const REFUSE = 1;
const USAGE = 2;
const FIRST_NUMBER = 0;
const INCREMENT = 1;
const LAST = -1;
const EMPTY = '';
const NEWLINE = '\n';
const SLASH = '/';
const STRING = 'string';
const MARKDOWN = '.md';
const NUMBER_PATTERN = /^(0|[1-9][0-9]*)$/;
const VERBS = { mint: 'mint', newest: 'newest', verify: 'verify', prune: 'prune', restore: 'restore' };
const NAMES = { stem: 'stem', sequence: 'sequence', ledger: 'ledger', open: 'open-thread', empty: 'no-checkpoint' };
const CHECKPOINT_KIND = 'checkpoint';
const LEDGER_ABSENT = 'absent';
const LEDGER_OK = 'ok';
const CLEAN = 'CLEAN';
const DIRTY = 'DIRTY';
const PROOF = 'proof';
const PLAN_FLAG = '--plan';
const PLAN_ARG_COUNT = 3;
const OID_ARG_COUNT = 2;
const ARGV_OFFSET = 2;
const USAGE_TEXT = 'usage: checkpoint mint|newest|prune --plan <plan> | verify|restore <oid>';
const PLAN_ERROR = 'expected a readable regular plan directly under docs/plans';
const SEQUENCE_ERROR = 'expected contiguous numbered refs on trees';
const GIT_ARGS = {
  checkRef: ['check-ref-format'],
  resolve: ['rev-parse', '--verify'],
  update: ['update-ref', '--no-deref'],
  remove: ['update-ref', '--no-deref', '-d'],
};

const readPlan = (context, planPath) => {
  try {
    if (typeof planPath !== STRING || isAbsolute(planPath)) return refuse(`${NAMES.stem}: ${PLAN_ERROR}`);
    const path = resolve(context.cwd, planPath);
    const parent = relative(context.top, dirname(path)).split(sep).join(SLASH);
    const name = basename(path);
    if (parent !== PLANS_REL || !name.endsWith(MARKDOWN) || isScratchPlanName(name)
      || !(context.io.lstat ?? lstatSync)(path).isFile()) return refuse(`${NAMES.stem}: ${PLAN_ERROR}`);
    readFileSync(path);
    const stem = name.slice(FIRST_NUMBER, -MARKDOWN.length);
    readGit(context, [...GIT_ARGS.checkRef, `${CHECKPOINT_REF_PREFIX}${stem}/${FIRST_NUMBER}`]);
    return { ok: true, stem };
  } catch (error) {
    return refuse(`${NAMES.stem}: ${error.message}`);
  }
};
const readSequence = (context, stem) => {
  const prefix = `${CHECKPOINT_REF_PREFIX}${stem}${SLASH}`;
  const refs = readCheckpointRefs(context, prefix).map(({ ref, oid }) => {
    const suffix = ref.slice(prefix.length);
    if (!NUMBER_PATTERN.test(suffix)) {
      throw new Error(`${NAMES.sequence}: ${SEQUENCE_ERROR}`);
    }
    return { ref, oid, n: Number(suffix), stem };
  }).sort((left, right) => left.n - right.n);
  for (const [index, checkpoint] of refs.entries()) {
    if (!Number.isSafeInteger(checkpoint.n) || checkpoint.n !== index) throw new Error(`${NAMES.sequence}: ${SEQUENCE_ERROR}`);
    const tree = resolveTreeObject(context.top, checkpoint.oid, context.io);
    if (!tree.ok) throw new Error(tree.reason);
  }
  return refs;
};
const withSequence = (cwd, planPath, io, action) => withRepository(cwd, io, (context) => {
  const plan = readPlan(context, planPath);
  if (!plan.ok) return plan;
  return action(context, plan.stem, readSequence(context, plan.stem));
});

export const mintCheckpoint = (cwd, planPath, io = {}) => withSequence(cwd, planPath, io, (context, stem, refs) => {
  const newest = refs.at(LAST);
  const snapshot = writeSnapshot(context, newest?.oid ?? null);
  if (!snapshot.ok) return snapshot;
  if (snapshot.oid === newest?.oid) return { ok: true, ...newest };
  const n = newest === undefined ? FIRST_NUMBER : newest.n + INCREMENT;
  const ref = `${CHECKPOINT_REF_PREFIX}${stem}/${n}`;
  readGit(context, [...GIT_ARGS.update, ref, snapshot.oid]);
  return { ok: true, stem, n, ref, oid: snapshot.oid };
});

export const newestCheckpoint = (cwd, planPath, io = {}) => withSequence(cwd, planPath, io, (context, stem, refs) => {
  const newest = refs.at(LAST);
  return newest === undefined ? refuse(`${NAMES.empty}: ${stem}`) : { ok: true, ...newest };
});

export const verifyCheckpoint = (cwd, oid, io = {}) => withRepository(cwd, io, (context) => {
  const tree = resolveTreeObject(context.top, oid, context.io);
  if (!tree.ok) return refuse(tree.reason);
  const target = readGit(context, [...GIT_ARGS.resolve, oid]);
  const snapshot = writeSnapshot(context, target);
  if (!snapshot.ok) return snapshot;
  return { ok: true, clean: target === snapshot.oid, target, oid: snapshot.oid };
});

export const pruneCheckpoints = (cwd, planPath, io = {}) => withSequence(cwd, planPath, io, (context, stem, refs) => {
  const ledger = readDelegationLedger(context.cwd, context.env);
  if (ledger.state !== LEDGER_ABSENT && ledger.state !== LEDGER_OK) return refuse(`${NAMES.ledger}: ${ledger.reason}`);
  const records = ledger.records ?? [];
  const held = new Set(refs.map(({ oid }) => oid));
  const open = findOpenCheckpointThread(records, held);
  if (open !== undefined) return refuse(`${NAMES.open}: ${open.nonce}`);
  for (const { ref } of [...refs].reverse()) readGit(context, [...GIT_ARGS.remove, ref]);
  return { ok: true };
});

const PLAN_OPERATIONS = { [VERBS.mint]: mintCheckpoint, [VERBS.newest]: newestCheckpoint, [VERBS.prune]: pruneCheckpoints };
const formatRef = ({ stem, n, oid }) => `${CHECKPOINT_KIND} ${stem}/${n} ${oid}${NEWLINE}`;
const formatRefusal = ({ code, reason }) => ({ code, stdout: EMPTY, stderr: `${reason}${NEWLINE}` });
export const main = (argv = process.argv.slice(ARGV_OFFSET), deps = {}) => {
  const [verb, operand, planPath] = argv;
  const planVerb = Object.hasOwn(PLAN_OPERATIONS, verb);
  const oidVerb = verb === VERBS.verify || verb === VERBS.restore;
  if (!(planVerb && argv.length === PLAN_ARG_COUNT && operand === PLAN_FLAG && planPath)
    && !(oidVerb && argv.length === OID_ARG_COUNT && operand)) return formatRefusal(refuse(USAGE_TEXT, USAGE));
  const cwd = deps.cwd ?? process.cwd();
  const operation = verb === VERBS.restore ? restoreCheckpoint : verifyCheckpoint;
  const result = planVerb ? PLAN_OPERATIONS[verb](cwd, planPath, deps) : operation(cwd, operand, deps);
  if (!result.ok) return formatRefusal(result);
  if (verb === VERBS.restore) return { code: ACCEPT,
    stdout: `${CHECKPOINT_KIND} ${VERBS.restore} ${result.target} ${PROOF} ${result.proof}${NEWLINE}`, stderr: EMPTY };
  if (verb === VERBS.verify) return { code: result.clean ? ACCEPT : REFUSE,
    stdout: `${result.clean ? CLEAN : DIRTY} ${result.target} ${result.oid}${NEWLINE}`, stderr: EMPTY };
  return { code: ACCEPT, stdout: verb === VERBS.prune ? EMPTY : formatRef(result), stderr: EMPTY };
};

if (isDirectRun(import.meta.url)) {
  const result = main();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

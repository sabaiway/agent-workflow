// spec-adoption.test.mjs — the four adoption states, the decline ack and the status line body
// (docs/ai/specs/kit/spec-adoption.md), plus the spec-check census seam it composes.
// Dynamic imports: the suite LOADS without the modules under test.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLAT_STORE, ROOT, ROOT_DOC, STORE, abs, groundOf, indexDoc, marker, repoOf, specDoc } from './spec-check-harness.test.mjs';

const adoption = await import('./spec-adoption.mjs').catch(() => ({}));
const { ADOPTION, STORE_DIR_REL, DECLINE_FACT, surveySpecAdoption, declineFingerprint, readDeclineAck, describeAdoption } = adoption;
const { checkSpecs, walkStore, readClosure } = await import('./spec-check.mjs').catch(() => ({}));
const { factFingerprint } = await import('./ack-store.mjs').catch(() => ({}));

const survey = (files, options) => surveySpecAdoption(ROOT, { io: repoOf(files, options) });
const draft = (slug) => specDoc(slug).replace('status: live', 'status: draft');
const retired = (slug) => specDoc(slug, { module: '*(empty)*' }).replace('status: live', 'status: retired');
const NO_STORE = { 'docs/ai/index.md': '# nav\n' };
const DRAFTS = {
  [`${STORE}index.md`]: ROOT_DOC(['- [login](./login.md)', '- [pay](./pay.md)']),
  [`${STORE}login.md`]: draft('login'),
  [`${STORE}pay.md`]: draft('pay'),
  [`${STORE}old.md`]: retired('old'),
};

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('surveySpecAdoption — the state comes from the store alone', () => {
  it('an absent store is not-adopted, a store with drafts only is adopting, one live contract is adopted (spec:spec-adoption/S1)', () => {
    assert.deepEqual({ ...survey(NO_STORE) }, { state: ADOPTION.NOT_ADOPTED, live: 0, draft: 0, retired: 0, reason: null });
    assert.deepEqual({ ...survey(DRAFTS) }, { state: ADOPTION.ADOPTING, live: 0, draft: 2, retired: 1, reason: null });
    const empty = { [`${STORE}index.md`]: ROOT_DOC([]) };
    assert.equal(survey(empty).state, ADOPTION.ADOPTING, 'a seeded store root alone is adopting');
    const mixed = { ...FLAT_STORE, [`${STORE}pay.md`]: draft('pay'), [`${STORE}g/index.md`]: indexDoc('g', []) };
    assert.deepEqual({ ...survey(mixed) }, { state: ADOPTION.ADOPTED, live: 1, draft: 1, retired: 0, reason: null });
    assert.equal(STORE_DIR_REL, 'docs/ai/specs');
  });

  it('a symlinked store, an unlistable branch, a non-regular entry and an unreadable document are unreadable with a reason (spec:spec-adoption/S2)', () => {
    const linked = survey(FLAT_STORE, { states: { [STORE_DIR_REL]: 'symlink' } });
    assert.equal(linked.state, ADOPTION.UNREADABLE);
    assert.match(linked.reason, /docs\/ai\/specs is symlink/);
    const asFile = survey(FLAT_STORE, { states: { [STORE_DIR_REL]: 'file' } });
    assert.match(asFile.reason, /is a file, not a directory/);
    const branch = { ...FLAT_STORE, [`${STORE}g/index.md`]: indexDoc('g', []) };
    const unlistable = survey(branch, { listFails: [`${STORE}g`] });
    assert.equal(unlistable.state, ADOPTION.UNREADABLE);
    assert.match(unlistable.reason, new RegExp(`^${STORE}g: `));
    const sneak = survey({ ...FLAT_STORE, [`${STORE}sneak.md`]: specDoc('sneak') }, { states: { [`${STORE}sneak.md`]: 'symlink' } });
    assert.equal(sneak.state, ADOPTION.UNREADABLE);
    assert.match(sneak.reason, /sneak\.md: a symlink sits inside the store/);
    const unreadable = survey(FLAT_STORE, { states: { [`${STORE}login.md`]: 'unreadable' } });
    assert.equal(unreadable.state, ADOPTION.UNREADABLE);
    assert.match(unreadable.reason, /^docs\/ai\/specs\/login\.md: /);
    const noRoot = survey(FLAT_STORE, { escapes: { '': null } });
    assert.match(noRoot.reason, /project root does not resolve/);
    for (const r of [linked, unlistable, sneak, unreadable]) assert.deepEqual([r.live, r.draft, r.retired], [0, 0, 0], 'nothing is counted over an unobserved store');
  });

  it('the exported census and read seam answer what the full lane answers, finding for finding (spec:spec-check/S7)', () => {
    const files = { ...FLAT_STORE, [`${STORE}g/index.md`]: indexDoc('g', []), [`${STORE}sneak.md`]: specDoc('sneak') };
    const options = { listFails: [`${STORE}g`], states: { [`${STORE}sneak.md`]: 'symlink', [`${STORE}login.md`]: 'unreadable' } };
    const full = checkSpecs({ root: ROOT, ops: [], all: true }, repoOf(files, options));
    const io = repoOf(files, options);
    const findings = [];
    const ctx = { io, at: abs, rootReal: io.realpath(ROOT), add: (rule, path, message) => findings.push({ rule, path, message }) };
    const closure = walkStore(ctx).map((path) => ({ path, roles: ['present'] }));
    readClosure(closure, ctx);
    const seam = new Set(['census', 'unreadable', 'contained', 'post-state']);
    const key = (f) => `${f.rule}|${f.path}|${f.message}`;
    assert.deepEqual(findings.map(key).sort(), full.findings.filter((f) => seam.has(f.rule)).map(key).sort());
    assert.ok(findings.length >= 3, 'the seam really observed the three defects');
  });
});

describe('the decline ack and the status line body', () => {
  it('the decline fingerprint is the store path fact fingerprint, and readDeclineAck answers through the guarded reader (spec:spec-adoption/S3)', () => {
    assert.equal(DECLINE_FACT, 'spec-adoption:declined:docs/ai/specs/');
    assert.equal(declineFingerprint(), factFingerprint(DECLINE_FACT));
    assert.match(declineFingerprint(), /^[0-9a-f]{16}$/);
    const root = mkdtempSync(join(tmpdir(), 'spec-adoption-'));
    dirs.push(root);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    assert.equal(readDeclineAck(root), false, 'no store — not declined');
    writeFileSync(join(root, 'docs', 'ai', 'acks.json'), JSON.stringify({ specAdoptionAck: 'deadbeefdeadbeef' }));
    assert.equal(readDeclineAck(root), false, 'another fingerprint is not this decline');
    writeFileSync(join(root, 'docs', 'ai', 'acks.json'), JSON.stringify({ specAdoptionAck: declineFingerprint(), other: 'kept' }));
    assert.equal(readDeclineAck(root), true);
    writeFileSync(join(root, 'docs', 'ai', 'acks.json'), '[]');
    assert.throws(() => readDeclineAck(root), /expected a JSON object/, 'the guarded reader refuses, never a silent false');
  });

  it('describeAdoption renders the four states, the counts and the declined suffix (spec:spec-adoption/S4)', () => {
    const at = (state, counts = {}, reason = null) => ({ state, live: 0, draft: 0, retired: 0, reason, ...counts });
    assert.equal(describeAdoption(at(ADOPTION.NOT_ADOPTED)), 'not adopted');
    assert.equal(describeAdoption(at(ADOPTION.NOT_ADOPTED), { declined: true }), 'not adopted — declined');
    assert.equal(describeAdoption(at(ADOPTION.ADOPTING, { draft: 2 })), 'adopting (2 draft)');
    assert.equal(describeAdoption(at(ADOPTION.ADOPTING, { draft: 0 }), { declined: true }), 'adopting (0 draft) — declined');
    assert.equal(describeAdoption(at(ADOPTION.ADOPTED, { live: 3, draft: 1 })), 'adopted (3 live, 1 draft)');
    assert.equal(describeAdoption(at(ADOPTION.ADOPTED, { live: 1 }), { declined: true }), 'adopted (1 live, 0 draft)', 'a decline is moot once adopted');
    assert.equal(describeAdoption(at(ADOPTION.UNREADABLE, {}, 'docs/ai/specs is symlink, not a directory')), 'could not be read — docs/ai/specs is symlink, not a directory');
  });
});

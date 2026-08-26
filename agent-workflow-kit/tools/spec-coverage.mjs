#!/usr/bin/env node
// NO WORK IS DONE WITHOUT A SPECIFICATION — the half prose cannot do.
//
// The spec store answers "what does this module promise?" only for the modules somebody chose to
// write a contract for, so a contract has been a suggestion: measured when this module was written,
// 122 tool modules under `agent-workflow-kit/tools/` and 14 of them covered. This module makes the
// contract a REQUIREMENT with a ratchet — a shipped tool no contract governs is a REFUSAL, and the
// debt of today's uncovered tools may only shrink.
//
// The contract this module is built to is `docs/ai/specs/kit/spec-coverage.md`, and it was written
// BEFORE this file. That order is the point: a contract amended after the code describes whatever
// the last review happened to find, which makes review an open question with no bounded answer.
//
// Pure functions. No filesystem, no argv, no side effects on import — the CLI half owns all of that.
// Dependency-free, Node >= 22.

import { readSpecDocument } from '../references/scripts/spec-schema.mjs';

// One `## Module` bullet, carried with the document that made the claim so a refusal can name the
// owner. The two forms are the ones the spec schema already validates and there is no third here:
// a `dir/` root covers by PREFIX, a file claim by EQUALITY. The trailing slash is what makes the
// prefix test safe — `tools/manifest/` can never swallow `tools/manifest-validate.mjs`.
// Only a LIVE contract claims shipped code. A `draft` is a proposal — it may name a module nobody
// has built and bind a scenario to nothing — and a `retired` one has stopped promising anything. If
// either counted, a tool could ship covered by a contract that was never in force.
const CLAIMING_KINDS = new Set(['spec']);
const CLAIMING_STATUS = 'live';

export const claimsOf = (documents) => {
  const claims = [];
  const unreadable = [];
  for (const { rel, text } of documents) {
    const verdict = readSpecDocument(String(text ?? ''), rel);
    // Only a CONTRACT claims code. A navigator (`kind: index`) lists children and a part belongs to
    // the module its parent already claims, so neither is asked for a `## Module` — skipping them by
    // KIND, never by the absence of the section, is what keeps the next line honest.
    if (!CLAIMING_KINDS.has(verdict.kind) || verdict.status !== CLAIMING_STATUS) continue;
    const module = verdict.structure?.module;
    // A CONTRACT whose module cannot be read is its OWN finding, never a silent skip: the tools it
    // would have covered would look uncovered and the refusal would name the wrong defect.
    if (!module) unreadable.push({ rel, why: verdict.errors?.[0]?.message ?? 'no readable ## Module declaration' });
    else for (const path of module.paths) claims.push({ path, form: module.form, by: rel });
  }
  return { claims, unreadable };
};

export const coveredBy = (claims, path) =>
  claims.find((claim) => (claim.path.endsWith('/') ? path.startsWith(claim.path) : claim.path === path)) ?? null;

// The verdict over one census. The debt is DERIVED — `adopted` minus `settled` — so there is no
// stored list a hand can edit into a lie. Three findings:
//   uncovered       a tool no contract covers and the derived debt does not owe — the refusal
//   falselySettled  a path recorded as PAID whose contract is not there — the record claims what the
//                   contracts do not say, and it is checked against them every run
//   payable         a path still owed whose contract now EXISTS — the debt shrank and the record did
//                   not, so run --write-debt; until then the record overstates what is owed
export const judgeCoverage = ({ tools, claims, adopted = [], settled = [] }) => {
  const paid = new Set(settled);
  const owed = adopted.filter((path) => !paid.has(path));
  const stillOwed = new Set(owed);
  const present = new Set(tools);
  const covered = [];
  const uncovered = [];
  for (const path of tools) {
    const claim = coveredBy(claims, path);
    if (claim) covered.push({ path, by: claim.by });
    else if (!stillOwed.has(path)) uncovered.push(path);
  }
  const falselySettled = settled.filter((path) => present.has(path) && coveredBy(claims, path) === null);
  const payable = owed.filter((path) => !present.has(path) || coveredBy(claims, path) !== null);
  return { covered, uncovered, falselySettled, payable, debt: owed };
};

// What a `--write-debt` run may record: every path whose contract now exists moves into `settled`,
// and nothing else changes. `adopted` is never touched, so a path that is not in it cannot be
// invented — the run names it and says to write the contract.
export const settleAfter = (adopted, settled, payable) => {
  const unknown = payable.filter((path) => !adopted.includes(path));
  if (unknown.length) return { ok: false, unknown };
  return { ok: true, settled: [...new Set([...settled, ...payable])].sort(), added: payable };
};

export const formatFindings = ({ uncovered, falselySettled = [], payable = [], unreadable = [] }) => [
  ...unreadable.map((u) => `  ${u.rel}: its ## Module cannot be read (${u.why}) — the tools it claims are unknown`),
  ...uncovered.map((p) => `  ${p}: no contract under docs/ai/specs/ claims this module — write one, or it cannot ship`),
  ...falselySettled.map((p) => `  ${p}: recorded as SETTLED, but no live contract claims it — the record asserts a contract that is not there`),
  ...payable.map((p) => `  ${p}: still recorded as owed although it is covered now (or gone) — run --write-debt to record what was paid`),
];

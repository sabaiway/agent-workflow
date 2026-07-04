#!/usr/bin/env node
// Delegation decision + hand-off plan — the kit-owned, executable form of the composition
// contract, so the "delegate vs fall back" choice and the stamp/commit responsibilities are
// pinned down by code + tests, not left to agent interpretation (Plan §1.7).
//
//   detectMemory(dir) → { delegate, reason, ... }   runs the kit's OWN validator + asset check
//   handoffPlan(delegate) → who writes what, which stamps end up present, who owns the commit gate
//
// Pure (dependency-injectable validator + fs), dependency-free, Node >= 18.

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateManifest, VALID } from './manifest/validate.mjs';

// The exact skill name a delegable memory candidate must declare (guards against a wrong-name
// manifest that happens to be a valid memory-substrate with the right assets).
export const EXPECTED_MEMORY_NAME = 'agent-workflow-memory';

// The assets a memory candidate must carry, AND their required type. A partial install (manifest +
// SKILL.md only) is missing these → invalid → fallback. Checking the type (not just existence)
// rejects a wrong-shaped install (e.g. a file where a dir is expected) BEFORE any project write.
//
// `references/templates/orchestration.json` (Step 2.4) is a SURGICAL gate: a memory too old to ship
// the orchestration-config template (pre-1.2.0, e.g. v1.0.0) can't seed `docs/ai/orchestration.json`,
// so it must NOT be delegate-classified — the kit then falls back to its OWN bundled substrate, which
// DOES seed orchestration.json (Mode: upgrade step 3). This closes the stale-memory trap that the
// read-only family-registry note (MEMORY_ORCH_TEMPLATE_REL) only INFORMS about — the gate ACTS. The
// two key on the same asset; a cross-tool parity test pins them in lockstep.
export const REQUIRED_MEMORY_ASSETS = [
  { path: 'references/templates', type: 'dir' },
  { path: 'references/templates/orchestration.json', type: 'file' },
  { path: 'references/contracts.md', type: 'file' },
  { path: 'references/scripts', type: 'dir' },
  { path: 'scripts/stamp-takeover.mjs', type: 'file' },
  { path: 'migrations', type: 'dir' },
  { path: 'capability.json', type: 'file' },
];

const defaultStatType = (path) => {
  try {
    const s = statSync(path);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
};

// Decide whether to delegate substrate deployment to a memory candidate. The kit runs its OWN
// validator (never one shipped by the candidate). Delegate only on valid + kind memory-substrate +
// right name + available + all required assets present AT THE RIGHT TYPE; otherwise fall back.
export const detectMemory = (memorySkillDir, deps = {}) => {
  const validate = deps.validate ?? validateManifest;
  const statType = deps.statType ?? defaultStatType;
  const report = validate(memorySkillDir);
  const missingAssets = REQUIRED_MEMORY_ASSETS.filter(
    (asset) => statType(join(memorySkillDir, asset.path)) !== asset.type,
  ).map((asset) => asset.path);
  const delegate =
    report.result === VALID &&
    report.kind === 'memory-substrate' &&
    report.name === EXPECTED_MEMORY_NAME &&
    report.available !== false &&
    missingAssets.length === 0;
  const reason = delegate
    ? 'memory manifest valid (kind: memory-substrate) and all required assets present'
    : report.result !== VALID
      ? `memory manifest ${report.result} — using bundled fallback`
      : report.kind !== 'memory-substrate'
        ? `memory manifest kind "${report.kind}" is not memory-substrate — using bundled fallback`
        : report.name !== EXPECTED_MEMORY_NAME
          ? `memory manifest name "${report.name}" is not "${EXPECTED_MEMORY_NAME}" — using bundled fallback`
          : report.available === false
            ? 'memory manifest is a declared stub (available:false) — using bundled fallback'
            : `memory install incomplete (missing: ${missingAssets.join(', ')}) — using bundled fallback`;
  return { delegate, reason, validatorResult: report.result, kind: report.kind, name: report.name, available: report.available, missingAssets };
};

// The hand-off matrix. Memory NEVER raises its own commit gate; the kit owns exactly ONE
// composition-level gate, after injection. Delegated → both stamps; fallback → .workflow-version only.
export const handoffPlan = (delegate) =>
  delegate
    ? {
        mode: 'delegate',
        memoryWrites: ['docs/ai/', 'AGENTS.md', 'docs/ai/.memory-version'],
        // The lens region runs AFTER the substrate deploy (its own precondition: the file exists)
        // — it converges a stale-memory seed to the installed engine's canon (AD-041).
        kitWrites: ['AGENTS.md methodology slot', 'docs/ai/agent_rules.md lens region', 'docs/ai/.workflow-version'],
        stampsPresent: ['.memory-version', '.workflow-version'],
        memoryRaisesCommitGate: false,
        commitGate: 'kit-only-after-injection',
      }
    : {
        mode: 'fallback',
        memoryWrites: [],
        // Fallback now ships the kit's OWN AGENTS.md carrying the EMPTY methodology slot (Plan 2);
        // the kit reconciles it (ensure-slot + inject-because-empty) exactly like the delegate
        // path — so both paths end with a FILLED slot, not inline methodology. The lens region
        // runs after the fallback-template copy of docs/ai (same reconcile, both paths — AD-041).
        kitWrites: ['docs/ai/', 'AGENTS.md', 'AGENTS.md methodology slot', 'docs/ai/agent_rules.md lens region', 'docs/ai/.workflow-version'],
        stampsPresent: ['.workflow-version'],
        memoryRaisesCommitGate: false,
        commitGate: 'kit-only-after-injection',
      };

const main = (argv) => {
  const dir = argv[0];
  if (!dir) {
    console.error('usage: delegation.mjs <memory-skill-dir>   (prints the delegate/fallback decision + hand-off plan)');
    process.exit(2);
  }
  const decision = detectMemory(resolve(dir));
  const plan = handoffPlan(decision.delegate);
  console.log(`[delegation] ${plan.mode}: ${decision.reason}`);
  console.log(`[delegation] stamps present after deploy: ${plan.stampsPresent.join(', ')}`);
  console.log(`[delegation] commit gate: ${plan.commitGate} (memory raises its own gate: ${plan.memoryRaisesCommitGate})`);
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main(process.argv.slice(2));

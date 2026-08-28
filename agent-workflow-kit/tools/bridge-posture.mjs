import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DEFAULT_BUNDLE_ROOT } from './bridge-settings-read.mjs';
import { KNOWN_BACKENDS } from './detect-backends.mjs';
import { receiptIdOfCmd } from './carriers.mjs';

const oneLine = (value) => String(value).replace(/[\s]+/gu, ' ').trim();

const validPosture = (posture) => posture !== null && typeof posture === 'object' && !Array.isArray(posture)
  && typeof posture.model === 'string' && posture.model.length > 0
  && (!Object.hasOwn(posture, 'effort') || (typeof posture.effort === 'string' && posture.effort.length > 0))
  && (!Object.hasOwn(posture, 'tier') || posture.tier === null || (typeof posture.tier === 'string' && posture.tier.length > 0))
  && Object.keys(posture).every((key) => ['model', 'effort', 'tier'].includes(key));

const postureString = (posture, backend, settings) => {
  const parts = [`model=${oneLine(posture.model)}`];
  if (Object.hasOwn(posture, 'effort')) parts.push(`effort=${oneLine(posture.effort)}`);
  if (Object.hasOwn(posture, 'tier')) {
    const knob = (settings?.active ?? []).find((row) => row.key === 'CODEX_SERVICE_TIER' && row.bridge === backend.name);
    parts.push(knob ? `tier=${oneLine(knob.value)} (bridge-settings)` : `tier=${posture.tier ?? 'standard'}`);
  }
  return parts.join(' ');
};

export const posturesByBackend = (ctx = {}) => {
  const bundleRoot = ctx.bundleRoot ?? DEFAULT_BUNDLE_ROOT;
  const read = ctx.readFile ?? readFileSync;
  return Object.fromEntries(KNOWN_BACKENDS.flatMap((backend) => {
    const cmd = backend.roleCmds?.review;
    const receiptId = receiptIdOfCmd(cmd);
    if (receiptId === null) return [];
    const path = join(bundleRoot, backend.name, 'capability.json');
    try {
      const manifest = JSON.parse(String(read(path, 'utf8')));
      if (!Object.hasOwn(manifest, 'posture')) {
        return [[receiptId, { state: 'none', posture: null, path }]];
      }
      if (!validPosture(manifest.posture)) throw new Error('invalid posture block');
      return [[receiptId, {
        state: 'valid',
        posture: postureString(manifest.posture, backend, ctx.settings ?? { active: [] }),
        path,
      }]];
    } catch (error) {
      return [[receiptId, { state: 'unreadable', posture: null, path, reason: oneLine(error?.message ?? error) }]];
    }
  }));
};

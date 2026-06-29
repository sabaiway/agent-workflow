// view-model.mjs — transform the no-leak `--json` envelope (buildEnvelope output) into a render-ready
// ViewModel for the direct-CLI renderers. Plan §4.2 / §4.5: surface → VIEW-MODEL → renderers.
//
// One data source: the renderers never touch the raw surveys, only this VM, which is built from the
// ENVELOPE — so the renderers inherit the envelope's no-leak guarantee (internal manifestState / stamp
// filenames never reach them). This module resolves public tokens → English phrases (presentation.mjs)
// and computes the headline counts; the renderers do layout + glyphs only.
//
// Pure, no side effects, Node >= 18.

import { STATE_PHRASING, VISIBILITY_PHRASING } from './presentation.mjs';

const memberVm = (m) => {
  const refresh = m.refresh ?? { behind: false, recommend: null };
  return {
    display: m.display,
    version: m.version ?? null,
    state: m.state,
    // 'installed' → null (the renderer shows the version instead); every other public token → a phrase.
    statePhrase: m.state in STATE_PHRASING ? STATE_PHRASING[m.state] : m.state,
    notes: m.notes ?? [], // the verbatim caveats — printed as ↳ sub-lines (INV-3: no dedupe)
    behind: Boolean(refresh.behind), // used ONLY for the headline count on the direct CLI (INV-3)
    recommend: refresh.recommend ?? null,
  };
};

const bridgeVm = (b) => ({
  display: b.display,
  readiness: b.readiness,
  // preserve the three-state wrapper status (present | missing | unknown) — the renderer maps to a glyph.
  wrappers: (b.wrappers ?? []).map((w) => ({ cmd: w.cmd, state: w.state })),
});

const visibilityVm = (v) => {
  if (!v) return null;
  if (v.error) return { error: v.error };
  return { phrase: v.state in VISIBILITY_PHRASING ? VISIBILITY_PHRASING[v.state] : v.state };
};

const recipesVm = (r) => {
  if (!r) return null;
  if (r.error) return { error: r.error };
  const pairs = [];
  for (const [activity, slots] of Object.entries(r.activities ?? {})) {
    for (const [slot, v] of Object.entries(slots)) pairs.push({ key: `${activity}.${slot}`, recipe: v.recipe });
  }
  return { pairs, detectError: r.detectError ?? null };
};

const attributionVm = (a) => {
  if (!a) return null;
  if (a.error) return { error: a.error };
  // A local OVERRIDE only when local actually set the key (non-null) AND it differs from project — a
  // null local means the key is absent there, so the project value stands (that is not an override).
  const override = a.local != null && a.local !== a.project;
  return { effective: a.effective ?? null, override };
};

const velocityVm = (v) => {
  if (!v) return null;
  if (v.error) return { error: v.error };
  return { defaultMode: v.defaultMode ?? null, allow: { project: v.allowEntries?.project ?? 0, local: v.allowEntries?.local ?? 0 } };
};

const settingsVm = (s) =>
  s ? { recipes: recipesVm(s.recipes), attribution: attributionVm(s.attribution), velocity: velocityVm(s.velocity) } : null;

const projectVm = (p) =>
  p
    ? {
        dir: p.dir,
        deployed: p.deployed,
        docsAi: p.docsAi,
        deployStamps: (p.deployStamps ?? []).map((st) => ({ display: st.display, version: st.version ?? null })),
        visibility: visibilityVm(p.visibility),
        settings: settingsVm(p.settings),
      }
    : null;

export const toViewModel = (envelope = {}) => {
  const members = (envelope.installed ?? []).map(memberVm);
  return {
    deploymentHead: envelope.deploymentHead ?? null,
    members,
    headline: { total: members.length, behind: members.filter((m) => m.behind).length },
    bridges: envelope.bridges ? envelope.bridges.map(bridgeVm) : null,
    project: projectVm(envelope.project),
  };
};

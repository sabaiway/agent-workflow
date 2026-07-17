// view-model.mjs — transform the no-leak `--json` envelope (buildEnvelope output) into a render-ready
// ViewModel for the direct-CLI renderers. Plan §4.2 / §4.5: surface → VIEW-MODEL → renderers.
//
// One data source: the renderers never touch the raw surveys, only this VM, which is built from the
// ENVELOPE — so the renderers inherit the envelope's no-leak guarantee (internal manifestState / stamp
// filenames never reach them). This module resolves public tokens → English phrases (presentation.mjs)
// and computes the headline counts; the renderers do layout + glyphs only.
//
// Pure, no side effects, Node >= 22.

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
    // The checked-vs-unknown freshness signal (INV-C): 'current' | 'behind' | 'unknown' | 'not-checked'.
    // An envelope predating the field defaults to not-checked (behind stays behind) — never a claim.
    freshness: refresh.freshness ?? (refresh.behind ? 'behind' : 'not-checked'),
  };
};

const bridgeVm = (b) => ({
  display: b.display,
  readiness: b.readiness,
  // preserve the three-state wrapper status (present | missing | unknown) — the renderer maps to a glyph.
  wrappers: (b.wrappers ?? []).map((w) => ({ cmd: w.cmd, state: w.state })),
  // fact-only host-level settings: the active knobs for this bridge, or a localized error; null when
  // nothing is set (the renderer then adds no sub-line — the block stays as it was before any knob).
  settings: b.settings?.error
    ? { error: b.settings.error }
    : b.settings?.active?.length
      ? { active: b.settings.active.map((a) => ({ key: a.key, value: a.value, source: a.source })) }
      : null,
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

const agentsVm = (a) => {
  if (!a) return null;
  if (a.error) return { error: a.error };
  return { bundled: a.bundled ?? 0, placed: a.placed ?? 0 };
};

const hookVm = (h) => {
  if (!h) return null;
  if (h.error) return { error: h.error };
  return {
    wired: Boolean(h.wired),
    filePlaced: Boolean(h.filePlaced),
    declarationPresent: Boolean(h.declarationPresent),
    // 0 = absent/empty declaration; null = unreadable/malformed OR an envelope predating the
    // field — unknown reads as unknown, never as a count (the welcome-mat hook rung keys on > 0).
    declaredGates: h.declaredGates ?? null,
    // The preserved validation reason for a null count (null when absent) — rendered beside the
    // unknown marker so a malformed declaration is never a silent bare "?".
    declarationError: h.declarationError ?? null,
  };
};

const settingsVm = (s) =>
  s
    ? {
        recipes: recipesVm(s.recipes),
        attribution: attributionVm(s.attribution),
        velocity: velocityVm(s.velocity),
        agents: agentsVm(s.agents),
        hook: hookVm(s.hook),
      }
    : null;

const projectVm = (p) =>
  p
    ? {
        dir: p.dir,
        deployed: p.deployed,
        docsAi: p.docsAi,
        adrLayout: p.adrLayout ?? null,
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
    headline: {
      total: members.length,
      behind: members.filter((m) => m.behind).length,
      // The zero-behind verdict scope (INV-C): checked = a freshness probe RAN and concluded;
      // unknown = it ran but could not conclude (INV-B — blocks the all-current verdict).
      checked: members.filter((m) => m.freshness === 'current' || m.freshness === 'behind').length,
      unknown: members.filter((m) => m.freshness === 'unknown').length,
    },
    bridges: envelope.bridges ? envelope.bridges.map(bridgeVm) : null,
    project: projectVm(envelope.project),
  };
};

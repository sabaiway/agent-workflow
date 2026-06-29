// renderers.mjs — the direct-CLI presenters (plain + ansi) for the four status blocks. Plan §4.2/§4.5.
//
// Input: the ViewModel (view-model.mjs, built from the no-leak envelope) + a resolved surface
// (surface.mjs: { mode, width, color, ascii }). Output: a single string. `mode` selects plain vs ansi;
// the JSON mode is handled by the caller (it prints the envelope, not a render). The renderers do
// LAYOUT + GLYPHS only — phrasing + headline counts already live in the ViewModel.
//
// Pure, no side effects, Node >= 18.

import { BLOCK_TITLES, SETTINGS_LABELS, glyphsFor, NO_DEPLOYMENT } from './presentation.mjs';

const MEMBER_COL = 20;
const VERSION_COL = 12;
const READINESS_COL = 14;
const STAMP_COL = 26;
const SETTINGS_COL = 14;

const SGR = Object.freeze({ bold: '\x1b[1m', reset: '\x1b[0m' });
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const visibleLength = (s) => s.replace(ANSI_RE, '').length;

const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
// A styled span only when color is on — so color:false emits ZERO SGR (plain output, byte-clean).
const heading = (text, color) => (color ? `${SGR.bold}${text}${SGR.reset}` : text);

const renderMembers = (vm, { color, glyph }) => {
  const lines = [heading(BLOCK_TITLES.members, color), ''];
  for (const m of vm.members) {
    const ver = m.version ? `v${m.version}` : '—';
    const tail = m.statePhrase == null ? '' : m.statePhrase; // installed → the version IS the info
    lines.push(`  ${pad(m.display, MEMBER_COL)}${pad(ver, VERSION_COL)}${tail}`.trimEnd());
    for (const note of m.notes) lines.push(`      ${glyph.note} ${note}`); // verbatim caveats (INV-3)
  }
  // refresh.behind drives a HEADLINE COUNT only — the recovery command stays in the verbatim notes
  // above (the direct CLI never dedupes, never re-prints it). Omitted when nothing is behind.
  if (vm.headline.behind > 0) {
    lines.push(`  ${vm.headline.behind} member(s) need a refresh (see the ${glyph.note} notes above).`);
  }
  return lines;
};

const renderBridges = (vm, { glyph, color }) => {
  if (!vm.bridges) return [];
  const lines = ['', heading(BLOCK_TITLES.bridges, color), ''];
  for (const b of vm.bridges) {
    const wrappers = b.wrappers.map((w) => `${w.cmd} ${glyph[w.state] ?? glyph.unknown}`).join(', ') || '—';
    lines.push(`  ${pad(b.display, MEMBER_COL)}${pad(b.readiness, READINESS_COL)}wrappers: ${wrappers}`);
  }
  return lines;
};

const renderProject = (vm, { color }) => {
  const p = vm.project;
  if (!p) return [];
  const lines = ['', heading(BLOCK_TITLES.project(p.dir), color), ''];
  if (!p.deployed) {
    lines.push(`  ${NO_DEPLOYMENT}`);
    return lines;
  }
  for (const s of p.deployStamps) lines.push(`  ${pad(s.display, STAMP_COL)}${s.version ?? '—'}`);
  lines.push(`  ${pad('docs/ai present', STAMP_COL)}${p.docsAi ? 'yes' : 'no'}`);
  if (p.visibility) {
    const v = p.visibility.error ? `error: ${p.visibility.error}` : p.visibility.phrase;
    lines.push(`  ${pad('visibility', STAMP_COL)}${v}`);
  }
  return lines;
};

const renderSettings = (vm, { color, glyph }) => {
  const s = vm.project?.settings;
  if (!s) return [];
  const lines = ['', heading(BLOCK_TITLES.settings, color)];
  // recipes — the effective recipe per slot, or a loud error; a detector floor adds a sub-line.
  if (s.recipes?.error) lines.push(`  ${pad(SETTINGS_LABELS.recipes, SETTINGS_COL)}error: ${s.recipes.error}`);
  else if (s.recipes) {
    const joined = s.recipes.pairs.map((p) => `${p.key}=${p.recipe}`).join(' · ') || '—';
    lines.push(`  ${pad(SETTINGS_LABELS.recipes, SETTINGS_COL)}${joined}`);
    if (s.recipes.detectError) {
      lines.push(`  ${pad('', SETTINGS_COL)}${glyph.note} couldn't check backends (${s.recipes.detectError}); recipes floored at solo`);
    }
  }
  // attribution — effective includeCoAuthoredBy; a real local override is called out.
  if (s.attribution?.error) lines.push(`  ${pad(SETTINGS_LABELS.attribution, SETTINGS_COL)}error: ${s.attribution.error}`);
  else if (s.attribution) {
    const override = s.attribution.override ? ' (local override)' : '';
    lines.push(`  ${pad(SETTINGS_LABELS.attribution, SETTINGS_COL)}includeCoAuthoredBy effective=${String(s.attribution.effective)}${override}`);
  }
  // velocity — effective defaultMode + per-source allow counts.
  if (s.velocity?.error) lines.push(`  ${pad(SETTINGS_LABELS.velocity, SETTINGS_COL)}error: ${s.velocity.error}`);
  else if (s.velocity) {
    lines.push(`  ${pad(SETTINGS_LABELS.velocity, SETTINGS_COL)}defaultMode=${String(s.velocity.defaultMode)} · allow project/local=${s.velocity.allow.project}/${s.velocity.allow.local}`);
  }
  return lines;
};

// Pad each NON-empty line UP to the surface width (by VISIBLE length, so SGR codes don't count); empty
// separator lines stay empty. `width` is a MIN target for a consistent block, NOT a hard max: a long
// content line — a verbatim caveat `↳`, a long recipe row — is left INTACT and is NEVER truncated,
// because truncating could hide part of a recovery command (a no-silent-failure violation). The
// terminal soft-wraps an over-width line; data integrity wins over a perfectly rectangular block.
const padLineTo = (line, width) => {
  if (line === '') return '';
  const vis = visibleLength(line);
  return vis < width ? line + ' '.repeat(width - vis) : line;
};

export const render = (vm, surface = {}) => {
  const glyph = glyphsFor(Boolean(surface.ascii));
  const color = surface.mode === 'ansi' && Boolean(surface.color); // color applies in ansi mode only
  const ctx = { color, glyph };
  const lines = [
    ...renderMembers(vm, ctx),
    ...renderBridges(vm, ctx),
    ...renderProject(vm, ctx),
    ...renderSettings(vm, ctx),
  ];
  if (surface.mode === 'ansi') return lines.map((l) => padLineTo(l, surface.width ?? 80)).join('\n');
  return lines.join('\n');
};

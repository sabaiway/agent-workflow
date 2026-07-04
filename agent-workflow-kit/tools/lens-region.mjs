#!/usr/bin/env node
// Heading-anchored lens-region reconcile — the composition root's only mutation of a deployed
// `docs/ai/agent_rules.md`. The planning/review/process-fidelity lens block (`### 2.x. Planning,
// review & process-fidelity invariants`) has ONE canonical home — the installed engine's
// `references/agent-rules-lens.md` — and every deployed/template copy is a RENDER of it (the
// file's own section number substituted into the number-neutral heading). This tool refreshes a
// deployed region to the current canon under the AD-025 discipline: refresh IFF the region's
// normalized body matches the current fragment (already current → zero-diff) or a KNOWN PRIOR
// canonical body (the engine's append-only `references/agent-rules-lens-priors.md`, read live
// beside the fragment — no kit-side prior constants, so a canon wording change is an engine-only
// release). Anything else is preserved byte-for-byte + a one-line advisory.
//
// The region has NO markers (unlike the AGENTS.md pointer slots): it is located by the heading
// through the next structural boundary (`---` / `##` / `###`) or EOF — the extraction rule the
// lens-mirror guard pioneered, promoted here as the shipped implementation. A user-renamed
// heading is therefore a natural preserve+advise; bytes outside the region are never touched.
//
// The live read is lazy + fail-loud: the engine is consulted only when a present region must be
// classified; a fully absent/invalid engine is a loud STOP (never a silent fallback), a valid
// engine that merely predates the lens pair (<1.13.0) is a stated soft skip. Cap-guard: a refresh
// that would push the file over its own frontmatter `maxLines` is a loud, non-fatal refusal —
// never a silent truncate; a file without frontmatter/`maxLines` skips the guard with a stated
// note (such a file is outside the docs cap gate anyway).
//
// Pure string functions (fs only in the CLI); dependency-free, Node >= 18.

import { normalizeCanonical } from './orchestration-config.mjs';

// The deployed-heading matcher (prefix, like the historical extractLensBlock: robust to a future
// heading-tail tweak) and the number-neutral form the engine fragment carries.
export const LENS_HEADING_RE = /^### 2\.(\d+)\. Planning, review & process-fidelity/;
const NEUTRAL_HEADING_RE = /^### 2\.x\. Planning, review & process-fidelity/;
const HEADING_LABEL = '### 2.x. Planning, review & process-fidelity invariants';

const stripCr = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);
const isBoundary = (bareLine) => bareLine === '---' || /^#{2,3} /.test(bareLine);

// Count lines independent of a trailing newline (the inject-methodology contract).
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// ── the frozen prior-store format (documented in the store file's own header) ─────
// A delimiter is a line that starts with `<!-- prior` and ends with `-->`; an entry body is
// everything after it up to the next delimiter / EOF, trimmed. The pre-delimiter header is
// ignored. APPEND-ONLY on the engine side — this parser must keep reading a newer engine's file.
export const parseLensPriors = (text) => {
  const entries = [];
  let current = null;
  for (const line of String(text).split('\n')) {
    const bare = stripCr(line);
    if (bare.startsWith('<!-- prior') && bare.endsWith('-->')) {
      if (current) entries.push(current.join('\n'));
      current = [];
    } else if (current) current.push(line);
  }
  if (current) entries.push(current.join('\n'));
  return entries.map((e) => normalizeCanonical(e)).filter((e) => e !== '');
};

// renderLens(fragment, number) → the number-neutral canonical block bound to the file's OWN
// section number (memory-seeded files say 2.6, kit-fallback files 2.5 — the fragment never
// hardcodes one). LF-canonical; the CLI converts to the document's EOL style on write.
export const renderLens = (fragment, number) =>
  normalizeCanonical(fragment).replace(NEUTRAL_HEADING_RE, (m) => m.replace('2.x', `2.${number}`));

// normalizeLensBody(body) → the number-neutral, whitespace/EOL-normalized comparison form
// (heading number → `2.x`, trim, CRLF→LF) every known-set match uses.
export const normalizeLensBody = (body) =>
  normalizeCanonical(String(body).replace(/^### 2\.\d+\./, '### 2.x.'));

// extractLensRegion(text) → { found: false } | { found, start, end, number, body }.
// `start`/`end` are line indices over text.split('\n') — heading line through (exclusive) the
// next structural boundary; EOF is a valid region end (no following boundary required). `body`
// is the CR-stripped block with trailing blank lines dropped (the comparison form); the raw
// region lines (including trailing blanks) are what replaceLensRegion preserves around a render.
export const extractLensRegion = (text) => {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => LENS_HEADING_RE.test(stripCr(line)));
  if (start === -1) return { found: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isBoundary(stripCr(lines[i]))) {
      end = i;
      break;
    }
  }
  const number = stripCr(lines[start]).match(LENS_HEADING_RE)[1];
  const regionLines = lines.slice(start, end);
  let bodyEnd = regionLines.length;
  while (bodyEnd > 0 && stripCr(regionLines[bodyEnd - 1]).trim() === '') bodyEnd -= 1;
  const body = regionLines.slice(0, bodyEnd).map(stripCr).join('\n');
  return { found: true, start, end, number, body };
};

// replaceLensRegion(text, region, renderedBody) → the document with ONLY the region's block
// lines replaced; trailing blank lines inside the region and every byte outside it are
// preserved verbatim. Output keeps the document's EOL style (CRLF documents stay CRLF).
export const replaceLensRegion = (text, region, renderedBody) => {
  const lines = String(text).split('\n');
  const crlf = String(text).includes('\r\n');
  const regionLines = lines.slice(region.start, region.end);
  let bodyEnd = regionLines.length;
  while (bodyEnd > 0 && stripCr(regionLines[bodyEnd - 1]).trim() === '') bodyEnd -= 1;
  const trailing = regionLines.slice(bodyEnd); // preserved verbatim (their own CR bytes intact)
  const newBody = renderedBody.split('\n').map((l) => (crlf ? `${l}\r` : l));
  const out = [...lines.slice(0, region.start), ...newBody, ...trailing, ...lines.slice(region.end)];
  // In a CRLF document, only a line FOLLOWED by another line carries the CR byte; when the new
  // body's last line is the final line of the whole document (EOF region, no trailing newline),
  // strip the CR we just added so no stray byte lands at EOF.
  if (crlf && trailing.length === 0 && region.end === lines.length) {
    out[out.length - 1] = stripCr(out[out.length - 1]);
  }
  return out.join('\n');
};

// reconcileLensText(text, fragment, priors) — the PURE policy decision:
//   { status: 'no-region' }  — heading absent/renamed → preserve + advise (caller words it).
//   { status: 'current' }    — the region already renders the current canon → zero-diff.
//   { status: 'refreshed', text } — the region matched the canon or a known prior → re-rendered
//                                   with the file's OWN number (cap-guard is the caller's, so the
//                                   decision stays pure).
//   { status: 'custom' }     — anything else → preserved byte-for-byte + advisory.
export const reconcileLensText = (text, fragment, priors) => {
  const region = extractLensRegion(text);
  if (!region.found) return { status: 'no-region', text };
  const current = normalizeLensBody(region.body);
  const canon = normalizeLensBody(fragment);
  if (current === canon) return { status: 'current', text };
  const known = priors.map((p) => normalizeLensBody(p));
  if (!known.includes(current)) return { status: 'custom', text };
  return { status: 'refreshed', text: replaceLensRegion(text, region, renderLens(fragment, region.number)) };
};

// frontmatterMaxLines(text) → the file's own `maxLines:` frontmatter value, or null when the
// file has no frontmatter block or the block carries no maxLines (→ the cap-guard is skipped
// with a stated note, never a throw — such a file is outside the docs cap gate anyway).
export const frontmatterMaxLines = (text) => {
  const lines = String(text).split('\n').map(stripCr);
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return null;
    const m = lines[i].match(/^maxLines:\s*(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
};

// ── CLI: `lens-region.mjs reconcile <path/to/agent_rules.md>` ─────────────────────
// Outcome lines are the contract the upgrade/bootstrap prose relays in plain language; exit 0 on
// every classified outcome (including the soft skips and the cap refusal), exit 1 ONLY on the
// hard engine STOP or an unexpected fs error, exit 2 on usage.
export const runCli = async (argv, deps = {}) => {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? (await import('node:fs/promises'));
  const { dirname, basename, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { resolveEngineDir, detectEngine, readEngineFragment, LENS_FRAGMENT_REL, LENS_PRIORS_REL } = await import('./engine-source.mjs');

  if (argv[0] !== 'reconcile' || !argv[1] || argv.length > 2) {
    logError('usage: lens-region.mjs reconcile <path/to/agent_rules.md>');
    return 2;
  }
  const targetPath = resolve(argv[1]);

  // 1. Absent file → a stated skip (the memory substrate owns seeding; nothing to reconcile).
  const text = await (async () => {
    try {
      return await fs.readFile(targetPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  })();
  if (text === null) {
    log(`[lens-region] ${argv[1]} is absent — skipped (nothing to reconcile; the substrate seeds it at bootstrap).`);
    return 0;
  }

  // 2. No matching heading → preserve + advise, engine never consulted (the outcome is preserve
  //    regardless, so the lazy contract holds).
  if (!extractLensRegion(text).found) {
    log(`[lens-region] no "${HEADING_LABEL}" section in ${argv[1]} — left untouched.`);
    log('[lens-region] note: the planning/review lens section is missing or renamed — it cannot be auto-refreshed; restore the canonical heading to re-enable refresh.');
    return 0;
  }

  // 3. A present region must be classified → live-read the engine's fragment + prior store.
  //    Fully absent/invalid engine → loud STOP; valid-but-pre-lens engine → stated soft skip.
  const { dir, source } = resolveEngineDir({ env, home: deps.home ?? homedir() });
  const lensPairPresent =
    detectEngine(dir, { source, rel: LENS_FRAGMENT_REL }).ok && detectEngine(dir, { source, rel: LENS_PRIORS_REL }).ok;
  if (!lensPairPresent) {
    if (detectEngine(dir, { source }).ok) {
      log('[lens-region] skipped — the installed engine is too old (or incomplete) to supply the lens canon; refresh it with `npx @sabaiway/agent-workflow-engine@latest init`, then re-run.');
      return 0;
    }
    try {
      readEngineFragment(dir, { source, rel: LENS_FRAGMENT_REL }); // throws the canonical install-me error
      return 1; // defensive: the pair is unusable — never proceed to a read
    } catch (err) {
      logError(`[lens-region] reconcile STOP — ${err.message}`);
      return 1;
    }
  }
  // TOCTOU guard: a fragment that vanishes between detect and read is a corruption STOP, never a
  // silent proceed — readEngineFragment's own throw carries the install command.
  let fragment;
  let priors;
  try {
    fragment = readEngineFragment(dir, { source, rel: LENS_FRAGMENT_REL });
    priors = parseLensPriors(readEngineFragment(dir, { source, rel: LENS_PRIORS_REL }));
  } catch (err) {
    logError(`[lens-region] reconcile STOP — ${err.message}`);
    return 1;
  }

  // 4. The pure decision + the cap-guard + one atomic write.
  const result = reconcileLensText(text, fragment, priors);
  if (result.status === 'current') {
    log('[lens-region] lens section already current — nothing to do (zero-diff).');
    return 0;
  }
  if (result.status === 'custom') {
    log('[lens-region] lens section carries a custom edit — preserved verbatim.');
    log('[lens-region] note: the canonical planning/review lens has changed since this section was edited — compare it with the project methodology canon when convenient; your wording is never overwritten.');
    return 0;
  }
  // refreshed → cap-guard from the TARGET's own frontmatter, then atomic write.
  const maxLines = frontmatterMaxLines(text);
  if (maxLines === null) {
    log('[lens-region] note: no `maxLines` frontmatter on the target — the line-cap guard is skipped.');
  } else if (lineCount(result.text) > maxLines) {
    log(`[lens-region] refused — refreshing would push ${argv[1]} to ${lineCount(result.text)} lines (cap ${maxLines}); trim the file and re-run. Nothing was changed.`);
    return 0;
  }
  const tmp = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, result.text, 'utf8');
    await fs.rename(tmp, targetPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  log('[lens-region] refreshed the planning/review lens section to the current canon.');
  return 0;
};

const { pathToFileURL } = await import('node:url');
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) process.exitCode = await runCli(process.argv.slice(2));

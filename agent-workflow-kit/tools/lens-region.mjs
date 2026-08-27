#!/usr/bin/env node
// Heading-anchored region reconcile — the composition root's only mutation of a deployed
// `docs/ai/agent_rules.md`. TWO regions, one policy (refresh IFF the region's normalized body
// matches the current canon or a KNOWN PRIOR canonical body; anything else preserved
// byte-for-byte + a one-line advisory — the AD-025 discipline):
// - the planning/review/process-fidelity lens block (`### 2.x. Planning, review &
//   process-fidelity invariants`) — canon home: the installed engine's
//   `references/agent-rules-lens.md` + its append-only prior store, read live (no kit-side
//   prior constants, so a lens wording change is an engine-only release);
// - the Communication block (`### 2.x. Communication (user-facing messages)`, AD-061) — canon
//   home: the §2.5 region of the kit's OWN bundled `references/templates/agent_rules.md`
//   (byte-identical to the memory twin by the template-region parity guard); priors are inline
//   constants below (a templates/-side prior file would be deployed into projects by the
//   template loop), appended whenever the template region changes (the vintage rule).
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
// Pure string functions (fs only in the CLI); dependency-free, Node >= 22.

import { isDirectRun } from './direct-run.mjs';
import { normalizeCanonical } from './orchestration-config.mjs';

// The deployed-heading matcher (prefix, like the historical extractLensBlock: robust to a future
// heading-tail tweak) and the number-neutral form the engine fragment carries.
export const LENS_HEADING_RE = /^### 2\.(\d+)\. Planning, review & process-fidelity/;
const NEUTRAL_HEADING_RE = /^### 2\.x\. Planning, review & process-fidelity/;
const HEADING_LABEL = '### 2.x. Planning, review & process-fidelity invariants';
export const COMMS_HEADING_RE = /^### 2\.(\d+)\. Communication \(user-facing messages\)/;
const NEUTRAL_COMMS_RE = /^### 2\.x\. Communication \(user-facing messages\)/;
const COMMS_LABEL = '### 2.x. Communication (user-facing messages)';

// The known prior canonical bodies of the Communication region (neutral-headed, like the engine's
// lens prior store). Append the OUTGOING canon here in the same release that changes the template
// §2.5 region — the fragment-or-prior reconcile depends on it.
const COMMS_PRIOR_PRE_AD054 = `### 2.x. Communication (user-facing messages)
Apply this as part of §2 before any user-facing summary:
- **Deliver the artifact IN the message** — paste the prompt / diff / version / command inline; never "see §X / open the file / run it and you'll see" as a *substitute* for showing what was asked.
- **Lead with the result**, then the details; show exactly what was asked — no deflection, no "almost done" when the ask was the finished thing.
- **No condescension, no filler.** Own a miss plainly and fix it in the same message.
- **Large artifact (≈>100 lines):** deliver a real summary or the key excerpt inline **and** link the file — never flood the reader with a 2000-line paste, never hide the answer behind a bare pointer.`;
const COMMS_PRIOR_AD054 = `${COMMS_PRIOR_PRE_AD054}
- **Live host/session facts are tool-composed only.** Any claim about the current host or session state (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts) must trace to **live tool output** from **this session**; a memory/handover snapshot is **context, never report facts**, and a claim with no live signal is **omitted or explicitly marked unverified** — never asserted from recollection.`;
// The canon that shipped between the plain-language bullet and the closing-state-block contract.
// Written out in full rather than composed from the constant above: the plain-language bullet LEADS
// the block, so an append-based composition would produce a body that never shipped and would then
// match no deployed file at all.
const COMMS_PRIOR_PLAIN_LANGUAGE = `### 2.x. Communication (user-facing messages)
Apply this as part of §2 before any user-facing summary:
- **Plain language.** User-facing narration is short, clear, plain words of the dialogue language; when the dialogue language is not English, transliterated English jargon is banned — an English term survives only as the NAME of a thing (a flag / command / file / test), glossed in plain words when helpful; plain English stays plain for English-dialogue users.
- **Deliver the artifact IN the message** — paste the prompt / diff / version / command inline; never "see §X / open the file / run it and you'll see" as a *substitute* for showing what was asked.
- **Lead with the result**, then the details; show exactly what was asked — no deflection, no "almost done" when the ask was the finished thing.
- **No condescension, no filler.** Own a miss plainly and fix it in the same message.
- **Large artifact (≈>100 lines):** deliver a real summary or the key excerpt inline **and** link the file — never flood the reader with a 2000-line paste, never hide the answer behind a bare pointer.
- **Live host/session facts are tool-composed only.** Any claim about the current host or session state (prompts fired, sandbox scope, whether a bypass was needed, network reachability, approval counts) must trace to **live tool output** from **this session**; a memory/handover snapshot is **context, never report facts**, and a claim with no live signal is **omitted or explicitly marked unverified** — never asserted from recollection.`;
// The canon that shipped between the closing-state-block contract and the contradicted-skip bullet.
const COMMS_PRIOR_STATE_BLOCK = `${COMMS_PRIOR_PLAIN_LANGUAGE}
- **The closing state block answers three DIFFERENT questions.** Close a user-facing message with three labelled slots — *now* · *what I need from you* · *what's next*. The slot LABELS stay ENGLISH — an English label is what lets a state-block checker FIND the block and its slots at all; everything written INTO a slot is in the project's dialogue language; when that language is not English, the checker's English phrase sets do not judge those values. **Now** = the state at this instant: what is RUNNING, or what the work is stopped on. It is **never a report of finished work** — what you completed goes in the message BODY, above the block. **From you** = the real unblocker, named; a turn that is ENDING always has one. **Next** = what follows. A *now* slot that opens with what was completed buries the one fact the reader opened the message for, and the three slots collapse into one restatement.`;
export const COMMS_PRIORS = [COMMS_PRIOR_PRE_AD054, COMMS_PRIOR_AD054, COMMS_PRIOR_PLAIN_LANGUAGE, COMMS_PRIOR_STATE_BLOCK];

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
export const normalizeCommsBody = normalizeLensBody;
export const renderComms = (fragment, number) =>
  normalizeCanonical(fragment).replace(NEUTRAL_COMMS_RE, (m) => m.replace('2.x', `2.${number}`));

// extractLensRegion(text) → { found: false } | { found, start, end, number, body }.
// `start`/`end` are line indices over text.split('\n') — heading line through (exclusive) the
// next structural boundary; EOF is a valid region end (no following boundary required). `body`
// is the CR-stripped block with trailing blank lines dropped (the comparison form); the raw
// region lines (including trailing blanks) are what replaceLensRegion preserves around a render.
const extractRegionBy = (text, headingRe) => {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => headingRe.test(stripCr(line)));
  if (start === -1) return { found: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isBoundary(stripCr(lines[i]))) {
      end = i;
      break;
    }
  }
  const number = stripCr(lines[start]).match(headingRe)[1];
  const regionLines = lines.slice(start, end);
  let bodyEnd = regionLines.length;
  while (bodyEnd > 0 && stripCr(regionLines[bodyEnd - 1]).trim() === '') bodyEnd -= 1;
  const body = regionLines.slice(0, bodyEnd).map(stripCr).join('\n');
  return { found: true, start, end, number, body };
};
export const extractLensRegion = (text) => extractRegionBy(text, LENS_HEADING_RE);
export const extractCommsRegion = (text) => extractRegionBy(text, COMMS_HEADING_RE);

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
const reconcileRegionText = (text, fragment, priors, { extract, normalize, render }) => {
  const region = extract(text);
  if (!region.found) return { status: 'no-region', text };
  const current = normalize(region.body);
  const canon = normalize(fragment);
  if (current === canon) return { status: 'current', text };
  const known = priors.map((p) => normalize(p));
  if (!known.includes(current)) return { status: 'custom', text };
  return { status: 'refreshed', text: replaceLensRegion(text, region, render(fragment, region.number)) };
};
export const reconcileLensText = (text, fragment, priors) =>
  reconcileRegionText(text, fragment, priors, { extract: extractLensRegion, normalize: normalizeLensBody, render: renderLens });
export const reconcileCommsText = (text, fragment, priors) =>
  reconcileRegionText(text, fragment, priors, { extract: extractCommsRegion, normalize: normalizeCommsBody, render: renderComms });

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

// ── the outcome lines (pure composers — the CLI's one voice) ──────────────────────
// Every user-facing outcome line the CLI prints, one pure composer per outcome, so the
// composed-lines guard (test/composed-lines-ux.test.mjs) can render each against the L2
// user-grade invariants. runCli only ever prints through this table. Raw diagnostics never ride
// the human sentence: they land on the ONE machine-formatted detail line (`[lens-region]
// error=<JSON-encoded>` — one line, reversible, control bytes escaped), the `[tool] key=value`
// channel the L2 rule exempts by grammar. JSON.stringify leaves DEL/C1 and the U+2028/U+2029
// separators raw, and a dynamic path can carry any byte — both dynamic parts are therefore made
// line-safe explicitly: the machine value gains extra JSON escapes (still reversible), and the
// human line collapses every control/separator byte to one space.
const LINE_UNSAFE = new RegExp('[\\u007f-\\u009f\\u2028\\u2029]', 'g');
const HUMAN_UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');
const escUnsafe = (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`;
const ERROR_DETAIL = (raw) => `[lens-region] error=${JSON.stringify(String(raw)).replace(LINE_UNSAFE, escUnsafe)}`;
const oneLine = (s) => String(s).replace(HUMAN_UNSAFE, ' ');

export const OUTCOME_LINES = Object.freeze({
  errorDetail: ERROR_DETAIL,
  targetAbsent: (target) => `[lens-region] ${target} is absent — skipped (nothing to update; the file is seeded at bootstrap).`,
  commsNoRegion: (target) => [
    `[lens-region] no "${COMMS_LABEL}" section in ${target} — left untouched.`,
    '[lens-region] note: the Communication section is absent or renamed — deployments seeded before it existed simply lack it; add it from the current template to enable refresh. Your file is never rewritten.',
  ],
  commsCurrent: () => '[lens-region] Communication section already current — nothing to do (zero-diff).',
  commsCustom: () => [
    '[lens-region] Communication section carries a custom edit — preserved verbatim.',
    '[lens-region] note: the canonical Communication section has changed since this section was edited — compare it with the current template when convenient; your wording is never overwritten.',
  ],
  capSkipNote: () => '[lens-region] note: no `maxLines` frontmatter on the target — the line-cap guard is skipped.',
  commsCapRefused: (target, count, cap) => `[lens-region] refused — refreshing the Communication section would push ${target} to ${count} lines (cap ${cap}); trim the file and re-run. The Communication section was not changed.`,
  commsRefreshed: () => '[lens-region] refreshed the Communication section to the current canon.',
  templateCanonStop: () => `[lens-region] STOP — the kit's bundled agent_rules.md template canon is unreadable; reinstall the kit: npx @sabaiway/agent-workflow-kit@latest init`,
  lensNoRegion: (target) => [
    `[lens-region] no "${HEADING_LABEL}" section in ${target} — left untouched.`,
    '[lens-region] note: the planning/review lens section is missing or renamed — it cannot be auto-refreshed; restore the canonical heading to re-enable refresh.',
  ],
  engineTooOld: () => '[lens-region] skipped — the installed engine is too old (or incomplete) to supply the lens canon; refresh it with `npx @sabaiway/agent-workflow-engine@latest init`, then re-run.',
  // The human line keeps the classified "methodology engine not found/invalid" contract; a typed
  // error (engine-source attaches {stable, reason}) splits its raw reason onto the machine line.
  engineStop: (err) => {
    const human = `[lens-region] STOP — ${oneLine(err?.stable ?? err?.message ?? String(err))}`;
    return err?.reason ? [human, ERROR_DETAIL(err.reason)] : [human];
  },
  lensCurrent: () => '[lens-region] lens section already current — nothing to do (zero-diff).',
  lensCustom: () => [
    '[lens-region] lens section carries a custom edit — preserved verbatim.',
    '[lens-region] note: the canonical planning/review lens has changed since this section was edited — compare it with the project methodology canon when convenient; your wording is never overwritten.',
  ],
  lensCapRefused: (target, count, cap) => `[lens-region] refused — refreshing would push ${target} to ${count} lines (cap ${cap}); trim the file and re-run. The planning/review lens section was not changed.`,
  lensRefreshed: () => '[lens-region] refreshed the planning/review lens section to the current canon.',
});

// ── CLI: `lens-region.mjs reconcile <path/to/agent_rules.md>` ─────────────────────
// Outcome lines are the contract the upgrade/bootstrap prose relays in plain language; exit 0 on
// every classified outcome (including the soft skips and the cap refusals), exit 1 ONLY on a
// hard STOP — the absent/invalid engine, or the unreadable bundled template canon — or an
// unexpected fs error, exit 2 on usage.
export const runCli = async (argv, deps = {}) => {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? (await import('node:fs/promises'));
  const { dirname, basename, join, resolve } = await import('node:path');
  const { homedir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
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
    log(OUTCOME_LINES.targetAbsent(argv[1]));
    return 0;
  }

  const atomicWrite = async (content) => {
    const tmp = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(tmp, content, 'utf8');
      await fs.rename(tmp, targetPath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  };

  // 2. The Communication half (AD-061) — canon from the kit's OWN bundled template (the engine is
  //    never consulted for this region), same fragment-or-prior policy, own outcome lines.
  const templatePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'references', 'templates', 'agent_rules.md');
  const templateRegion = await (async () => {
    try {
      return extractCommsRegion(await fs.readFile(templatePath, 'utf8'));
    } catch (err) {
      return { found: false, error: err?.message ?? String(err) };
    }
  })();
  if (!templateRegion.found) {
    logError(OUTCOME_LINES.templateCanonStop());
    if (templateRegion.error) logError(OUTCOME_LINES.errorDetail(templateRegion.error));
    return 1;
  }
  const commsResult = reconcileCommsText(text, normalizeCommsBody(templateRegion.body), COMMS_PRIORS);
  const currentText = await (async () => {
    if (commsResult.status === 'no-region') {
      for (const line of OUTCOME_LINES.commsNoRegion(argv[1])) log(line);
      return text;
    }
    if (commsResult.status === 'current') {
      log(OUTCOME_LINES.commsCurrent());
      return text;
    }
    if (commsResult.status === 'custom') {
      for (const line of OUTCOME_LINES.commsCustom()) log(line);
      return text;
    }
    const commsMax = frontmatterMaxLines(text);
    if (commsMax === null) {
      log(OUTCOME_LINES.capSkipNote());
    }
    if (commsMax !== null && lineCount(commsResult.text) > commsMax) {
      log(OUTCOME_LINES.commsCapRefused(argv[1], lineCount(commsResult.text), commsMax));
      return text;
    }
    await atomicWrite(commsResult.text);
    log(OUTCOME_LINES.commsRefreshed());
    return commsResult.text;
  })();

  // 3. No matching lens heading → preserve + advise, engine never consulted (the outcome is
  //    preserve regardless, so the lazy contract holds).
  if (!extractLensRegion(currentText).found) {
    for (const line of OUTCOME_LINES.lensNoRegion(argv[1])) log(line);
    return 0;
  }

  // 3. A present region must be classified → live-read the engine's fragment + prior store.
  //    Fully absent/invalid engine → loud STOP; valid-but-pre-lens engine → stated soft skip.
  const { dir, source } = resolveEngineDir({ env, home: deps.home ?? homedir() });
  const lensPairPresent =
    detectEngine(dir, { source, rel: LENS_FRAGMENT_REL }).ok && detectEngine(dir, { source, rel: LENS_PRIORS_REL }).ok;
  if (!lensPairPresent) {
    if (detectEngine(dir, { source }).ok) {
      log(OUTCOME_LINES.engineTooOld());
      return 0;
    }
    try {
      readEngineFragment(dir, { source, rel: LENS_FRAGMENT_REL }); // throws the canonical install-me error
      return 1; // defensive: the pair is unusable — never proceed to a read
    } catch (err) {
      for (const line of OUTCOME_LINES.engineStop(err)) logError(line);
      return 1;
    }
  }
  // TOCTOU guard: a fragment that vanishes between detect and read is a corruption STOP, never a
  // silent proceed — readEngineFragment's own throw carries the install command.
  let fragment;
  let priors;
  try {
    // deps.engineRead is the injectable read primitive (tests drive the vanished/unreadable arm
    // deterministically — a chmod-based fixture is root- and platform-dependent).
    fragment = readEngineFragment(dir, { source, rel: LENS_FRAGMENT_REL, readFileSync: deps.engineRead });
    priors = parseLensPriors(readEngineFragment(dir, { source, rel: LENS_PRIORS_REL, readFileSync: deps.engineRead }));
  } catch (err) {
    for (const line of OUTCOME_LINES.engineStop(err)) logError(line);
    return 1;
  }

  // 5. The pure decision + the cap-guard + one atomic write.
  const result = reconcileLensText(currentText, fragment, priors);
  if (result.status === 'current') {
    log(OUTCOME_LINES.lensCurrent());
    return 0;
  }
  if (result.status === 'custom') {
    for (const line of OUTCOME_LINES.lensCustom()) log(line);
    return 0;
  }
  // refreshed → cap-guard from the TARGET's own frontmatter, then atomic write.
  const maxLines = frontmatterMaxLines(currentText);
  if (maxLines === null) {
    log(OUTCOME_LINES.capSkipNote());
  } else if (lineCount(result.text) > maxLines) {
    log(OUTCOME_LINES.lensCapRefused(argv[1], lineCount(result.text), maxLines));
    return 0;
  }
  await atomicWrite(result.text);
  log(OUTCOME_LINES.lensRefreshed());
  return 0;
};

if (isDirectRun(import.meta.url)) process.exitCode = await runCli(process.argv.slice(2));

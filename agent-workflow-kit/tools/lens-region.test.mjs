import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractLensRegion,
  renderLens,
  normalizeLensBody,
  parseLensPriors,
  reconcileLensText,
  replaceLensRegion,
  frontmatterMaxLines,
  runCli,
  extractCommsRegion,
  normalizeCommsBody,
  renderComms,
  reconcileCommsText,
  COMMS_PRIORS,
} from './lens-region.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', '..', 'agent-workflow-engine');
const FRAGMENT = readFileSync(join(ENGINE_DIR, 'references', 'agent-rules-lens.md'), 'utf8');
const PRIORS = parseLensPriors(readFileSync(join(ENGINE_DIR, 'references', 'agent-rules-lens-priors.md'), 'utf8'));
const PRE_E4 = PRIORS[PRIORS.length - 1]; // the outgoing pre-E4 body (the last appended entry)

const atNumber = (neutralBody, number) => neutralBody.replace('### 2.x.', `### 2.${number}.`);

// A deployed-file fixture: frontmatter (optional) + a preceding section + the lens region +
// a following section — the real agent_rules.md shape.
const doc = ({ body, maxLines = 150, frontmatter = true, after = '\n---\n\n## 3. Next\n\nprose\n' }) =>
  `${frontmatter ? `---\ntype: protocol\nmaxLines: ${maxLines}\n---\n\n` : ''}# Rules\n\n### 2.5. Something\n- a bullet\n\n${body}${after}`;

describe('lens-region — extraction (the promoted boundary rule)', () => {
  it('finds the region and captures the file’s own number; body drops trailing blanks', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6)}\n\n` });
    const region = extractLensRegion(text);
    assert.equal(region.found, true);
    assert.equal(region.number, '6');
    assert.equal(normalizeLensBody(region.body), PRE_E4);
  });

  it('a region ending at EOF (no following boundary) is a valid region', () => {
    const text = doc({ body: atNumber(PRE_E4, 6), after: '\n' });
    const region = extractLensRegion(text);
    assert.equal(region.found, true);
    assert.equal(normalizeLensBody(region.body), PRE_E4);
  });

  it('stops at each structural boundary kind (---, ##, ###)', () => {
    for (const boundary of ['---', '## 3. Next', '### 2.7. Next']) {
      const text = doc({ body: `${atNumber(PRE_E4, 6)}\n`, after: `\n${boundary}\nprose\n` });
      const region = extractLensRegion(text);
      assert.equal(normalizeLensBody(region.body), PRE_E4, `boundary "${boundary}"`);
    }
  });

  it('a renamed heading is not found (natural preserve+advise)', () => {
    const text = doc({ body: atNumber(PRE_E4, 6).replace('Planning, review & process-fidelity invariants', 'My own lenses') });
    assert.equal(extractLensRegion(text).found, false);
  });
});

describe('lens-region — render + pure reconcile policy', () => {
  it('renderLens binds the number-neutral heading to the file’s own number', () => {
    const rendered = renderLens(FRAGMENT, '5');
    assert.match(rendered.split('\n')[0], /^### 2\.5\. Planning, review & process-fidelity invariants$/);
    assert.equal(normalizeLensBody(rendered), normalizeLensBody(FRAGMENT));
  });

  it('the real engine prior store parses non-empty; every entry is a neutral-headed block', () => {
    assert.ok(PRIORS.length >= 1);
    for (const entry of PRIORS) assert.match(entry.split('\n')[0], /^### 2\.x\. Planning, review & process-fidelity/);
  });

  it('current render → status current (zero-diff)', () => {
    const text = doc({ body: `${renderLens(FRAGMENT, '6')}\n` });
    const out = reconcileLensText(text, FRAGMENT, PRIORS);
    assert.equal(out.status, 'current');
    assert.equal(out.text, text);
  });

  it('a known-prior body → refreshed to the current render at the SAME number', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6)}\n` });
    const out = reconcileLensText(text, FRAGMENT, PRIORS);
    assert.equal(out.status, 'refreshed');
    const region = extractLensRegion(out.text);
    assert.equal(region.number, '6', 'the file keeps its own section number');
    assert.equal(normalizeLensBody(region.body), normalizeLensBody(FRAGMENT));
  });

  it('a customized body → status custom, text unchanged byte-for-byte', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6).replace('Fold by code, not prose', 'Fold by vibes')}\n` });
    const out = reconcileLensText(text, FRAGMENT, PRIORS);
    assert.equal(out.status, 'custom');
    assert.equal(out.text, text);
  });

  it('bytes outside the region are byte-identical after a refresh', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6)}\n` });
    const out = reconcileLensText(text, FRAGMENT, PRIORS);
    const before = text.slice(0, text.indexOf('### 2.6.'));
    const afterMarker = '\n---\n\n## 3. Next';
    assert.ok(out.text.startsWith(before), 'prefix bytes preserved');
    assert.equal(out.text.slice(out.text.indexOf(afterMarker)), text.slice(text.indexOf(afterMarker)), 'suffix bytes preserved');
  });

  it('a CRLF document still matches and the output preserves CRLF', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6)}\n` }).replace(/\n/g, '\r\n');
    const out = reconcileLensText(text, FRAGMENT, PRIORS);
    assert.equal(out.status, 'refreshed');
    assert.ok(!/(^|[^\r])\n/.test(out.text), 'every LF in the output is part of a CRLF pair');
    assert.equal(normalizeLensBody(extractLensRegion(out.text).body), normalizeLensBody(FRAGMENT));
  });

  it('an EOF region refresh appends no stray bytes (LF and CRLF)', () => {
    for (const eol of ['\n', '\r\n']) {
      const text = doc({ body: atNumber(PRE_E4, 6), after: '' }).replace(/\n/g, eol);
      const out = reconcileLensText(text, FRAGMENT, PRIORS);
      assert.equal(out.status, 'refreshed', `eol ${JSON.stringify(eol)}`);
      assert.ok(!out.text.endsWith('\r'), 'no dangling CR at EOF');
      assert.equal(normalizeLensBody(extractLensRegion(out.text).body), normalizeLensBody(FRAGMENT));
    }
  });

  it('the canon-change simulation: a v1 body + a v2 fragment (v1 in priors) → refreshed; re-run → zero-diff', () => {
    const v1 = PRE_E4;
    const v2 = FRAGMENT;
    const text = doc({ body: `${atNumber(v1, 6)}\n` });
    const first = reconcileLensText(text, v2, [v1]);
    assert.equal(first.status, 'refreshed');
    const second = reconcileLensText(first.text, v2, [v1]);
    assert.equal(second.status, 'current');
    assert.equal(second.text, first.text, 'the second run is a zero-diff no-op');
  });

  it('non-vacuity: with an EMPTY prior set the same stale body is custom, not refreshed (injected)', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6)}\n` });
    assert.equal(reconcileLensText(text, FRAGMENT, []).status, 'custom');
  });
});

// ── the §2.5 Communication region reconcile (AD-061 — the upgrade-reach half) ───────────────────
const KIT_TEMPLATE_TEXT = readFileSync(join(HERE, '..', 'references', 'templates', 'agent_rules.md'), 'utf8');
const COMMS_CANON = normalizeCommsBody(extractCommsRegion(KIT_TEMPLATE_TEXT).body);
const commsAt = (neutralBody, number) => neutralBody.replace('### 2.x.', `### 2.${number}.`);
const commsDoc = ({ body, maxLines = 150, after = '\n### 2.6. Planning, review & process-fidelity invariants\n- lens body\n' }) =>
  `---\ntype: protocol\nmaxLines: ${maxLines}\n---\n\n# Rules\n\n### 2.4. Quality Gates\n- run tests\n\n${body}${after}`;

describe('comms-region — canon, priors, pure reconcile (AD-061)', () => {
  it('the kit template canon carries the plain-language bar and both known priors parse neutral-headed', () => {
    assert.ok(COMMS_CANON.includes('Plain language'), 'the canon carries the plain-language bullet');
    assert.equal(COMMS_PRIORS.length, 2, 'exactly the two known prior bodies (pre-AD-054, AD-054)');
    for (const prior of COMMS_PRIORS) {
      assert.match(prior.split('\n')[0], /^### 2\.x\. Communication \(user-facing messages\)/);
      assert.ok(!prior.includes('Plain language'), 'a prior predates the plain-language bullet');
    }
  });

  it('a legacy 4-bullet §2.5 (pre-AD-054) → refreshed to the canon at the SAME number', () => {
    const text = commsDoc({ body: `${commsAt(COMMS_PRIORS[0], 5)}\n` });
    const out = reconcileCommsText(text, COMMS_CANON, COMMS_PRIORS);
    assert.equal(out.status, 'refreshed');
    const region = extractCommsRegion(out.text);
    assert.equal(region.number, '5', 'the file keeps its own section number');
    assert.equal(normalizeCommsBody(region.body), COMMS_CANON);
  });

  it('a legacy 5-bullet §2.5 (AD-054) → refreshed; re-run → zero-diff current', () => {
    const text = commsDoc({ body: `${commsAt(COMMS_PRIORS[1], 5)}\n` });
    const first = reconcileCommsText(text, COMMS_CANON, COMMS_PRIORS);
    assert.equal(first.status, 'refreshed');
    const second = reconcileCommsText(first.text, COMMS_CANON, COMMS_PRIORS);
    assert.equal(second.status, 'current');
    assert.equal(second.text, first.text);
  });

  it('a customized §2.5 → preserved byte-for-byte (custom)', () => {
    const text = commsDoc({ body: `${commsAt(COMMS_PRIORS[0], 5).replace('Lead with the result', 'Bury the result')}\n` });
    const out = reconcileCommsText(text, COMMS_CANON, COMMS_PRIORS);
    assert.equal(out.status, 'custom');
    assert.equal(out.text, text);
  });

  it('renderComms binds the neutral heading to the file’s own number', () => {
    assert.match(renderComms(COMMS_CANON, '5').split('\n')[0], /^### 2\.5\. Communication \(user-facing messages\)$/);
  });
});

describe('comms-region — CLI reconcile (the legacy-deployment upgrade acceptance)', () => {
  let projectDir;
  let logs;
  let errors;
  const deps = (engineDir) => ({
    log: (l) => logs.push(l),
    logError: (l) => errors.push(l),
    env: { AGENT_WORKFLOW_ENGINE_DIR: engineDir },
  });
  const target = () => join(projectDir, 'agent_rules.md');
  const run = (engineDir = ENGINE_DIR) => runCli(['reconcile', target()], deps(engineDir));

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'comms-region-'));
    logs = [];
    errors = [];
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it('a legacy deployment (4-bullet §2.5 + prior lens) leaves upgrade with the plain-language bar present', async () => {
    writeFileSync(target(), `---\ntype: protocol\nmaxLines: 150\n---\n\n# Rules\n\n### 2.4. Quality Gates\n- run tests\n\n${commsAt(COMMS_PRIORS[0], 5)}\n\n${atNumber(PRE_E4, 6)}\n\n---\n\n## 3. Next\n\nprose\n`);
    assert.equal(await run(), 0);
    const upgraded = readFileSync(target(), 'utf8');
    assert.equal(normalizeCommsBody(extractCommsRegion(upgraded).body), COMMS_CANON, 'the bar landed');
    assert.equal(normalizeLensBody(extractLensRegion(upgraded).body), normalizeLensBody(FRAGMENT), 'the lens half still refreshes');
    assert.ok(logs.some((l) => l.includes('refreshed the Communication section')), logs.join('\n'));
  });

  it('a deployment with NO Communication section (kit-fallback vintage) → stated note, file preserved, lens half unaffected', async () => {
    const text = `---\ntype: protocol\nmaxLines: 150\n---\n\n# Rules\n\n${renderLens(FRAGMENT, 5)}\n\n---\n\n## 3. Next\n\nprose\n`;
    writeFileSync(target(), text);
    assert.equal(await run(), 0);
    assert.equal(readFileSync(target(), 'utf8'), text, 'nothing rewritten');
    assert.ok(logs.some((l) => l.includes('no "### 2.x. Communication')), logs.join('\n'));
  });

  it('a customized §2.5 at the CLI → preserved verbatim + advisory note', async () => {
    const custom = commsDoc({ body: `${commsAt(COMMS_PRIORS[0], 5).replace('Lead with the result', 'Bury the result')}\n` });
    writeFileSync(target(), custom);
    assert.equal(await run(), 0);
    assert.equal(readFileSync(target(), 'utf8'), custom);
    assert.ok(logs.some((l) => l.includes('Communication section carries a custom edit')), logs.join('\n'));
  });

  it('an over-cap Communication refresh → loud refusal, exit 0, file preserved', async () => {
    const text = commsDoc({ body: `${commsAt(COMMS_PRIORS[0], 5)}\n`, maxLines: 5 });
    writeFileSync(target(), text);
    assert.equal(await run(), 0);
    assert.equal(readFileSync(target(), 'utf8'), text, 'nothing written');
    assert.ok(logs.some((l) => l.includes('The Communication section was not changed')), logs.join('\n'));
  });

  it('no frontmatter maxLines → the comms cap-guard is skipped with a stated note, refresh proceeds', async () => {
    const text = `# Rules\n\n${commsAt(COMMS_PRIORS[0], 5)}\n\n---\n\n## 3. Next\n\nprose\n`;
    writeFileSync(target(), text);
    assert.equal(await run(), 0);
    assert.ok(logs.some((l) => l.includes('line-cap guard is skipped')), logs.join('\n'));
    assert.equal(normalizeCommsBody(extractCommsRegion(readFileSync(target(), 'utf8')).body), COMMS_CANON);
  });

  it('an unreadable bundled template canon → loud STOP, exit 1, naming the kit reinstall', async () => {
    const realFs = await import('node:fs/promises');
    const fsBrokenTemplate = {
      ...realFs,
      readFile: (p, ...rest) => (String(p).includes('references/templates/agent_rules.md')
        ? Promise.reject(new Error('EACCES: permission denied'))
        : realFs.readFile(p, ...rest)),
    };
    writeFileSync(target(), commsDoc({ body: `${commsAt(COMMS_PRIORS[0], 5)}\n` }));
    const code = await runCli(['reconcile', target()], { ...deps(ENGINE_DIR), fs: fsBrokenTemplate });
    assert.equal(code, 1);
    assert.ok(errors.some((l) => l.includes('template canon is unreadable')), errors.join('\n'));
    assert.ok(errors.some((l) => l.includes('npx @sabaiway/agent-workflow-kit@latest init')), 'the STOP names the reinstall');
  });

  it('a write failure mid Communication refresh cleans the temp file and surfaces the error', async () => {
    const realFs = await import('node:fs/promises');
    const fsRenameFail = { ...realFs, rename: async () => { throw new Error('EIO: rename failed'); } };
    const text = commsDoc({ body: `${commsAt(COMMS_PRIORS[0], 5)}\n` });
    writeFileSync(target(), text);
    await assert.rejects(runCli(['reconcile', target()], { ...deps(ENGINE_DIR), fs: fsRenameFail }), /EIO/);
    assert.equal(readFileSync(target(), 'utf8'), text, 'the target is untouched');
    const leftovers = readdirSync(projectDir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no temp file may be left behind');
  });
});

describe('lens-region — frontmatter cap guard input', () => {
  it('parses maxLines from the frontmatter block', () => {
    assert.equal(frontmatterMaxLines('---\ntype: x\nmaxLines: 150\n---\nbody\n'), 150);
  });
  it('no frontmatter / no maxLines → null (guard skipped by the caller)', () => {
    assert.equal(frontmatterMaxLines('# no frontmatter\n'), null);
    assert.equal(frontmatterMaxLines('---\ntype: x\n---\nbody\n'), null);
  });
  it('a maxLines BELOW the frontmatter block is not frontmatter', () => {
    assert.equal(frontmatterMaxLines('---\ntype: x\n---\nmaxLines: 5\n'), null);
  });
});

describe('lens-region — CLI reconcile (live engine read, outcomes, atomic write)', () => {
  let projectDir;
  let logs;
  let errors;
  const deps = (engineDir) => ({
    log: (l) => logs.push(l),
    logError: (l) => errors.push(l),
    env: { AGENT_WORKFLOW_ENGINE_DIR: engineDir },
  });
  const target = () => join(projectDir, 'agent_rules.md');
  const run = (engineDir = ENGINE_DIR) => runCli(['reconcile', target()], deps(engineDir));

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'lens-region-'));
    logs = [];
    errors = [];
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  const noTempLeftover = () => {
    const leftovers = readdirSync(projectDir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no temp file may be left behind');
  };

  it('refreshes a known-prior body from the real engine, then reports already-current on re-run', async () => {
    writeFileSync(target(), doc({ body: `${atNumber(PRE_E4, 6)}\n` }));
    assert.equal(await run(), 0);
    assert.ok(logs.some((l) => l.includes('refreshed the planning/review lens section')), logs.join('\n'));
    const refreshed = readFileSync(target(), 'utf8');
    assert.equal(normalizeLensBody(extractLensRegion(refreshed).body), normalizeLensBody(FRAGMENT));
    noTempLeftover();

    logs = [];
    assert.equal(await run(), 0);
    assert.ok(logs.some((l) => l.includes('already current')), logs.join('\n'));
    assert.equal(readFileSync(target(), 'utf8'), refreshed, 'the re-run is a zero-diff no-op');
  });

  it('preserves a customized body verbatim and prints the advisory note', async () => {
    const custom = doc({ body: `${atNumber(PRE_E4, 6).replace('Fold by code', 'Fold by hand')}\n` });
    writeFileSync(target(), custom);
    assert.equal(await run(), 0);
    assert.equal(readFileSync(target(), 'utf8'), custom);
    assert.ok(logs.some((l) => l.includes('custom edit — preserved verbatim')), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('note:')), 'the advisory note is printed');
  });

  it('an absent or renamed heading → left untouched + advisory (engine never needed)', async () => {
    const renamed = doc({ body: `${atNumber(PRE_E4, 6).replace('Planning, review & process-fidelity invariants', 'My lenses')}\n` });
    writeFileSync(target(), renamed);
    assert.equal(await run(join(projectDir, 'no-engine-here')), 0, 'succeeds even with no engine (lazy)');
    assert.equal(readFileSync(target(), 'utf8'), renamed);
    assert.ok(logs.some((l) => l.includes('left untouched')), logs.join('\n'));
  });

  it('an absent file is a stated skip, exit 0', async () => {
    assert.equal(await run(), 0);
    assert.ok(logs.some((l) => l.includes('absent — skipped')), logs.join('\n'));
  });

  it('engine fully absent + a region to classify → loud STOP (exit 1) with the install command', async () => {
    writeFileSync(target(), doc({ body: `${atNumber(PRE_E4, 6)}\n` }));
    assert.equal(await run(join(projectDir, 'no-engine-here')), 1);
    assert.ok(errors.some((l) => l.includes('methodology engine not found/invalid')), errors.join('\n'));
    assert.ok(errors.some((l) => l.includes('npx @sabaiway/agent-workflow-engine@latest init')), 'the STOP carries the install command');
  });

  it('a valid engine WITHOUT the lens pair (too old) → stated soft skip, exit 0, file untouched', async () => {
    const oldEngine = join(projectDir, 'old-engine');
    cpSync(ENGINE_DIR, oldEngine, { recursive: true, filter: (src) => !src.includes('node_modules') });
    rmSync(join(oldEngine, 'references', 'agent-rules-lens.md'));
    rmSync(join(oldEngine, 'references', 'agent-rules-lens-priors.md'));
    const before = doc({ body: `${atNumber(PRE_E4, 6)}\n` });
    writeFileSync(target(), before);
    assert.equal(await run(oldEngine), 0);
    assert.equal(readFileSync(target(), 'utf8'), before);
    assert.ok(logs.some((l) => l.includes('too old (or incomplete)')), logs.join('\n'));
  });

  it('cap overflow → loud refusal, exit 0, nothing written', async () => {
    const before = doc({ body: `${atNumber(PRE_E4, 6)}\n`, maxLines: 10 });
    writeFileSync(target(), before);
    assert.equal(await run(), 0);
    assert.equal(readFileSync(target(), 'utf8'), before, 'an over-cap refresh changes nothing');
    assert.ok(logs.some((l) => l.includes('refused') && l.includes('(cap 10)')), logs.join('\n'));
    noTempLeftover();
  });

  it('no frontmatter maxLines → the cap-guard is skipped with a stated note, refresh proceeds', async () => {
    writeFileSync(target(), doc({ body: `${atNumber(PRE_E4, 6)}\n`, frontmatter: false }));
    assert.equal(await run(), 0);
    assert.ok(logs.some((l) => l.includes('cap guard is skipped') || l.includes('cap-guard') || l.includes('line-cap guard is skipped')), logs.join('\n'));
    assert.equal(normalizeLensBody(extractLensRegion(readFileSync(target(), 'utf8')).body), normalizeLensBody(FRAGMENT));
  });

  it('the canon-change simulation end-to-end: a v2 fixture engine refreshes a v1 deploy; re-run zero-diff', async () => {
    const fixtureEngine = join(projectDir, 'v2-engine');
    cpSync(ENGINE_DIR, fixtureEngine, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const v2 = FRAGMENT.replace('Fold by code, not prose.', 'Fold by code, not prose (v2).');
    writeFileSync(join(fixtureEngine, 'references', 'agent-rules-lens.md'), v2);
    writeFileSync(
      join(fixtureEngine, 'references', 'agent-rules-lens-priors.md'),
      `header prose\n\n<!-- prior: v1 -->\n${FRAGMENT}\n<!-- prior: pre-E4 -->\n${PRE_E4}\n`,
    );
    writeFileSync(target(), doc({ body: `${renderLens(FRAGMENT, '6')}\n` })); // a v1 deploy
    assert.equal(await run(fixtureEngine), 0);
    assert.equal(normalizeLensBody(extractLensRegion(readFileSync(target(), 'utf8')).body), normalizeLensBody(v2));
    logs = [];
    assert.equal(await run(fixtureEngine), 0);
    assert.ok(logs.some((l) => l.includes('already current')), 'the second run is a zero-diff no-op');
  });

  it('usage: a missing/extra arg exits 2', async () => {
    assert.equal(await runCli([], deps(ENGINE_DIR)), 2);
    assert.equal(await runCli(['reconcile'], deps(ENGINE_DIR)), 2);
    assert.equal(await runCli(['reconcile', 'a', 'b'], deps(ENGINE_DIR)), 2);
  });
});

describe('lens-region — replaceLensRegion trailing-blank preservation', () => {
  it('trailing blank lines inside the region survive a replace verbatim', () => {
    const text = doc({ body: `${atNumber(PRE_E4, 6)}\n\n\n` });
    const region = extractLensRegion(text);
    const out = replaceLensRegion(text, region, renderLens(FRAGMENT, '6'));
    assert.ok(out.includes('\n\n\n---\n'), 'the blank-line run before the boundary is preserved');
  });
  it('a mid-document file stat sanity: fixture engine copies stay directories (guard the cp filter)', () => {
    assert.ok(statSync(join(ENGINE_DIR, 'references')).isDirectory());
  });
});

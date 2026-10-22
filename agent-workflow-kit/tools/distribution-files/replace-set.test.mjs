// replace-set.test.mjs — the ONE replace set an upgrade binds: its digest pinned to the bytes an
// earlier release printed, the block over it line by line, the replace run over injected owning ops
// in real temp projects (survey, refusal, race, keep-aside, ops in order, index last), and the door.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const leaf = await import('./replace-set.mjs').catch(() => ({}));
const door = await import('./index.mjs').catch(() => ({}));
const scriptsLeaf = await import('./scripts.mjs').catch(() => ({}));
const { replaceSetDigest, keptAsidePath, replaceBlock, runReplace } = leaf;

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(HERE, '..', '..');
const sha = (body) => createHash('sha256').update(body).digest('hex');
const CHANNEL = 'a script or suite of your own under its own name in scripts/, or a config the script reads';
const edited = (rel, body, channel = CHANNEL) => ({ rel, sha256: sha(body), bytes: Buffer.from(body), channel });
const absent = (rel, channel = CHANNEL) => ({ rel, absent: true, channel });
const A = edited('scripts/a.mjs', '// a\n');
const B = edited('scripts/B.mjs', '// B\n');
const C = absent('scripts/c.mjs');
const TWO = 'c781e6af99b2c0c7d636c1fe4df6f50eb3fe3ec2d666a6ab67d8767afabc8a2c';
const THREE = '894e0a693ca2161337784409f363c81b719833e953df5db444b48bec2ae204c2';
const INDEX_NOT_RUN = 'the navigator step did not run: a replace run runs it only after every step it re-runs succeeds';
const HOOK_RUN = '; the commit hook runs it, so it may stop the next commit';
const marked = (entry) => ({ ...entry, hookRun: true });
const RACE = 'race-unresolved — the files to replace changed since the replace line was printed (another set or other bytes), so nothing was written — ask the user again over the fresh block below';
const IGNORE_REFUSED = 'write-refused — .agent-workflow/.gitignore: holds other bytes — it must hold exactly "*" and a line feed, so git sees no kept-aside copy; nothing was kept aside or replaced';

describe('spec:distribution-files/S1 the digest binds the set and its bytes', () => {
  it('two edited entries handed out of code-unit order give the digest HEAD printed', () => {
    assert.equal(replaceSetDigest([A, B]), TWO);
    assert.equal(replaceSetDigest([A, B]), sha(`scripts/B.mjs ${B.sha256}\nscripts/a.mjs ${A.sha256}`));
  });

  it('an absent entry contributes its rel and the word absent', () => {
    const lines = [`scripts/B.mjs ${B.sha256}`, `scripts/a.mjs ${A.sha256}`, 'scripts/c.mjs absent'];
    assert.equal(replaceSetDigest([C, A, B]), sha(lines.join('\n')));
    assert.equal(replaceSetDigest([C, A, B]), THREE);
  });

  it('reads only rel, sha256 and the absent mark', () => {
    const moved = { ...A, bytes: Buffer.from('// other\n'), channel: 'elsewhere' };
    assert.equal(replaceSetDigest([moved, B]), TWO);
    assert.equal(replaceSetDigest([moved, B, { ...C, channel: 'elsewhere' }]), THREE);
    assert.equal(replaceSetDigest([marked(A), B]), TWO);
    assert.equal(replaceSetDigest([marked(C), marked(A), marked(B)]), THREE);
  });
});

describe('spec:distribution-files/S2 the kept-aside path and the replace block', () => {
  it('keptAsidePath is the reserved folder, the first 16 hex of the digest and the rel', () => {
    assert.equal(keptAsidePath(THREE, 'scripts/a.mjs'), '.agent-workflow/kept-aside/894e0a693ca21613/scripts/a.mjs');
  });

  it('one line per entry in rel order, then the one command line with the paths quoted where needed', () => {
    const own = { ...B, channel: 'a config of your own' };
    assert.deepEqual(replaceBlock([C, A, own], { kitRoot: '/kit root', cwd: '/proj' }), [
      "scripts/B.mjs: carries an edit — on the user's yes it is kept aside at .agent-workflow/kept-aside/894e0a693ca21613/scripts/B.mjs, then the bundled body replaces it; an edit meant to last goes in a config of your own",
      `scripts/a.mjs: carries an edit — on the user's yes it is kept aside at .agent-workflow/kept-aside/894e0a693ca21613/scripts/a.mjs, then the bundled body replaces it; an edit meant to last goes in ${CHANNEL}`,
      "scripts/c.mjs: absent — the user's yes places the bundled body",
      `only on the user's yes, keep aside and replace the files named above: node '/kit root/tools/ensure-configs.mjs' --reconcile --replace-custom ${THREE} --cwd /proj`,
    ]);
  });

  it('a project path with a space is quoted, a plain kit path is not', () => {
    const block = replaceBlock([A], { kitRoot: '/kit', cwd: '/my proj' });
    assert.equal(block.at(-1), `only on the user's yes, keep aside and replace the files named above: node /kit/tools/ensure-configs.mjs --reconcile --replace-custom ${replaceSetDigest([A])} --cwd '/my proj'`);
  });

  it('an entry marked hookRun, edited or absent, ends its line with the hook-run clause; an unmarked one does not', () => {
    assert.deepEqual(replaceBlock([marked(C), marked(A), B], { kitRoot: '/kit', cwd: '/proj' }), [
      `scripts/B.mjs: carries an edit — on the user's yes it is kept aside at .agent-workflow/kept-aside/894e0a693ca21613/scripts/B.mjs, then the bundled body replaces it; an edit meant to last goes in ${CHANNEL}`,
      `scripts/a.mjs: carries an edit — on the user's yes it is kept aside at .agent-workflow/kept-aside/894e0a693ca21613/scripts/a.mjs, then the bundled body replaces it; an edit meant to last goes in ${CHANNEL}${HOOK_RUN}`,
      `scripts/c.mjs: absent — the user's yes places the bundled body${HOOK_RUN}`,
      `only on the user's yes, keep aside and replace the files named above: node /kit/tools/ensure-configs.mjs --reconcile --replace-custom ${THREE} --cwd /proj`,
    ]);
  });

  it('an empty set prints no line', () => {
    assert.deepEqual(replaceBlock([], { kitRoot: '/kit', cwd: '/proj' }), []);
  });
});

const withProject = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'replace-set-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const outcomeOf = (op, { failed = false, entries } = {}) => ({
  op,
  token: failed ? 'failed' : 'refreshed',
  failed,
  lines: [`${op}: ${failed ? 'stopped' : 'ran'}`],
  ...(entries ? { entries } : {}),
});
// A fake owning op: every call recorded as [op, dryRun, replace]; a survey returns `survey`, a real
// run returns real(args) or a plain success.
const fakeOp = (calls, op, survey, real = () => outcomeOf(op)) => ({
  op,
  run: (args) => {
    calls.push([op, args.dryRun, args.replace]);
    return args.dryRun ? survey : real(args);
  },
});
const INDEX_OUTCOME = outcomeOf('index');
const fakeIndex = (calls) => (args) => {
  calls.push(['index', args.dryRun, args.replace]);
  return INDEX_OUTCOME;
};
const replaceRun = (dir, calls, owning, digest) => runReplace({ cwd: dir, kitRoot: KIT_ROOT, digest, owning, index: fakeIndex(calls), deps: {} });
const reserved = (dir) => existsSync(join(dir, '.agent-workflow'));
const keptAt = (dir, digest, entry) => join(dir, keptAsidePath(digest, entry.rel));
const refusal = (op) => ({ op, token: 'failed', failed: true, lines: [`wrong-node-kind — ${op}: exists but is a symlink`] });
const notRun = (outcome) => ({ ...outcome, lines: [...outcome.lines, INDEX_NOT_RUN] });
const SURVEYS = [['scripts', true, undefined], ['specs', true, undefined]];

describe('spec:distribution-files/S4 the replace run over the owning ops', () => {
  it('(a) every owning op is surveyed without a write before any real run', () => withProject((dir) => {
    const calls = [];
    const owning = [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [B] })), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [A] }))];
    replaceRun(dir, calls, owning, replaceSetDigest([A, B]));
    assert.deepEqual(calls.slice(0, 2), [['scripts', true, undefined], ['specs', true, undefined]]);
    assert.ok(calls.slice(2).every(([, dryRun]) => dryRun !== true));
  }));

  it('(b) a refused survey takes no part: its outcome once, the other op replaces its bound files, no index, the navigator line once on the last failed outcome', () => withProject((dir) => {
    const calls = [];
    const digest = replaceSetDigest([B]);
    const owning = [fakeOp(calls, 'scripts', refusal('scripts')), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [B] }))];
    const { outcomes, block } = replaceRun(dir, calls, owning, digest);
    assert.deepEqual(outcomes, [notRun(refusal('scripts')), outcomeOf('specs')]);
    assert.deepEqual(calls, [...SURVEYS, ['specs', false, { digest, entries: [B] }]]);
    assert.ok(readFileSync(keptAt(dir, digest, B)).equals(B.bytes));
    assert.deepEqual(block, []);

    const none = [];
    const both = replaceRun(dir, none, [fakeOp(none, 'scripts', refusal('scripts')), fakeOp(none, 'specs', refusal('specs'))], digest);
    assert.deepEqual(both.outcomes, [refusal('scripts'), notRun(refusal('specs'))]);
    assert.deepEqual(none, SURVEYS);
  }));

  it('(b) a survey that failed after completing stops the run with its own outcome: no copy, no op run, no index', () => withProject((dir) => {
    const calls = [];
    const failed = outcomeOf('scripts', { failed: true, entries: [A] });
    const owning = [fakeOp(calls, 'scripts', failed), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [B] }))];
    const { outcomes, block } = replaceRun(dir, calls, owning, replaceSetDigest([A, B]));
    assert.deepEqual(outcomes, [notRun(failed)]);
    assert.deepEqual(block, []);
    assert.deepEqual(calls, SURVEYS);
    assert.equal(reserved(dir), false);
  }));

  it('(c) an empty union runs every op under the replace with an empty bound list, then index; an op that then fails leaves the later op and index unrun', () => withProject((dir) => {
    const calls = [];
    const digest = 'f'.repeat(64);
    const replace = { digest, entries: [] };
    const owning = [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [] })), fakeOp(calls, 'specs', outcomeOf('specs'))];
    const { outcomes, block } = replaceRun(dir, calls, owning, digest);
    assert.deepEqual(calls, [...SURVEYS, ['scripts', false, replace], ['specs', false, replace], ['index', false, undefined]]);
    assert.deepEqual(outcomes, [outcomeOf('scripts'), outcomeOf('specs'), INDEX_OUTCOME]);
    assert.deepEqual(block, []);

    const again = [];
    const raced = { ...outcomeOf('scripts', { failed: true, entries: [A] }), lines: ['race-unresolved — the kit scripts to place or replace are not the set the yes was given for (another set or other bytes), so nothing was written'] };
    const stopped = replaceRun(dir, again, [fakeOp(again, 'scripts', outcomeOf('scripts', { entries: [] }), () => raced), fakeOp(again, 'specs', outcomeOf('specs'))], digest);
    assert.deepEqual(stopped.outcomes, [notRun(raced)]);
    assert.deepEqual(again, [...SURVEYS, ['scripts', false, replace]]);
    assert.equal(reserved(dir), false);
  }));

  it('(d) a differing digest writes nothing: one race outcome for the first op taking part and a fresh block', () => withProject((dir) => {
    const calls = [];
    const older = replaceSetDigest([edited('scripts/a.mjs', '// older\n'), B, C]);
    const owning = [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [B] })), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [A, C] }))];
    const { outcomes, block } = replaceRun(dir, calls, owning, older);
    assert.deepEqual(outcomes.map(({ op, failed, lines }) => [op, failed, lines[0], lines.at(-1)]), [['scripts', true, RACE, INDEX_NOT_RUN]]);
    assert.deepEqual(block, [B, A, C]);
    assert.deepEqual(calls, SURVEYS);

    const later = [];
    const split = replaceRun(dir, later, [fakeOp(later, 'scripts', refusal('scripts')), fakeOp(later, 'specs', outcomeOf('specs', { entries: [A, C] }))], older);
    assert.deepEqual(split.outcomes[0], refusal('scripts'));
    assert.deepEqual(split.outcomes.slice(1).map(({ op, failed, lines }) => [op, failed, lines[0], lines.at(-1)]), [['specs', true, RACE, INDEX_NOT_RUN]]);
    assert.deepEqual(split.block, [A, C]);
    assert.deepEqual(later, SURVEYS);
    assert.equal(reserved(dir), false);
  }));

  it('(e) a match keeps every edit aside before the first op, runs the ops in order, then index', () => withProject((dir) => {
    const calls = [];
    const digest = replaceSetDigest([B, A, C]);
    const seen = [];
    const firstReal = () => {
      for (const entry of [A, B]) seen.push(readFileSync(keptAt(dir, digest, entry)).equals(entry.bytes));
      return outcomeOf('scripts');
    };
    const owning = [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [B] }), firstReal), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [A, C] }))];
    const { outcomes, block } = replaceRun(dir, calls, owning, digest);
    assert.deepEqual(seen, [true, true]);
    assert.deepEqual(calls.slice(2), [['scripts', false, { digest, entries: [B] }], ['specs', false, { digest, entries: [A, C] }], ['index', false, undefined]]);
    assert.deepEqual(outcomes, [outcomeOf('scripts'), outcomeOf('specs'), INDEX_OUTCOME]);
    assert.deepEqual(block, []);
  }));

  it('(f) a match whose second op fails leaves index unrun and ends that op with the navigator line', () => withProject((dir) => {
    const calls = [];
    const digest = replaceSetDigest([A, B]);
    const failing = outcomeOf('specs', { failed: true, entries: [A] });
    const owning = [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [B] })), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [A] }), () => failing)];
    const { outcomes, block } = replaceRun(dir, calls, owning, digest);
    assert.deepEqual(outcomes, [outcomeOf('scripts'), notRun(failing)]);
    assert.ok(!calls.some(([op]) => op === 'index'));
    assert.deepEqual(block, []);
  }));

  it('(g) a keep-aside failure runs no op and no index', () => withProject((dir) => {
    const calls = [];
    mkdirSync(join(dir, '.agent-workflow'));
    writeFileSync(join(dir, '.agent-workflow', '.gitignore'), '!kept-aside/\n');
    const owning = [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [B] })), fakeOp(calls, 'specs', outcomeOf('specs', { entries: [A] }))];
    const { outcomes, block } = replaceRun(dir, calls, owning, replaceSetDigest([A, B]));
    assert.deepEqual(outcomes.map(({ op, failed, lines }) => [op, failed, lines[0], lines.at(-1)]), [['scripts', true, IGNORE_REFUSED, INDEX_NOT_RUN]]);
    assert.deepEqual(calls, SURVEYS);
    assert.deepEqual(block, []);
    assert.equal(existsSync(join(dir, '.agent-workflow', 'kept-aside')), false);
    assert.equal(readFileSync(join(dir, '.agent-workflow', '.gitignore'), 'utf8'), '!kept-aside/\n');
  }));

  it('(h) an absent entry gets no copy', () => withProject((dir) => {
    const calls = [];
    const digest = replaceSetDigest([A, C]);
    replaceRun(dir, calls, [fakeOp(calls, 'scripts', outcomeOf('scripts', { entries: [A, C] }))], digest);
    assert.ok(readFileSync(keptAt(dir, digest, A)).equals(A.bytes));
    assert.equal(existsSync(keptAt(dir, digest, C)), false);
    assert.deepEqual(readdirSync(dirname(keptAt(dir, digest, A))), ['a.mjs']);
  }));
});

const DIR = HERE + sep;
const DOOR = join(HERE, 'index.mjs');
const doorNames = (source) => [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/distribution-files\/index\.mjs['"]/g)]
  .flatMap((match) => match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean));
const specifiers = (source) => [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? match[2]);
const kitModules = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return full + sep === DIR ? [] : kitModules(full);
  return entry.isFile() && entry.name.endsWith('.mjs') ? [full] : [];
});

describe('spec:distribution-files/S5 one directory, one door', () => {
  it('the index re-exports what the two consumers import, ensureScripts and SCRIPT_CHANNEL among them, each the very export of its leaf; no module of the directory imports either consumer', () => {
    const consumers = ['ensure-configs.mjs', 'ensure-specs.mjs'].map((name) => join(KIT_ROOT, 'tools', name));
    const imported = consumers.map((file) => doorNames(readFileSync(file, 'utf8')));
    for (const names of imported) assert.ok(names.length > 0, 'each consumer imports the door');
    assert.deepEqual(['SCRIPT_CHANNEL', 'ensureScripts'].filter((name) => !(name in door)), []);
    assert.deepEqual(Object.keys(door).sort(), [...new Set(imported.flat())].sort());
    for (const name of Object.keys(door)) {
      assert.equal(door[name], (name === 'ensureScripts' || name === 'SCRIPT_CHANNEL' ? scriptsLeaf : leaf)[name], name);
      if (name !== 'SCRIPT_CHANNEL') assert.equal(typeof door[name], 'function', name);
    }
    assert.equal(door.SCRIPT_CHANNEL, CHANNEL);
    const inward = readdirSync(HERE).filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')).flatMap((name) => specifiers(readFileSync(join(HERE, name), 'utf8'))
      .filter((spec) => consumers.includes(resolve(HERE, spec))).map((spec) => `${name} → ${spec}`));
    assert.deepEqual(inward, []);
  });

  it('no kit module outside the directory imports a file of it but the index', () => {
    const viaDoor = [];
    const offenders = [];
    for (const file of kitModules(KIT_ROOT)) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = resolve(dirname(file), spec);
        if (target === DOOR) viaDoor.push(file);
        else if (target.startsWith(DIR)) offenders.push(`${file} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
    for (const name of ['ensure-configs.mjs', 'ensure-specs.mjs']) assert.ok(viaDoor.includes(join(KIT_ROOT, 'tools', name)), name);
  });
});

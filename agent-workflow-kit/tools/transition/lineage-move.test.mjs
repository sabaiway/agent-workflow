// Contract transition, part lineage-move: the deployment-lineage head moves 4.0.0 → 5.0.0 in every copy
// together, the kit ships the 5.0.0 note and the selector lists it, the shipped profile's lineage stays
// 4.0.0 so every recorded decline stays current, and upgrade step 6 relays a note's refusal.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION as SELECTOR_HEAD } from '../cheap-agents-read.mjs';
import { EXPECTED_WORKFLOW_VERSION } from '../velocity-profile.mjs';
import { main as listNotes } from '../migration-notes.mjs';
import { isDeclineCurrent, readShippedProfile } from '../reference-profile.mjs';
import { LINEAGE_HEAD, selectMigrations } from '../../../agent-workflow-memory/scripts/stamp-takeover.mjs';

const HEAD = '5.0.0';
const PROFILE_LINEAGE = '4.0.0';
const KIT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO = dirname(KIT);
const LF = '\n';
const VERSION = '([0-9]+\\.[0-9]+\\.[0-9]+)';
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const readRepo = (rel) => readFileSync(join(REPO, rel), 'utf8');
const NOTE_REL = 'agent-workflow-kit/migrations/5.0.0-kit-text-in-kit-files.md';
const RELAY = 'When a note names an exit of its command a refusal and gives it no retry of its own, relay that '
  + "refusal's line with the recovery it names and STOP before the finalizer and the stamp, so the next upgrade "
  + 'applies that note again.';
// Every prose copy part lineage-move lists, as the words that stand right before the head in that line;
// a prefix listed twice is a line pair that each carries it.
const PROSE = [
  ['agent-workflow-kit/SKILL.md', ['**stamp < `', '**stamp == `', 'vs the lineage head (`']],
  ['agent-workflow-kit/migrations/README.md', ['**deployment-lineage head** (`']],
  ['agent-workflow-kit/references/modes/bootstrap.md', ['The lineage head is **`']],
  ['agent-workflow-kit/references/modes/hook.md', ['stamp head `']],
  ['agent-workflow-kit/references/modes/velocity.md', ['stamp < `']],
  ['agent-workflow-kit/references/modes/upgrade.md', ['**deployment-lineage head** (`', '**deployment-lineage head** (`']],
  ['agent-workflow-memory/README.md', ['lineage (head `']],
  ['agent-workflow-memory/SKILL.md', ['The lineage head is **`', '(`LINEAGE_HEAD`, `', 'an equal-head (`', 'head** (`']],
  ['agent-workflow-memory/migrations/README.md', ['deployment-lineage head (`']],
  ['agent-workflow-memory/migrations/legacy-stamp-takeover.md', ['current lineage head is **`', '`head` = `', 'than `']],
];

describe('spec:transition/S13 the head is 5.0.0 in every copy in one commit', () => {
  it('both kit EXPECTED_WORKFLOW_VERSION copies and memory LINEAGE_HEAD hold 5.0.0', () => {
    assert.deepEqual([EXPECTED_WORKFLOW_VERSION, SELECTOR_HEAD, LINEAGE_HEAD], [HEAD, HEAD, HEAD]);
  });
  it('the memory and engine CHANGELOG preambles declare head 5.0.0', () => {
    for (const pkg of ['agent-workflow-memory', 'agent-workflow-engine']) {
      const preamble = readRepo(`${pkg}/CHANGELOG.md`).split(`${LF}## `)[0];
      const heads = [...preamble.matchAll(new RegExp(`head \`${VERSION}\``, 'g'))].map(([, version]) => version);
      assert.ok(heads.length > 0, `${pkg}: the preamble declares a head`);
      assert.deepEqual(heads, heads.map(() => HEAD), pkg);
    }
  });
  for (const [rel, prefixes] of PROSE) {
    it(`every head line of ${rel} names 5.0.0`, () => {
      const text = readRepo(rel);
      for (const prefix of new Set(prefixes)) {
        const found = [...text.matchAll(new RegExp(escapeRe(prefix) + VERSION, 'g'))].map(([, version]) => version);
        assert.ok(found.length >= prefixes.filter((each) => each === prefix).length, `${rel}: ${prefix}`);
        assert.deepEqual(found, found.map(() => HEAD), `${rel}: ${prefix}`);
      }
    });
  }
});

describe('spec:transition/S14 the note', () => {
  const lines = () => readRepo(NOTE_REL).split(LF);
  it('carries the headline, the From and To line and Why, Steps, Verification and Rollback in order', () => {
    assert.equal(lines().find((line) => line.startsWith('# ')), '# Migration 5.0.0-kit-text-in-kit-files');
    assert.ok(lines().includes('**From:** versions < 5.0.0   **To:** 5.0.0'));
    assert.deepEqual(lines().filter((line) => line.startsWith('## ')), ['## Why', '## Steps', '## Verification', '## Rollback']);
  });
  it('names the command, the STOP before the finalizer and the stamp, and the engine refresh', () => {
    const text = readRepo(NOTE_REL);
    for (const token of ['node <installed-kit>/tools/transition/index.mjs --cwd <project>', 'npx @sabaiway/agent-workflow-engine@latest init']) {
      assert.ok(text.includes(token), token);
    }
    assert.match(text, /STOPs? before the finalizer and the stamp/);
  });
});

describe('spec:transition/S15 the selector', () => {
  const roots = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const listUnder = async (stamp) => {
    const root = mkdtempSync(join(tmpdir(), 'lineage-move-'));
    roots.push(root);
    mkdirSync(join(root, 'docs', 'ai'), { recursive: true });
    writeFileSync(join(root, 'docs', 'ai', '.workflow-version'), `${stamp}${LF}`);
    const result = await listNotes(['--cwd', root], {});
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.split(LF).filter((line) => line !== '');
  };
  for (const [stamp, expected] of [
    ['1.0.0', ['1.1.0', '1.2.0', '3.0.0', '4.0.0', '5.0.0']],
    ['3.0.0', ['4.0.0', '5.0.0']],
    ['4.0.0', ['5.0.0']],
  ]) {
    it(`lists the kit notes ${expected.join(', ')} under a ${stamp} stamp`, async () => {
      const lines = await listUnder(stamp);
      assert.ok(lines.every((line) => line.startsWith('note ')), lines.join(LF));
      assert.deepEqual(lines.map((line) => line.split(' ')[1]), expected);
    });
  }
  it('prints the equal-head none line under a 5.0.0 stamp', async () => {
    const lines = await listUnder(HEAD);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].startsWith('note ') && lines[0].includes(HEAD), lines[0]);
  });
  it("memory's selectMigrations over its real migrations directory selects nothing under a 4.0.0 stamp", () => {
    const real = readdirSync(join(REPO, 'agent-workflow-memory', 'migrations'))
      .map((name) => /^([0-9]+\.[0-9]+\.[0-9]+)-/.exec(name)?.[1])
      .filter(Boolean);
    assert.deepEqual(selectMigrations('4.0.0', real), []);
  });
});

describe('spec:transition/S16 every recorded decline stays current', () => {
  it('the deployment head is 5.0.0 while the shipped profile lineage stays 4.0.0', () => {
    assert.equal(readShippedProfile().profile.lineage, PROFILE_LINEAGE);
    assert.equal(EXPECTED_WORKFLOW_VERSION, HEAD);
  });
  it('a decline recorded at 4.0.0 is current against the shipped profile lineage', () => {
    const { profile } = readShippedProfile();
    for (const { id } of profile.items) {
      assert.equal(isDeclineCurrent({ [id]: PROFILE_LINEAGE }, id, profile.lineage), true, id);
    }
  });
});

describe('spec:transition/S17 the upgrade relays the stop', () => {
  const steps = () => readRepo('agent-workflow-kit/references/modes/upgrade.md').split(LF);
  const step = (n) => steps().find((line) => line.startsWith(`${n}. `) && line.includes('deployment-lineage head'));
  it('steps 2 and 8 name the head 5.0.0', () => {
    assert.ok(step(2).includes(`**deployment-lineage head** (\`${HEAD}\` — NOT this kit's package version)`), step(2));
    assert.ok(step(8).includes(`**deployment-lineage head** (\`${HEAD}\`, not the package version`), step(8));
  });
  it('step 6 carries the relay sentence right after its idempotence sentence, word for word', () => {
    const six = steps().find((line) => line.startsWith('6. '));
    assert.ok(six.includes(`Migrations are **idempotent** — safe to re-run. ${RELAY}`), six);
  });
});

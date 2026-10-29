// upgrade-runlist.test.mjs — the structure test over the upgrade step-3 run-list (feedback item 5).
//
// Two halves, one contract. (1) The registry's own shape: exactly the seven L1 operations, in the
// L1 order, kebab-case ids, the ONE command-path exception (`gates-migration` runs a
// references/scripts command; the other six live under tools/), consent marked exactly where L1
// says so, and the `configs` outcome copy held equal to its owning vocabulary leaf. (2) The doc
// half, asserted against references/modes/upgrade.md step 3: the checklist opens the step BEFORE
// the first rationale block; checklist rows ↔ registry entries (same backticked ids, same order,
// each row carrying its registry command and naming its outcome vocabulary, a consent marker
// exactly on the consent-bearing rows); every backticked id anchors exactly one rationale block
// below; and every `node ${CLAUDE_SKILL_DIR}/…` command anywhere in step 3 is a registry command —
// prose cannot name an operation the checklist misses.
//
// Brittleness bound: ids + commands + order + the named outcome tokens, never wording. Canon
// mechanics: planning-canon.test.mjs (section slice + token asserts), init-refresh-lens.test.mjs
// (anchored regions, non-vacuous extraction). Dev-only repo test (test/ is outside files[]).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UPGRADE_RUNLIST } from '../tools/upgrade-runlist.mjs';
import { main } from '../tools/ensure-configs.mjs';
import { RELAYED_ENSURE_TOKENS } from '../tools/ensure-vocabulary.mjs';
import * as readme from '../tools/orchestration-readme.mjs';
import { SKIPPED_READONLY } from '../tools/setup-backends.mjs';
import { PARITY } from '../tools/refresh-parity.mjs';
import { readFamily } from '../references/scripts/family.mjs';

const kitRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADE = readFileSync(resolve(kitRoot, 'references', 'modes', 'upgrade.md'), 'utf8');
const CONTRACTS = readFileSync(resolve(kitRoot, 'references', 'contracts.md'), 'utf8');

// The L1 lock, restated here on purpose: the registry cannot re-order or rename an operation
// without this test noticing — the ids are the future reconcile driver's item tokens.
const L1_IDS = ['entry-block', 'footprint', 'configs', 'gates-migration', 'bridges', 'tier', 'bridge-settings'];
const SKILL_VAR = '${CLAUDE_SKILL_DIR}';

// ── extraction helpers (anchored, non-vacuous: a missing anchor is red) ─────────────────────────
const between = (text, from, to, where) => {
  const a = text.indexOf(from);
  assert.notEqual(a, -1, `${where}: missing anchor "${from}"`);
  const b = text.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `${where}: missing anchor "${to}"`);
  return text.slice(a, b);
};

// Step 3 of the top-level ordered list: from the "3. " line to the "4. " line (nested checklist
// rows are indented, so only the top-level step numbers match at column 0).
const step3 = () => between(UPGRADE, '\n3. ', '\n4. ', 'upgrade.md');

// A checklist row: an indented numbered line opening with a backticked id and its backticked
// registry command. Returns [{id, line, index}] in document order.
const ROW_RE = /^\s*\d+\.\s+`([a-z][a-z0-9-]*)` — `node \$\{CLAUDE_SKILL_DIR\}\//;
const rowsOf = (section) => {
  const rows = [];
  let offset = 0;
  for (const line of section.split('\n')) {
    const m = line.match(ROW_RE);
    if (m) rows.push({ id: m[1], line, index: offset });
    offset += line.length + 1;
  }
  return rows;
};

// Boundary-guarded token match (round-2 fold): a token never rides inside a longer word or a
// hyphenated sibling — `skipped` must not be satisfied by the `skipped-readonly` substring — and
// the token is regex-escaped before the boundaries are built.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasToken = (text, token) => new RegExp(`(?<![\\w-])${escapeRe(token)}(?![\\w-])`).test(text);

// A rationale anchor: a line opening (after indent) with a BOLD backticked id — distinct from the
// checklist grammar (rows open with a list number, anchors with `**`).
const anchorsOf = (section) => {
  const anchors = [];
  const re = /^\s*\*\*`([a-z][a-z0-9-]*)`/gm;
  for (const m of section.matchAll(re)) anchors.push({ id: m[1], index: m.index });
  return anchors;
};

const blockOf = (id) => {
  const section = step3();
  const anchors = anchorsOf(section);
  const at = anchors.findIndex((a) => a.id === id);
  assert.notEqual(at, -1, `step 3 anchors a \`${id}\` rationale block`);
  return section.slice(anchors[at].index, anchors[at + 1]?.index ?? section.length);
};

const listRegularFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name);
  return entry.isDirectory() ? listRegularFiles(path) : entry.isFile() ? [path] : [];
});

// ── the registry's own shape ────────────────────────────────────────────────────────────────────
describe('upgrade-runlist registry — the L1 seven, in order', () => {
  it('carries exactly the seven L1 ids, in the L1 order: entry-block first with the kit block writer, no pointers or lens entry', () => {
    assert.deepEqual(UPGRADE_RUNLIST.map((e) => e.id), L1_IDS);
    assert.equal(UPGRADE_RUNLIST[0].command, `node ${SKILL_VAR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md`);
  });

  it('every id is kebab-case', () => {
    for (const { id } of UPGRADE_RUNLIST) {
      assert.match(id, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, id);
    }
  });

  it('every entry is a frozen {id, command, consent, outcomes} record', () => {
    assert.ok(Object.isFrozen(UPGRADE_RUNLIST));
    for (const e of UPGRADE_RUNLIST) {
      assert.ok(Object.isFrozen(e), e.id);
      assert.ok(Object.isFrozen(e.outcomes), e.id);
      assert.deepEqual(Object.keys(e).sort(), ['command', 'consent', 'id', 'outcomes'], e.id);
      assert.ok(e.command.length > 0, e.id);
      assert.ok(e.outcomes.length > 0, e.id);
      for (const token of e.outcomes) assert.ok(typeof token === 'string' && token.length > 0, e.id);
    }
  });

  it('six commands live under tools/; the ONE exception is gates-migration (references/scripts)', () => {
    // The migration runs from the skill home: gates/migrate-gates.mjs, a skill-home entry of the kit mirror's manifest.
    const migrate = readFamily().filter(({ path, role }) => path === 'gates/migrate-gates.mjs' && role === 'skill-home').map(({ path }) => path);
    assert.deepEqual(migrate, ['gates/migrate-gates.mjs'], 'gates-migration runs the skill-home gates/migrate-gates.mjs');
    for (const e of UPGRADE_RUNLIST) {
      if (e.id === 'gates-migration') {
        assert.ok(
          e.command.startsWith(`node ${SKILL_VAR}/references/scripts/${migrate[0]} `),
          'gates-migration runs the deployed-canon migration script, not a tools/ command',
        );
      } else {
        assert.ok(e.command.startsWith(`node ${SKILL_VAR}/tools/`), `${e.id}: ${e.command}`);
      }
    }
  });

  it('consent marks exactly the three L1 operations: footprint, gates-migration and tier', () => {
    for (const e of UPGRADE_RUNLIST) {
      if (e.id === 'footprint') {
        assert.ok(typeof e.consent === 'string' && e.consent.includes('--dry-run'),
          'footprint consent gates the non-dry-run re-run');
      } else if (e.id === 'gates-migration') {
        assert.ok(typeof e.consent === 'string' && e.consent.includes('--apply'),
          'gates-migration consent gates the --apply re-run');
      } else if (e.id === 'tier') {
        assert.ok(typeof e.consent === 'string' && e.consent.includes('--apply') && e.consent.includes('--decline'),
          'tier consent gates the --apply and the --decline re-run');
      } else {
        assert.equal(e.consent, null, `${e.id} carries no consent gate`);
      }
    }
  });

  it('the configs outcome copy equals the owning vocabulary leaf (RELAYED_ENSURE_TOKENS)', () => {
    const configs = UPGRADE_RUNLIST.find((e) => e.id === 'configs');
    assert.deepEqual([...configs.outcomes], [...RELAYED_ENSURE_TOKENS]);
  });

  it('the bridges outcomes track the live refresh vocabulary (skipped-readonly)', () => {
    const bridges = UPGRADE_RUNLIST.find((e) => e.id === 'bridges');
    assert.ok(bridges.outcomes.includes(SKIPPED_READONLY));
    // The parity verdicts ride the skipped-readonly LINE, not the outcome set — they must not leak
    // into the checklist vocabulary (the rationale block owns them).
    for (const verdict of Object.values(PARITY)) {
      assert.ok(!bridges.outcomes.includes(verdict), verdict);
    }
  });
});

// ── the doc half: upgrade.md step 3 renders the registry ────────────────────────────────────────
describe('upgrade.md step 3 — a normative run-list rendered from the registry', () => {
  const section = step3();
  const rows = rowsOf(section);
  const anchors = anchorsOf(section);

  it('(a) the checklist opens step 3 before the first rationale block', () => {
    assert.ok(rows.length > 0, 'step 3 opens with a checklist of registry rows');
    assert.ok(anchors.length > 0, 'step 3 carries per-operation rationale blocks');
    const lastRow = rows[rows.length - 1];
    const firstAnchor = anchors[0];
    assert.ok(lastRow.index < firstAnchor.index,
      'every checklist row precedes every rationale block');
  });

  it('(b) checklist rows ↔ registry entries: same ids, same order', () => {
    assert.deepEqual(rows.map((r) => r.id), UPGRADE_RUNLIST.map((e) => e.id));
  });

  it('(b) each row carries its registry command', () => {
    for (const e of UPGRADE_RUNLIST) {
      const row = rows.find((r) => r.id === e.id);
      assert.ok(row, `a checklist row for \`${e.id}\``);
      assert.ok(row.line.includes(`\`${e.command}\``), `${e.id}: the row quotes the exact command`);
    }
  });

  it('(b) each row names its outcome vocabulary', () => {
    for (const e of UPGRADE_RUNLIST) {
      const row = rows.find((r) => r.id === e.id);
      assert.ok(row, `a checklist row for \`${e.id}\``);
      for (const token of e.outcomes) {
        assert.ok(hasToken(row.line, token), `${e.id}: the row names outcome "${token}" (boundary-guarded)`);
      }
    }
  });

  it('(b) a consent marker rides exactly the consent-bearing rows', () => {
    for (const e of UPGRADE_RUNLIST) {
      const row = rows.find((r) => r.id === e.id);
      assert.ok(row, `a checklist row for \`${e.id}\``);
      if (e.consent === null) {
        assert.ok(!/consent/i.test(row.line), `${e.id}: no consent marker on a consent-free row`);
      } else {
        assert.ok(/consent/i.test(row.line), `${e.id}: the row carries its consent marker`);
      }
    }
  });

  it('(c) every backticked id anchors exactly one rationale block below the checklist', () => {
    for (const e of UPGRADE_RUNLIST) {
      const mine = anchors.filter((a) => a.id === e.id);
      assert.equal(mine.length, 1, `\`${e.id}\` anchors exactly one rationale block (got ${mine.length})`);
    }
    for (const a of anchors) {
      assert.ok(L1_IDS.includes(a.id), `rationale anchor \`${a.id}\` is a registry id`);
    }
  });

  it('(d) every node ${CLAUDE_SKILL_DIR}/… command in step 3 is a registry command', () => {
    const registryScripts = new Set(UPGRADE_RUNLIST.map((e) => e.command.split(' ')[1]));
    const named = [...section.matchAll(/node (\$\{CLAUDE_SKILL_DIR\}\/[^\s`]+)/g)].map((m) => m[1]);
    assert.ok(named.length >= UPGRADE_RUNLIST.length, 'the step names at least every registry command');
    for (const script of named) {
      assert.ok(registryScripts.has(script),
        `step 3 names "${script}" — prose cannot run an operation the checklist misses`);
    }
  });
});

// ── the tier item: its registry entry and its one ask (spec kit/tier/tier-offer, part lineage-step) ──
describe('spec:tier-offer/S14 the tier item runs the offer and puts its one ask', () => {
  it('the tier entry follows bridges with the preview command, the two re-runs and the offer words, and no lens entry exists', () => {
    const ids = UPGRADE_RUNLIST.map((e) => e.id);
    assert.deepEqual([ids.indexOf('tier'), ids.includes('lens')], [ids.indexOf('bridges') + 1, false]);
    const tier = UPGRADE_RUNLIST.find((e) => e.id === 'tier');
    assert.equal(tier.command, `node ${SKILL_VAR}/tools/tier-preview.mjs --cwd <project>`);
    assert.ok(tier.consent.includes('every other offered line'), tier.consent);
    assert.deepEqual([...tier.outcomes], ['present', 'offered', 'declined', 'undecidable', 'applied', 'recorded', 'refused']);
  });

  for (const token of ['`offered`', '`--apply`', '`--decline`', '`declined`', '`refused`', 're-stamp']) {
    it(`the tier block names ${token}`, () => {
      assert.ok(blockOf('tier').includes(token), `the \`tier\` block names ${token}`);
    });
  }

  it('the tier block names no lens ask and no retired item', () => {
    assert.deepEqual(['`story-sessions-section`', '`session-close-rules`', 'lens', 'Communication'].filter((token) => blockOf('tier').includes(token)), []);
  });
});

// A clause a copy or refresh verb, a script, pair or scripts/ path and "by hand" share; comment lines are not shipped text.
const CLAUSE_SPLIT = /\.(?=\s|$)|[;:—!?()→]/;
const HAND_COPY = /\b(?:cop(?:y|ies|ied|ying)|refresh(?:es|ed|ing)?)\b.*(?:\b(?:scripts?|pairs?)\b|\bscripts\/).*\bby hand\b/i;
const handCopyClauses = (line) => (/^\s*(?:\/\/|\/?\*)/.test(line) ? [] : line.split(CLAUSE_SPLIT).filter((clause) => HAND_COPY.test(clause)));

describe('spec:distribution-files/S10 the upgrade asks no yes for the spec layer and no line says copy by hand', () => {
  it('the configs entry and its upgrade.md row carry no consent, as the rows with none read', () => {
    assert.deepEqual([UPGRADE_RUNLIST.find((e) => e.id === 'configs').consent, /consent|\byes\b|replace/i.test(rowsOf(step3()).find((r) => r.id === 'configs')?.line ?? 'consent')], [null, false]);
  });
  it('the configs block has exactly one STOP sentence and it names no replace ask', () => {
    const block = blockOf('configs').replaceAll('**', ''), stops = block.split(/(?<=\.)\s+/).filter((sentence) => sentence.includes('STOP'));
    assert.deepEqual([(block.match(/STOP/g) ?? []).length, stops.length, stops.filter((sentence) => /replace|\byes\b|row 3/i.test(sentence))], [1, 1, []], stops.join('\n'));
    assert.ok(stops[0].includes('A non-zero exit STOPs this upgrade'), stops[0]);
  });
  it("contracts.md names .agent-workflow/ the family's reserved folder and the copies an earlier release kept there the user's", () => {
    const flat = CONTRACTS.replace(/\s+/g, ' ').toLowerCase();
    assert.deepEqual(["`.agent-workflow/` is the family's reserved folder", "the copies an earlier release kept there are the user's"].filter((words) => !flat.includes(words.toLowerCase())), []);
  });
  it('no shipped line says to copy or refresh a script by hand', () => {
    const files = [resolve(kitRoot, 'tools'), resolve(kitRoot, 'references'), resolve(kitRoot, '..', 'agent-workflow-memory', 'references')].flatMap(listRegularFiles);
    const matches = [...files, resolve(kitRoot, '..', 'agent-workflow-memory', 'SKILL.md')].filter((file) => !/\.test\.mjs$|\.test\//.test(file)).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (handCopyClauses(line).length > 0 ? [`${file}:${index + 1}: ${line}`] : [])));
    assert.deepEqual(matches, [], matches.join('\n'));
  });
  it('the judge catches a hand copy of a pair or a scripts/ path and spares the No-Node pointer paragraph', () => {
    assert.deepEqual(['copy the pair by hand, then re-run', 'refresh scripts/check-docs-size.mjs by hand', '// copy the pair by hand'].map((line) => handCopyClauses(line).length), [1, 1, 0]);
    const noNode = step3().split('\n').find((line) => line.includes('**No-Node project:**'));
    assert.ok(noNode?.includes('by hand') && /pair/.test(noNode) && /copy/.test(noNode), 'the spared paragraph names a pair, a copy and by hand');
    assert.deepEqual(handCopyClauses(noNode), []);
  });
});

const PAIR_FILES = ['scripts/spec-schema.mjs', 'scripts/spec-schema.test.mjs', 'scripts/check-docs-size.mjs', 'scripts/check-docs-size.test.mjs'];
// A clause (split at ; and a sentence end) that says an upgrade keeps an edit aside, or names where a kept-aside copy is.
const keepAsideClauses = (text) => text.replace(/\s+/g, ' ').split(/;|[.?!](?=\s|$)/).filter((clause) => !/an earlier release/i.test(clause) && ((/\b(?:keeps?|kept|keeping)\b.*\baside\b/i.test(clause) && /upgrade|\bedit/i.test(clause)) || /\.agent-workflow\/kept-aside\//.test(clause)));
const hasLocalPart = (path) => path.split(/[\\/]/).some((segment) => segment.split('.').includes('local'));
describe('spec:distribution-files/S26 the guide names the reserved names and channels, and no bundled name takes the local form', () => {
  it("the opening paragraph names the section, which names the kit's names, its agent and hook files, the vendor skill copy, the entry file's kit block and no rules-file section, the onboarding note, the nine channels and the name form with its two exceptions", async () => {
    const { BLOCK_ROUTE } = await import('../tools/inject-methodology.mjs');
    assert.equal(typeof BLOCK_ROUTE, 'string', 'inject-methodology.mjs exports BLOCK_ROUTE');
    assert.ok(between(CONTRACTS, '# Setup contracts\n\n', '\n\n', 'contracts.md').includes('*Reserved names and channels*'), 'the opening paragraph names the section');
    const section = (CONTRACTS.split('\n## Reserved names and channels\n')[1] ?? '').replace(/\s+/g, ' ');
    assert.deepEqual(["Every name the kit bundles and writes over on an upgrade is the kit's", 'written over by the next upgrade with no question and no copy kept', 'A declaration seeded once from a template', "is the user's own file", '`.claude/agents/<name>.local.md`', '`.claude/hooks/agent-workflow-gates.mjs`', '`.claude/hooks/state-block-guard.mjs`', 'within a hook you wired', '`.claude/hooks/<name>.local.mjs`', '`review-lens-<model>-<effort>.md`', '`scripts/pre-commit.local`', 'go in `scripts/` under names of your own', 'a config a script reads', '`docs/ai/rules/local/<theme>.md`', '`docs/ai/vehicles.json`', 'No path segment of a file the kit bundles and places as its own has a dot-separated part exactly `local`', '`.claude/settings.local.json`', "which the agent writes only on the user's own request"].filter((words) => !section.includes(words)), []);
    const plain = section.replaceAll('`', ''), block = plain.split('. ').find((one) => one.includes('kit block of AGENTS.md') && one.includes('workflow:kit')) ?? '';
    assert.deepEqual([...['one of nine channels', 'the whole of docs/ai/agent_rules.md', 'the kit lays it only where it is absent', 'apart from the one-time 5.0.0 step', BLOCK_ROUTE].filter((words) => !plain.includes(words)), ...['written current on every upgrade with no question and no copy kept'].filter((words) => !block.includes(words)), ...['Communication, Story sessions', "the kit's sections", 'Memory Map', 'workflow: --', 'around each pointer'].filter((words) => plain.includes(words))], [], "the entry file's kit block, no rules-file section and no Memory Map row named, the eighth and ninth channels");
    assert.deepEqual(['written current on every upgrade with no question and no copy kept', String(readme.NOTE_ROUTE)].filter((words) => !(section.replaceAll('`', '').split('. ').find((one) => one.includes('docs/ai/orchestration.json') && one.includes('onboarding note')) ?? '').includes(words)), [], "the orchestration config's onboarding note is the kit's, its route in the same sentence");
    const copy = ['the vendor skill copy the kit installs into the three agent skill roots', 'when it matches a pin the kit shipped', 'beside a copy at a kit pin', "a copy matching none is the user's, left and named"];
    assert.deepEqual([...copy.filter((words) => !section.includes(words)), ...['jev', 'typesafe'].filter((word) => section.toLowerCase().includes(word))], [], 'the vendor skill copy, by neither jev word');
    assert.deepEqual([...PAIR_FILES, ...readdirSync(resolve(kitRoot, 'references', 'agents'))].filter((path) => !section.includes(path)).concat([/\bname:`? of its own\b/, /\bno review roster names\b/, /<name>\.local\.mjs`[^.;]*\b(?:you|the user) wires?\b/].filter((re) => !re.test(section)).map(String)), [], 'every kit script and bundled agent file written over, the four spec-layer pair files included; the sixth channel takes a name: of its own that no review roster names; the seventh is a hook the user wires');
  });
  it('no clause of contracts.md says an upgrade keeps an edit aside or names a current kept-aside copy', () => {
    assert.deepEqual(keepAsideClauses(CONTRACTS), []);
    assert.deepEqual(['Before an upgrade replaces a file, it keeps the edit aside', 'it is kept at `.agent-workflow/kept-aside/<16 hex>/<path>`', "the copies an earlier release kept aside there are the user's"].map((text) => keepAsideClauses(text).length), [1, 1, 0], 'the judge catches both forms and spares the earlier copies');
  });
  it('no file under the kit and memory references trees takes the reserved name form; the judge catches it and spares localize.mjs', () => {
    const named = [resolve(kitRoot, 'references'), resolve(kitRoot, '..', 'agent-workflow-memory', 'references')].flatMap((root) => listRegularFiles(root).map((file) => relative(root, file)));
    assert.deepEqual(named.filter(hasLocalPart), []);
    assert.deepEqual(['scripts/pre-commit.local', 'docs/ai/rules/local/x.md', 'x.local.test.mjs', 'localize.mjs'].map(hasLocalPart), [true, true, true, false]);
  });
});

describe('spec:docs-navigator/S4 the configs block and the spec-adoption item name the no-question write', () => {
  it('the index token list names customized-preserved', () => {
    assert.ok(blockOf('configs').includes('index → `regenerated` / `already-current` / `customized-preserved`'));
  });
  it('the spec-adoption example and risk text name the edited spec-layer file written with no question and its line, the risk text the prior refresh; neither a replace line, a replace block or a yes', () => {
    const lines = readFileSync(resolve(kitRoot, 'references', 'modes', 'recommendations.md'), 'utf8').split('\n');
    const example = (lines.find((line) => line.startsWith('3. ')) ?? '').split(/(?<=\.)\s+/).find((sentence) => sentence.includes("`spec-adoption`'s `ensure-configs --reconcile --only specs`")) ?? '';
    const risk = lines.find((line) => line.startsWith('- `spec-adoption` — '))?.split('Risk profile:')[1] ?? '';
    const words = 'writes an edited spec-layer file with the bundled body with no question, its line naming where an edit meant to last goes';
    assert.deepEqual([example.includes(words), risk.includes(words), risk.includes('refreshes a script body a release shipped')], [true, true, true], `${example}\n${risk}`);
    assert.deepEqual([example, risk].filter((text) => /replace (?:line|block)|\byes\b/i.test(text)), []);
  });
});

// The spec-layer clauses of the shipped text, split at ; and at a sentence end; the retired words judged by stems.
const SPEC_LAYER_RETIRED = /replace (?:run|block|line|ask)|\baside\b|withh|\byes\b|--replace-custom|customized-preserved/i;
const clausesOf = (text) => text.replace(/\s+/g, ' ').split(/;|[.?!](?=\s|$)/), commentsOf = (source) => source.split('\n').filter((line) => line.trimStart().startsWith('//')).map((line) => line.replace(/^\s*\/\/ ?/, '')).join('\n');
describe('spec:distribution-files/S4 the shipped text of the spec layer states the rule', () => {
  const RULE = 'no question and no copy kept';
  const tool = (name) => readFileSync(resolve(kitRoot, 'tools', name), 'utf8'), headerOf = (source) => commentsOf(source.slice(0, source.indexOf('\nimport ')));
  const configsHeader = headerOf(tool('ensure-configs.mjs'));
  const parts = {
    arm: (blockOf('configs').split('specs → ')[1] ?? '').split(';')[0],
    paragraph: step3().split('\n').find((line) => line.trim().startsWith('**What the spec-layer ensure does.**')) ?? '',
    'ensure-specs.mjs header': headerOf(tool('ensure-specs.mjs')),
    'ensure-configs.mjs specs row': configsHeader.slice(configsHeader.search(/^ {2}specs /m), configsHeader.search(/^ {2}rules /m)),
    'ensure-configs.mjs --help': clausesOf(main(['--help']).stdout).filter((clause) => /spec[- ]layer/i.test(clause)).join(';'),
    'ensure-vocabulary.mjs specs comments': clausesOf(commentsOf(tool('ensure-vocabulary.mjs'))).filter((clause) => /`specs`|spec[- ]layer/i.test(clause)).join(';'),
    'script-priors.mjs header': headerOf(tool('script-priors.mjs')),
  };
  it('upgrade.md: the specs token arm names seeded, refreshed, already-present and skipped-no-node-evidence and not customized-preserved', () => {
    assert.deepEqual([['`seeded`', '`refreshed`', '`already-present`', '`skipped-no-node-evidence`'].filter((token) => !parts.arm.includes(token)), parts.arm.includes('customized-preserved')], [[], false], parts.arm);
  });
  it('the spec-layer paragraph, the ensure-specs.mjs header, the ensure-configs.mjs specs row and --help sentence and the ensure-vocabulary.mjs comments describe the rule', () => {
    const missing = ['paragraph', 'ensure-specs.mjs header', 'ensure-configs.mjs specs row', 'ensure-configs.mjs --help'].filter((part) => !parts[part].replace(/\s+/g, ' ').includes(RULE));
    assert.deepEqual([missing, clausesOf(parts['ensure-vocabulary.mjs specs comments']).some((clause) => clause.includes('`specs`') && clause.includes('no question'))], [[], true], JSON.stringify(parts, null, 1));
  });
  it("no spec-layer clause of them names a replace run, a replace block, kept aside, withheld, the user's yes, one yes or --replace-custom", () => {
    assert.deepEqual(Object.entries(parts).flatMap(([part, text]) => clausesOf(text).filter((clause) => SPEC_LAYER_RETIRED.test(clause)).map((clause) => `${part}: ${clause.trim()}`)), []);
  });
});

const noteKeptClauses = (text) => clausesOf(text.replace(/`[a-z-]+`/g, ' ')).filter((clause) => /\bnote\b|_README/i.test(clause) && /preserved|verbatim|customi[sz]ed|your own wording/i.test(clause) && !/malformed/i.test(clause));
describe('spec:orchestration-note/S7 the shipped text writes the note current and names its route', () => {
  const configs = readFileSync(resolve(kitRoot, 'tools', 'ensure-configs.mjs'), 'utf8'), arm = between(blockOf('configs'), 'orchestration → ', ';', 'configs block'), slices = { 'upgrade.md orchestration arm': arm, 'upgrade.md orchestration paragraph': between(UPGRADE, '**What the orchestration-config ensure does.**', '\n\n', 'upgrade.md'),'ensure-configs.mjs header row': configs.split('\n').find((line) => line.startsWith('//   orchestration ')) ?? '', 'ensure-configs.mjs --help': clausesOf(main(['--help']).stdout).filter((clause) => /onboarding note/i.test(clause)).join(';') };
  it('the token arms, the paragraph (the current note left, any other written current, the route, no module or refresher name) and the ensure-configs texts', () => {
    assert.deepEqual([...['seeded', 'note-refreshed', 'already-current', 'malformed-preserved', 'customized-preserved'].map((token) => hasToken(arm, token)), hasToken(between(blockOf('configs'), 'index → ', ';', 'configs block'), 'customized-preserved')], [true, true, true, true, false, true]);
    const paragraph = slices['upgrade.md orchestration paragraph'].replaceAll('`', ''), names = ['orchestration-readme.mjs', 'orchestration-config.mjs', 'refreshReadme', 'refreshIfCanonical'].filter((name) => paragraph.includes(name));
    assert.deepEqual([/current note[^.;]*\bleft\b/i.test(paragraph), /any other note[^.;]*written current[^.;]*no question and no copy kept/i.test(paragraph), paragraph.includes(String(readme.NOTE_ROUTE)), names, ...['ensure-configs.mjs header row', 'ensure-configs.mjs --help'].map((name) => /written current/i.test(slices[name]))], [true, true, true, [], true, true], JSON.stringify(slices, null, 1));
  });
  it('no clause of those slices pairs the note with a word that keeps it, save the malformed-config clause; the judge catches one and spares a token and that clause', () => {
    assert.deepEqual([Object.entries(slices).flatMap(([name, text]) => noteKeptClauses(text).map((clause) => `${name}: ${clause.trim()}`)), ['a customized note is preserved verbatim', 'the note arm: `customized-preserved`', 'a malformed config is preserved untouched, the note too'].map((text) => noteKeptClauses(text).length)], [[], [1, 0, 0]]);
  });
});

// ── steps 4 and 8: the report enumerations cover every run-list operation (round-2 fold) ────────
// The run-list closes the "prose cannot miss an operation" hole for step 3; without this half the
// REPORT steps could still silently omit one. The ids are structural labels of the instruction —
// the user-facing report itself stays plain language (the steps' own wording).
describe('upgrade.md steps 4 and 8 — the reports name every run-list operation', () => {
  const step4 = () => between(UPGRADE, '\n4. ', '\n5. ', 'upgrade.md step 4');
  const step8 = () => {
    const at = UPGRADE.indexOf('\n8. ');
    assert.notEqual(at, -1, 'upgrade.md: missing anchor "\\n8. "');
    return UPGRADE.slice(at);
  };
  for (const id of L1_IDS) {
    it(`step 4 names \`${id}\``, () => {
      assert.ok(step4().includes(`\`${id}\``), `step 4 reports the \`${id}\` outcome`);
    });
    it(`step 8 names \`${id}\``, () => {
      assert.ok(step8().includes(`\`${id}\``), `step 8 reports the \`${id}\` outcome`);
    });
  }
  it('the boundary guard is non-vacuous: skipped is not satisfied by skipped-readonly (injected)', () => {
    assert.equal(hasToken('lines: `skipped-readonly` only', 'skipped'), false);
    assert.equal(hasToken('lines: skipped — with its stated reason', 'skipped'), true);
  });
});

// ── non-vacuity: the extractors flag what they exist to flag (injected red→green proof) ─────────
describe('the extractors are non-vacuous', () => {
  const SYNTH = [
    '\n3. **Run the list.**',
    '',
    '   1. `pointers` — `node ${CLAUDE_SKILL_DIR}/tools/inject-methodology.mjs reconcile <project>/AGENTS.md` → added',
    '',
    '   **`pointers` — why.** Because.',
    '\n4. next step',
  ].join('\n');

  it('a synthetic step 3 yields its row and its anchor', () => {
    const section = between(SYNTH, '\n3. ', '\n4. ', 'synthetic');
    assert.deepEqual(rowsOf(section).map((r) => r.id), ['pointers']);
    assert.deepEqual(anchorsOf(section).map((a) => a.id), ['pointers']);
  });

  it('a stripped row / a stripped anchor is reported missing', () => {
    const noRow = between(SYNTH.replace('`pointers` — `node', 'pointers — node'), '\n3. ', '\n4. ', 'doctored');
    assert.deepEqual(rowsOf(noRow), []);
    const noAnchor = between(SYNTH.replace('**`pointers`', '**pointers'), '\n3. ', '\n4. ', 'doctored');
    assert.deepEqual(anchorsOf(noAnchor), []);
  });
});

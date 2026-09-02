import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(HERE, '..');
const FAMILY_ROOT = resolve(HERE, '..', '..');
const BOOTSTRAP = 'references/modes/bootstrap.md';
const DEPLOY_TAIL = 'references/shared/deploy-tail.md';
const MEMORY_SKILL = 'agent-workflow-memory/SKILL.md';
const KIT_README = 'agent-workflow-kit/README.md';
const FAMILY_README = 'README.md';
const WINDSURF_LAUNCHER = 'launchers/windsurf-workflow.md';
const STEP_EIGHT_ANCHOR = '8. **';
const STEP_TEN_ANCHOR = '10. **';
const HOST_SKIP_SENTENCE = 'the only skip condition is that the agent host cannot run them';
const COMMITTER_RESIDUAL = "a committer without `node` on PATH gets the hook's own loud failure";
const PREVIEW_FIRST = 'preview-first';
const CONSENT_YES = 'on a yes copy';
const LAUNCHER_CONSENT_YES = 'on a yes: copy';
const LAUNCHER_COPY_SOURCE = 'copy `<KIT_DIR>/references/scripts';
const DECLINE_PATH_WARNING = "Never write the skill's absolute path into a deployed doc";
const AGENTS_DOCS_ROW = 'row of `AGENTS.md`';
const VISIBLE_PACKAGE_CONDITION = 'when a `package.json` exists and the offer was accepted';
const INSTALLED_ON_YES = 'installed on a yes';
const OFFER_ACCEPTED = 'and the enforcement offer was accepted';
const WHERE_INSTALLED = 'where installed';
const RECON_PROXIES = ['(Node projects)', 'If the project has no Node', 'No Node runtime'];
const INSTALL_CLAIM_PINS = [
  [FAMILY_README, INSTALLED_ON_YES, 4],
  [KIT_README, INSTALLED_ON_YES, 4],
  ['agent-workflow-memory/README.md', INSTALLED_ON_YES, 1],
  ['agent-workflow-kit/references/contracts.md', OFFER_ACCEPTED, 1],
  ['agent-workflow-memory/references/contracts.md', OFFER_ACCEPTED, 1],
  ['agent-workflow-memory/references/templates/changelog.md', INSTALLED_ON_YES, 1],
  ['agent-workflow-kit/references/templates/changelog.md', INSTALLED_ON_YES, 1],
  ['agent-workflow-memory/references/templates/decisions.md', INSTALLED_ON_YES, 2],
  ['agent-workflow-kit/references/templates/decisions.md', INSTALLED_ON_YES, 2],
  ['agent-workflow-memory/references/templates/agent_rules.md', WHERE_INSTALLED, 1],
  ['agent-workflow-kit/references/templates/agent_rules.md', WHERE_INSTALLED, 1],
];
const BY_HAND_CLAIMS = [
  [KIT_README, 'Non-Node projects keep the same policy by hand'],
  [KIT_README, 'Non-Node projects follow the same policy by hand'],
  [FAMILY_README, 'Non-Node projects keep the same policy by hand'],
  [FAMILY_README, 'non-Node projects follow the policy by hand'],
  [MEMORY_SKILL, 'non-Node stacks follow the same policy manually'],
];

const normalize = (text) => text.replace(/\s+/g, ' ');
const readKit = (relativePath) => normalize(readFileSync(join(KIT_ROOT, relativePath), 'utf8'));
const readFamily = (relativePath) => normalize(readFileSync(join(FAMILY_ROOT, relativePath), 'utf8'));
const occurrences = (text, literal) => text.split(literal).length - 1;
const boundedRegion = (text, where) => {
  const start = text.indexOf(STEP_EIGHT_ANCHOR);
  assert.notEqual(start, -1, `${where}: missing region anchor "${STEP_EIGHT_ANCHOR}"`);
  const end = text.indexOf(STEP_TEN_ANCHOR, start);
  assert.notEqual(end, -1, `${where}: missing region anchor "${STEP_TEN_ANCHOR}"`);
  return text.slice(start, end);
};

// spec:node-evidence/S8
describe('enforcement offer docs \u2014 bootstrap.md, deploy-tail.md, memory SKILL.md carry the decided sentence exactly once, no recon proxy, no by-hand claim', () => {
  const canonicalDocuments = [
    [BOOTSTRAP, readKit(BOOTSTRAP)],
    [DEPLOY_TAIL, readKit(DEPLOY_TAIL)],
    [MEMORY_SKILL, readFamily(MEMORY_SKILL)],
  ];

  it('the host-runs-it sentence appears exactly once in each canonical document', () => {
    for (const [where, text] of canonicalDocuments) {
      assert.equal(occurrences(text, HOST_SKIP_SENTENCE), 1, where);
    }
  });

  it('the committer Node residual appears exactly once in each canonical document', () => {
    for (const [where, text] of canonicalDocuments) {
      assert.equal(occurrences(text, COMMITTER_RESIDUAL), 1, where);
    }
  });

  it('bootstrap and memory steps 8-9 each say preview-first exactly once', () => {
    const regions = [
      [BOOTSTRAP, boundedRegion(readKit(BOOTSTRAP), BOOTSTRAP)],
      [MEMORY_SKILL, boundedRegion(readFamily(MEMORY_SKILL), MEMORY_SKILL)],
    ];
    for (const [where, text] of regions) {
      assert.equal(occurrences(text, PREVIEW_FIRST), 1, where);
      assert.equal(occurrences(text, CONSENT_YES), 1, where);
      assert.equal(occurrences(text, DECLINE_PATH_WARNING), 1, where);
      assert.equal(occurrences(text, AGENTS_DOCS_ROW), 1, where);
    }
  });

  it('the Windsurf launcher names the offer once, copies only on a yes, and carries no recon proxy', () => {
    const launcher = readKit(WINDSURF_LAUNCHER);
    assert.equal(occurrences(launcher, LAUNCHER_CONSENT_YES), 1, WINDSURF_LAUNCHER);
    assert.equal(occurrences(launcher, LAUNCHER_COPY_SOURCE), 1, WINDSURF_LAUNCHER);
    for (const proxy of RECON_PROXIES) {
      assert.equal(occurrences(launcher, proxy), 0, `${WINDSURF_LAUNCHER}: ${proxy}`);
    }
  });

  it('the offer carries no stack-recon proxy in its governed regions', () => {
    const bootstrapSteps = boundedRegion(readKit(BOOTSTRAP), BOOTSTRAP);
    const governedTexts = [
      [BOOTSTRAP, bootstrapSteps],
      [DEPLOY_TAIL, readKit(DEPLOY_TAIL)],
      [MEMORY_SKILL, readFamily(MEMORY_SKILL)],
    ];
    for (const [where, text] of governedTexts) {
      for (const proxy of RECON_PROXIES) assert.equal(occurrences(text, proxy), 0, `${where}: ${proxy}`);
    }
  });

  it('the visible wiring is conditional on an existing package.json and an accepted offer', () => {
    const bootstrapSteps = boundedRegion(readKit(BOOTSTRAP), BOOTSTRAP);
    assert.equal(occurrences(bootstrapSteps, VISIBLE_PACKAGE_CONDITION), 1, BOOTSTRAP);
  });

  it('every install claim in the family is conditional on a yes', () => {
    for (const [relativePath, literal, count] of INSTALL_CLAIM_PINS) {
      assert.equal(occurrences(readFamily(relativePath), literal), count, `${relativePath}: ${literal}`);
    }
  });

  it('the five by-hand claims are absent from the family front doors and memory skill', () => {
    for (const [relativePath, claim] of BY_HAND_CLAIMS) {
      assert.equal(occurrences(readFamily(relativePath), claim), 0, `${relativePath}: ${claim}`);
    }
  });
});

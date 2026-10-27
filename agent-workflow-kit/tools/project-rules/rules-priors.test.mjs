// The prior catalog: frozen, the 14.37.0 body its one entry, its one question over a given catalog, every entry's body on disk.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { load, need, sha } from './rules-harness.test.mjs';
import { THEMES } from './themes.mjs';

const THEME = 'project-layout';
const PRIOR_BODY = Buffer.from('---\ntype: rules\n---\n\n# Project layout\n\nThe body an earlier release shipped.\n');
const CATALOG = Object.freeze([Object.freeze({ theme: THEME, release: '14.0.0', sha256: sha(PRIOR_BODY) })]);
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SHIPPED_BODIES = Object.freeze(['b79f19a9e0583f1e0619ee6aca06feb2c359b9655f1d260e87d8d5647bd1de19', 'ec4ef10c05ba365e73df96d175042314ea120f3fe1c946fdd94d3d1237de8be9']);
const FIXTURE = new URL('fixtures/project-layout/14.37.0.md', import.meta.url);
const TEMPLATE = new URL('../../references/rules/project-layout.md', import.meta.url);

const priorsOf = () => load('./rules-priors.mjs');

describe('spec:project-rules/S24 RULES_PRIORS is a frozen catalog of the 14.37.0 body and isKnownPrior answers over the given catalog', () => {
  it('RULES_PRIORS is a frozen list of exactly the project-layout 14.37.0 entry', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    assert.ok(Array.isArray(RULES_PRIORS), 'RULES_PRIORS is a list');
    assert.ok(Object.isFrozen(RULES_PRIORS), 'RULES_PRIORS is frozen');
    assert.deepEqual(RULES_PRIORS.map((entry) => ({ ...entry })), [{ theme: THEME, release: '14.37.0', sha256: SHIPPED_BODIES[0] }]);
  });

  it('the default catalog knows the 14.37.0 fixture body and not the current template', async () => {
    const isKnownPrior = need(await priorsOf(), 'isKnownPrior');
    assert.equal(isKnownPrior(THEME, readFileSync(FIXTURE)), true, 'the 14.37.0 body is a known prior');
    assert.equal(isKnownPrior(THEME, readFileSync(TEMPLATE)), false, 'the current template is no prior');
  });

  it('the literal shipped digests are the catalog digests plus the current template digest', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    assert.deepEqual([...RULES_PRIORS.map((entry) => entry.sha256), sha(readFileSync(TEMPLATE))], SHIPPED_BODIES);
  });

  it('isKnownPrior is true exactly for the bytes of an entry of the given theme', async () => {
    const isKnownPrior = need(await priorsOf(), 'isKnownPrior');
    assert.equal(isKnownPrior(THEME, PRIOR_BODY, CATALOG), true);
    assert.equal(isKnownPrior('other-theme', PRIOR_BODY, CATALOG), false, 'another theme with the same digest');
    assert.equal(isKnownPrior(THEME, Buffer.from('other bytes\n'), CATALOG), false, 'other bytes');
    assert.equal(isKnownPrior(THEME, PRIOR_BODY), false, 'the default catalog');
  });

  it('every entry is a frozen theme, release and digest whose fixture body hashes to it', async () => {
    const RULES_PRIORS = need(await priorsOf(), 'RULES_PRIORS');
    const names = THEMES.map((theme) => theme.name);
    for (const entry of RULES_PRIORS) {
      const label = `${entry.theme} ${entry.release}`;
      assert.ok(Object.isFrozen(entry), `${label} is frozen`);
      assert.deepEqual(Object.keys(entry).sort(), ['release', 'sha256', 'theme'], `${label} keys`);
      assert.ok(names.includes(entry.theme), `${label} names a registry theme`);
      assert.match(entry.sha256, DIGEST_RE, `${label} digest is 64 lowercase hex`);
      const body = readFileSync(new URL(`fixtures/${entry.theme}/${entry.release}.md`, import.meta.url));
      assert.equal(sha(body), entry.sha256, `${label} fixture body hashes to its digest`);
    }
  });
});

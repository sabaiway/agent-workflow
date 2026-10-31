// publish-workflow.test.mjs — drift guard over the publish workflow's release step.
//
// The kit 4.1.0 release published to npm, pushed its tag, and then went RED on the very last line:
// `gh release edit "$tag" --draft=false`. A DRAFT release is not addressable by tag — gh answers
// "release not found" until it is published — so the un-draft must go through the API by release
// ID. The draft was published by hand afterwards. This test exists so the tag-addressed form cannot
// come back, in either of the two places that publish a draft.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(HERE, '..', '..', '.github', 'workflows', '_publish-one.yml');
const source = readFileSync(WORKFLOW, 'utf8');

describe('publish workflow — a draft release is published by ID, never by tag', () => {
  it('no `gh release edit <tag> --draft=false` survives anywhere', () => {
    const offenders = source
      .split('\n')
      .map((line, index) => [index + 1, line.trim()])
      .filter(([, line]) => line.includes('gh release edit') && line.includes('--draft=false'));
    assert.deepEqual(
      offenders,
      [],
      `a draft is not addressable by tag; use the undraft helper instead:\n${offenders.map(([n, l]) => `  :${n} ${l}`).join('\n')}`,
    );
  });

  it('the undraft helper resolves the release ID and PATCHes draft=false', () => {
    assert.match(source, /undraft\(\)\s*\{/u);
    assert.match(source, /draft_id\(\)\s*\{/u);
    assert.match(source, /select\(\.tag_name == \\"\$1\\" and \.draft\)/u);
    assert.match(source, /-X PATCH -F draft=false/u);
  });

  it('both publish paths call the helper — the create path and the complete-a-draft path', () => {
    const calls = source.split('\n').filter((line) => line.trim().startsWith('undraft "$tag"'));
    assert.equal(calls.length, 2, 'both the create path and the stranded-draft completion path must un-draft by ID');
  });

  it('the helper fails LOUDLY when no draft is found, never silently', () => {
    assert.match(source, /::error::no DRAFT release found for tag/u);
  });

  // The kit 4.2.0 release failed HERE, one release after the ID fix landed. npm published, the tag
  // pushed, `gh release create --draft` succeeded and printed its `untagged-…` URL — and the very
  // next `draft_id` lookup, 1.2 seconds later, returned nothing. The releases LIST endpoint had not
  // caught up; minutes later the same query returned the draft with the correct tag_name. The draft
  // was left stranded exactly as in 4.1.0, for an entirely different reason.
  //
  // A single unretried read of an eventually-consistent endpoint is the defect. The lookup retries.
  // Extract a shell function body by NAME rather than by lexical position: slicing between two
  // `indexOf`s silently yields an empty string — and vacuously passing assertions — the moment
  // someone reorders the functions.
  const bodyOf = (name) => {
    const start = source.indexOf(`${name}() {`);
    assert.notEqual(start, -1, `${name}() is missing from the workflow`);
    const end = source.indexOf('\n          }', start);
    assert.notEqual(end, -1, `${name}() has no closing brace at the expected indent`);
    return source.slice(start, end);
  };

  it('the post-create lookup RETRIES with the pinned shape — a single read is the 4.2.0 defect', () => {
    const settled = bodyOf('draft_id_settled');
    assert.match(settled, /for _attempt in 1 2 3 4 5; do/u, 'five attempts, pinned — a one-shot loop would pass a looser check');
    assert.match(settled, /\[ "\$_attempt" = 5 \] \|\| sleep 3/u, 'back off 3s BETWEEN attempts, never after the last');
    assert.match(source, /id="\$\(draft_id_settled "\$1"\)"/u, 'undraft must use the retrying lookup');
  });

  it('the stranded-draft PROBE stays a single read — finding nothing is its normal answer', () => {
    // Retrying here would spend the full backoff on every green publish, where no draft existing is
    // exactly what is expected. Pinned from BOTH sides: the probe calls the plain form, and the
    // plain form itself must stay loop-free.
    assert.match(source, /existing_draft="\$\(draft_id "\$tag"\)"/u);
    const plain = bodyOf('draft_id');
    assert.doesNotMatch(plain, /\bfor\b|\bsleep\b|\bwhile\b/u, 'draft_id must stay a single read');
  });
});

// The script family's suites sit in module folders under both trees, so a flat glob drops all but the top level.
const REPO = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const CANON = 'agent-workflow-memory/references/scripts/';
const MIRROR = 'agent-workflow-kit/references/scripts/';

// A quoted word reaches node as one glob it expands itself; an unquoted word takes bash brace expansion first.
const expansions = (word) => {
  const quoted = /^(['"])(.*)\1$/u.exec(word);
  if (quoted) return { quoted: true, globs: [quoted[2]] };
  const globs = [];
  const expand = (w) => {
    const group = /\{([^{}]*)\}/u.exec(w);
    if (!group || !group[1].includes(',')) return void globs.push(w);
    for (const alt of group[1].split(',')) expand(w.slice(0, group.index) + alt + w.slice(group.index + group[0].length));
  };
  expand(word);
  return { quoted: false, globs };
};
const wordsOf = (text) => text.split('\n').filter((line) => !line.trim().startsWith('#')).join(' ').split(/\s+/u).filter(Boolean);
const treeWords = (text, root) => wordsOf(text).filter((word) => expansions(word).globs.some((glob) => glob.startsWith(root)));
const assertOneRecursive = (text, root, where) => {
  const seen = treeWords(text, root).map((word) => (expansions(word).quoted ? `quoted ${expansions(word).globs[0]}` : `bare ${word}`));
  assert.deepEqual(seen, [`quoted ${root}**/*.test.mjs`], `${where} must run ${root} by one quoted recursive glob`);
};
// A glob reaching <prefix>references/scripts/*.test.mjs with no sibling expansion reaching the module folders.
const flatGlobs = (text) =>
  wordsOf(text).filter((word) => {
    const { globs } = expansions(word);
    return globs.some((glob) => {
      const flat = /^(.*)references\/scripts\/\*\.test\.mjs$/u.exec(glob);
      return flat && ![`${flat[1]}references/scripts/*/*.test.mjs`, `${flat[1]}references/scripts/**/*.test.mjs`].some((deep) => globs.includes(deep));
    });
  });
// The lines of one workflow step after its `- name:` line, up to the next line at or above its indent.
const stepBody = (text, name) => {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `step "${name}" is missing`);
  const indent = lines[at].search(/\S/u);
  const end = lines.findIndex((line, i) => i > at && line.trim() !== '' && line.search(/\S/u) <= indent);
  return lines.slice(at + 1, end === -1 ? undefined : end).join('\n');
};

describe('spec:script-family/S10 the gate, CI and publish run every suite of both trees', () => {
  it('the CI test step on Node 22 and on Node 24 runs the canon and the mirror by one quoted recursive glob each', () => {
    const ci = read('.github/workflows/ci.yml');
    const versions = (/node-version:\s*\[([^\]]*)\]/u.exec(ci)?.[1] ?? '').split(',').map((v) => v.trim().replace(/^['"]|['"]$/gu, ''));
    assert.ok(versions.some((v) => /^22(\.|$)/u.test(v)) && versions.some((v) => /^24(\.|$)/u.test(v)), `the test matrix: ${versions}`);
    const step = stepBody(ci, 'Unit tests (tracked content)');
    for (const root of [CANON, MIRROR]) assertOneRecursive(step, root, 'ci.yml');
  });

  it('the publish test step of _publish-one.yml runs the kit tree and the memory tree by one quoted recursive glob each', () => {
    const branches = {};
    let branch = null;
    for (const line of stepBody(source, 'Test the package before publish').split('\n').map((l) => l.trim())) {
      if (/^(?:if|elif) \[/u.test(line)) branch = /"agent-workflow-(kit|engine)"/u.exec(line)?.[1] ?? line;
      else if (line === 'else') branch = 'memory';
      else if (line.startsWith('node --test')) branches[branch] = line;
    }
    assert.deepEqual(Object.keys(branches).sort(), ['engine', 'kit', 'memory']);
    for (const pkg of ['kit', 'memory']) assertOneRecursive(branches[pkg], 'references/scripts/', `_publish-one.yml (${pkg})`);
  });

  it('the unit-test gate runs the canon and the mirror by one quoted recursive glob each, and no flat glob', (t) => {
    const gates = join(REPO, 'docs', 'ai', 'gates.json');
    // docs/ai/ is machine-local in this repository: a CI checkout carries no gate declaration to judge.
    if (!existsSync(gates)) return t.skip('docs/ai/gates.json is machine-local and absent from this checkout');
    const gate = JSON.parse(readFileSync(gates, 'utf8')).gates.find((g) => g.id === 'unit-tests');
    assert.ok(gate, 'the unit-tests gate is declared');
    for (const root of [CANON, MIRROR]) assertOneRecursive(gate.cmd, root, 'the unit-tests gate');
    assert.deepEqual(flatGlobs(gate.cmd), [], 'the unit-tests gate names a flat references/scripts glob');
  });

  it('every checkout of a workflow that runs the kit suites fetches the whole history, since script-priors reads the last flat release by git show', () => {
    for (const rel of ['.github/workflows/ci.yml', '.github/workflows/_publish-one.yml']) {
      const lines = read(rel).split('\n');
      const checkouts = lines.flatMap((line, at) => (/^\s*- uses: actions\/checkout@/u.test(line) ? [at] : []));
      assert.ok(checkouts.length > 0, `${rel}: a checkout step`);
      for (const at of checkouts) {
        const indent = lines[at].indexOf('-');
        const end = lines.findIndex((line, i) => i > at && line.trim() !== '' && line.search(/\S/u) <= indent);
        const body = lines.slice(at + 1, end === -1 ? undefined : end).map((line) => line.trim());
        assert.ok(body.some((line) => /^fetch-depth: 0(?:\s+#.*)?$/u.test(line)), `${rel}:${at + 1}: the checkout fetches the whole history`);
      }
    }
  });

  it('no workflow names a flat references/scripts/*.test.mjs glob; the kit publish.yml runs its tree by references/scripts/{,*/}*.test.mjs', () => {
    const flat = ['.github/workflows', 'agent-workflow-kit/.github/workflows'].flatMap((dir) =>
      readdirSync(join(REPO, dir))
        .filter((name) => /\.ya?ml$/u.test(name))
        .flatMap((name) => flatGlobs(read(`${dir}/${name}`)).map((word) => `${dir}/${name}: ${word}`)));
    assert.deepEqual(flat, [], 'a workflow runs only the top level of a script tree');
    const step = stepBody(read('agent-workflow-kit/.github/workflows/publish.yml'), 'Test shipped enforcement scripts');
    assert.deepEqual(treeWords(step, 'references/scripts/'), ['references/scripts/{,*/}*.test.mjs']);
  });
});

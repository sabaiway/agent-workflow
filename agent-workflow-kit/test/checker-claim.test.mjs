// checker-claim.test.mjs — the three-outcome tool-claim classifier (tools/checker-claim.mjs).
//
// The claims pinned here:
//   • the three outcomes are really three: a vendored copy of the tool is `tool-elsewhere`, NOT the
//     absence the old boolean reported — that false absence is what made an "adopt it" remedy
//     collide with the entry already declared;
//   • the realpath anchor did NOT widen: a lookalike basename, a masked invocation, a shell-active
//     token and a squatter shape are all `not-the-tool`, never `tool-elsewhere`;
//   • every unresolvable side fails CLOSED — `tool-elsewhere` is a claim consumers act on, so it is
//     never minted from a path nothing can resolve;
//   • the region has TWO owners and no import between them (the standalone migration must not
//     depend on the kit), so a TEXT drift guard holds them equal.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CHECKER_CLAIM, checkerClaimTool, classifyCheckerClaim } from '../tools/checker-claim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OWN_SOURCE = join(HERE, '..', 'tools', 'checker-claim.mjs');
// The kit's in-package MIRROR of the memory canon. scripts/sync-mirrors.mjs copies the canon tree
// verbatim and test/scripts-mirror.test.mjs guards that half, so mirror-equality here IS
// canon-equality — reached without importing either side.
const MIRRORED_CANON = join(HERE, '..', 'references', 'scripts', 'migrate-gates.mjs');

const BEGIN = '// checker-claim canon >>> BEGIN drift-guarded region';
const END = '// checker-claim canon <<< END drift-guarded region';
const regionOf = (text) => {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + END.length);
};

const TOOL_BASENAME = 'probe-tool.mjs';
const ROOT = mkdtempSync(join(tmpdir(), 'checker-claim-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// One canonical copy, one VENDORED copy of the same tool, one lookalike with another basename, and
// a symlink to the canonical one (the anchor is realpath, so the link is the canonical claim).
const writeTool = (rel) => {
  const abs = join(ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '// a probe tool\n');
  return abs;
};
const CANONICAL = writeTool(join('kit', 'tools', TOOL_BASENAME));
const VENDORED = writeTool(join('project', 'vendor', TOOL_BASENAME));
const LOOKALIKE = writeTool(join('project', 'vendor', 'probeXtool.mjs'));
const LINK_DIR = join(ROOT, 'linked-tools');
symlinkSync(join(ROOT, 'kit', 'tools'), LINK_DIR);
const PROJECT = join(ROOT, 'project');

const TOOL = checkerClaimTool(TOOL_BASENAME, CANONICAL);
const claim = (cmd, projectDir = PROJECT) => classifyCheckerClaim(TOOL, cmd, projectDir);

describe('checker-claim — the canonical claim', () => {
  it('accepts every form that RESOLVES to this copy: quoted, bare, absolute, relative, symlinked', () => {
    for (const cmd of [
      `node "${CANONICAL}" --check`,
      `node ${CANONICAL} --check`,
      `node "${join(LINK_DIR, TOOL_BASENAME)}" --check`,
      `node "../kit/tools/${TOOL_BASENAME}" --check`,
      `node ../kit/tools/${TOOL_BASENAME} --check`,
      `  node "${CANONICAL}" --check  `,
    ]) {
      assert.equal(claim(cmd), CHECKER_CLAIM.CANONICAL, `must read as canonical: ${cmd}`);
    }
  });
});

describe('checker-claim — the tool-elsewhere claim (a vendored copy is not an absence)', () => {
  it('the same invocation shape resolving to ANOTHER real copy is tool-elsewhere, absolute or relative', () => {
    for (const cmd of [
      `node "${VENDORED}" --check`,
      `node ${VENDORED} --check`,
      `node "vendor/${TOOL_BASENAME}" --check`,
      `node vendor/${TOOL_BASENAME} --check`,
    ]) {
      assert.equal(claim(cmd), CHECKER_CLAIM.ELSEWHERE, `must read as tool-elsewhere: ${cmd}`);
    }
  });

  it('the SAME cmd flips to canonical when the canonical copy IS that path — the anchor decides, not the text', () => {
    const vendorAnchored = checkerClaimTool(TOOL_BASENAME, VENDORED);
    assert.equal(classifyCheckerClaim(vendorAnchored, `node "${VENDORED}" --check`, PROJECT), CHECKER_CLAIM.CANONICAL);
    assert.equal(classifyCheckerClaim(vendorAnchored, `node "${CANONICAL}" --check`, PROJECT), CHECKER_CLAIM.ELSEWHERE);
  });
});

describe('checker-claim — not-the-tool: recognition never widened', () => {
  it('a MASKED or compound invocation is no claim at all', () => {
    for (const cmd of [
      `node "${VENDORED}" --check --help`,
      `node "${VENDORED}" --check || true`,
      `node "${VENDORED}" --check && rm -rf x`,
      `node "${VENDORED}"`,
      `bash -c 'node "${VENDORED}" --check'`,
      `true && node "${VENDORED}" --check`,
      `node "${VENDORED}" --check extra/path`,
      `node  "${VENDORED}"  --check`.replace(' --check', '\n--check'),
    ]) {
      assert.equal(claim(cmd), CHECKER_CLAIM.NOT_THE_TOOL, `must be no claim: ${JSON.stringify(cmd)}`);
    }
  });

  it('a SQUATTER shape — the tool named as an argument, or a lookalike basename — is never tool-elsewhere', () => {
    for (const cmd of [
      `node scripts/wrapper.mjs ${TOOL_BASENAME} --check`,
      `node "${LOOKALIKE}" --check`,
      `node "${join(dirname(VENDORED), 'other-tool.mjs')}" --check`,
      `${TOOL_BASENAME} --check`,
      `node --experimental-strip-types "${VENDORED}" --check`,
    ]) {
      assert.equal(claim(cmd), CHECKER_CLAIM.NOT_THE_TOOL, `a squatter must never claim the tool: ${cmd}`);
    }
  });

  it('the basename is regex-ESCAPED — a dot in it matches a dot, never any byte', () => {
    const dotted = checkerClaimTool('probe.tool.mjs', join(ROOT, 'kit', 'tools', 'probe.tool.mjs'));
    writeTool(join('kit', 'tools', 'probe.tool.mjs'));
    const decoy = writeTool(join('project', 'vendor', 'probeXtool.mjs'));
    assert.equal(classifyCheckerClaim(dotted, `node "${join(ROOT, 'kit', 'tools', 'probe.tool.mjs')}" --check`, PROJECT), CHECKER_CLAIM.CANONICAL);
    assert.equal(classifyCheckerClaim(dotted, `node "${decoy}" --check`, PROJECT), CHECKER_CLAIM.NOT_THE_TOOL, 'probeXtool.mjs is not probe.tool.mjs');
  });

  it('a token the SHELL would read differently is refused by the screen its quoting earns', () => {
    for (const cmd of [
      `node "$HOME/${TOOL_BASENAME}" --check`,
      'node "`echo /tmp`/probe-tool.mjs" --check',
      'node "/tmp/x\\\\probe-tool.mjs" --check',
      'node $(pwd)/probe-tool.mjs --check',
      'node vendor/*/probe-tool.mjs --check',
      'node ~/probe-tool.mjs --check',
      "node 'vendor/probe-tool.mjs' --check",
    ]) {
      assert.equal(claim(cmd), CHECKER_CLAIM.NOT_THE_TOOL, `an inadmissible token is no claim: ${cmd}`);
    }
  });

  it('a resolvable NON-FILE carrying the basename is no claim — existing is not being a tool', () => {
    // realpathSync succeeding proves a path EXISTS, never that it is a copy of anything. A directory
    // (or a FIFO) named like the tool would otherwise mint `tool-elsewhere`, a claim consumers act
    // on. lstat runs after realpath, so no link is left to follow.
    const dirTool = join(ROOT, 'project', 'as-a-dir', TOOL_BASENAME);
    mkdirSync(dirTool, { recursive: true });
    assert.equal(claim(`node "${dirTool}" --check`), CHECKER_CLAIM.NOT_THE_TOOL);
    assert.equal(claim(`node as-a-dir/${TOOL_BASENAME} --check`), CHECKER_CLAIM.NOT_THE_TOOL);
    const fifo = join(ROOT, 'project', 'as-a-fifo', TOOL_BASENAME);
    mkdirSync(dirname(fifo), { recursive: true });
    const mkfifo = spawnSync('mkfifo', [fifo]);
    if (mkfifo.status === 0) assert.equal(claim(`node "${fifo}" --check`), CHECKER_CLAIM.NOT_THE_TOOL, 'a FIFO is not a tool either');
  });

  it('an OPTION-shaped token is no claim, however well it resolves — node would never run it', () => {
    // `node -x/probe-tool.mjs --check` hands node an OPTION, whatever sits at that path. First-order,
    // exactly like the producer canon's leading-`-` rule: the cost of a miss is a withheld claim.
    const optionDir = join(ROOT, 'project', '-x');
    mkdirSync(optionDir, { recursive: true });
    writeFileSync(join(optionDir, TOOL_BASENAME), '// a probe tool\n');
    assert.equal(claim(`node -x/${TOOL_BASENAME} --check`), CHECKER_CLAIM.NOT_THE_TOOL);
    assert.equal(claim(`node "-x/${TOOL_BASENAME}" --check`), CHECKER_CLAIM.NOT_THE_TOOL, 'quoting does not make it a path to node');
  });

  it('an ordinary path with a SPACE is a claim when QUOTED and unreachable when bare', () => {
    // The two screens differ by quoting on purpose: double quotes survive a space, a bare token
    // cannot carry one and still be one token (the shape regex never even matches it).
    const spaced = join(ROOT, 'project', 'my vendor', TOOL_BASENAME);
    mkdirSync(dirname(spaced), { recursive: true });
    writeFileSync(spaced, '// a probe tool\n');
    assert.equal(claim(`node "${spaced}" --check`), CHECKER_CLAIM.ELSEWHERE, 'a quoted path with a space is admissible');
    assert.equal(claim(`node "my vendor/${TOOL_BASENAME}" --check`), CHECKER_CLAIM.ELSEWHERE, 'relative and quoted too');
    assert.equal(claim(`node my vendor/${TOOL_BASENAME} --check`), CHECKER_CLAIM.NOT_THE_TOOL, 'bare: the shape never matches two tokens');
  });

  it('a DOT-relative token resolves like any other relative one', () => {
    assert.equal(claim(`node "./vendor/${TOOL_BASENAME}" --check`), CHECKER_CLAIM.ELSEWHERE);
    assert.equal(claim(`node ./vendor/${TOOL_BASENAME} --check`), CHECKER_CLAIM.ELSEWHERE);
    assert.equal(claim(`node "./../kit/tools/${TOOL_BASENAME}" --check`), CHECKER_CLAIM.CANONICAL);
  });

  it('an UNRESOLVABLE path fails closed — never tool-elsewhere on a guess', () => {
    // The direction matters: tool-elsewhere is a claim a consumer ACTS on (it renders "declared
    // through another copy" and offers an ack). A path nothing can resolve proves nothing about
    // where the tool lives, so it stays the outcome that asserts the least.
    for (const cmd of [
      `node "${join(ROOT, 'nowhere', TOOL_BASENAME)}" --check`,
      `node "missing/${TOOL_BASENAME}" --check`,
    ]) {
      assert.equal(claim(cmd), CHECKER_CLAIM.NOT_THE_TOOL, `unresolvable must fail closed: ${cmd}`);
    }
    const brokenAnchor = checkerClaimTool(TOOL_BASENAME, join(ROOT, 'gone', TOOL_BASENAME));
    assert.equal(
      classifyCheckerClaim(brokenAnchor, `node "${VENDORED}" --check`, PROJECT),
      CHECKER_CLAIM.NOT_THE_TOOL,
      'an unresolvable CANONICAL side fails closed too — nothing can be compared against nothing',
    );
  });

  it('a non-string cmd or projectDir is no claim (fail closed on type)', () => {
    for (const value of [null, undefined, 42, [`node "${CANONICAL}" --check`], { cmd: 'x' }]) {
      assert.equal(classifyCheckerClaim(TOOL, value, PROJECT), CHECKER_CLAIM.NOT_THE_TOOL, `cmd: ${JSON.stringify(value)}`);
      // Called through the classifier directly: a `claim(cmd, undefined)` helper call would take
      // the helper's DEFAULT project dir and quietly test nothing.
      assert.equal(classifyCheckerClaim(TOOL, `node "vendor/${TOOL_BASENAME}" --check`, value), CHECKER_CLAIM.NOT_THE_TOOL, `projectDir: ${JSON.stringify(value)}`);
    }
  });
});

describe('checker-claim — the TEXT drift guard against the memory canon', () => {
  it('the kit leaf and the memory canon hold the region byte-identically', () => {
    const own = regionOf(readFileSync(OWN_SOURCE, 'utf8'));
    const canon = regionOf(readFileSync(MIRRORED_CANON, 'utf8'));
    assert.ok(own, 'the kit source carries the delimited region');
    assert.ok(canon, 'the memory canon carries the delimited region');
    assert.ok(own.includes('CHECKER_CLAIM'), 'the region carries the live vocabulary');
    assert.equal(own, canon, 'the two owners drifted — edit BOTH, then run node scripts/sync-mirrors.mjs');
  });

  it('the guard is NOT vacuous — a one-byte divergence inside the region is detected', () => {
    const canonText = readFileSync(MIRRORED_CANON, 'utf8');
    const mutated = canonText.replace("ELSEWHERE: 'tool-elsewhere'", "ELSEWHERE: 'tool-elsewhere2'");
    assert.notEqual(mutated, canonText, 'the mutation applied (the literal is really in the canon)');
    assert.notEqual(regionOf(mutated), regionOf(canonText), 'a mutated region must compare UNEQUAL');
  });
});

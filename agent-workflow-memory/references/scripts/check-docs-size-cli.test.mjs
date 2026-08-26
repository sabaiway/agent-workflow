// check-docs-size-cli.test.mjs — runCli branch pins the subprocess smokes cannot reach
// in-process (Phase-5 coverage fill; the main spec file is parity-frozen, so these ride a
// colocated file): the unknown-argument refusal, the pre-write symlink refusal on the index path,
// and the symlink refusals the WALK itself emits.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './check-docs-size.mjs';

const cli = (argv) => runCli(argv);
const DOC = (name, maxLines = 10) =>
  `---\ntype: state\nlastUpdated: 2026-07-18\nscope: session\nstaleAfter: never\nowner: none\nmaxLines: ${maxLines}\n---\n\n# ${name}\n`;

// One temp root per arm, always torn down: docs/ai holds one real `a.md`, and `build` adds
// whatever the arm needs before the CLI runs.
const withRoot = async (build, run) => {
  const root = mkdtempSync(join(tmpdir(), 'cds-cli-'));
  const docs = join(root, 'docs', 'ai');
  try {
    mkdirSync(docs, { recursive: true });
    // A fixed package.json name, so the navigator's own bytes are deterministic across temp roots.
    writeFileSync(join(root, 'package.json'), '{ "name": "probe-project" }\n');
    writeFileSync(join(docs, 'a.md'), DOC('a'));
    build({ root, docs });
    await run({ root, docs });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const indexOf = (root) => readFileSync(join(root, 'docs', 'ai', 'index.md'), 'utf8');

// The exact navigator a symlink-free probe tree writes. A characterization literal: the symlink
// refusal must leave every byte of it — header, preamble, table, footer — untouched.
const EXPECTED_INDEX = `---
type: reference
lastUpdated: 2026-07-18
scope: permanent
staleAfter: 30d
owner: none
maxLines: 80
---

# Memory Map — probe-project \`docs/ai/\`

> **Auto-generated** — edit the source files' frontmatter, not this file. Regenerate after changes.
> Layered context architecture:
> **Always-loaded** — root \`AGENTS.md\` + this index.
> **On-demand** — read a specific \`docs/ai/\` file when its "Read When" applies.
> **Hierarchical** — subdirectory \`AGENTS.md\` files load when working in that folder.
> **Archive** — \`history/recent.md\` (WARM) + \`history/condensed-index.md\` + per-month files.

## Files

| File | Type | Lines/Max | Updated | Stale after |
|------|------|-----------|---------|-------------|
| [\`a.md\`](./a.md) | state | 10/10 | 2026-07-18 | never |
`;

describe('check-docs-size runCli — refusal branches', () => {
  it('an unknown argument exits 2 naming it', async () => {
    const { code, stderr } = await cli(['--bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /Unknown argument: --bogus/);
  });

  it('every mode refuses a symlinked navigator whose target holds the CURRENT bytes', async () => {
    await withRoot(
      () => {},
      async ({ root, docs }) => {
        // Write the real navigator, move its bytes to a target OUTSIDE docs/ai, and point index.md
        // at them. Freshness now MATCHES, so an implementation that reads through the link and only
        // complains when the comparison differs would pass: the refusal has to fire by NAME, before
        // the read. A `/dev/null` target would have proved nothing but a mismatch.
        const indexPath = join(docs, 'index.md');
        const target = join(root, 'elsewhere-index.md');
        await cli(['--write-index', `--root=${root}`, '--today=2026-07-18']);
        writeFileSync(target, readFileSync(indexPath, 'utf8'));
        rmSync(indexPath);
        symlinkSync(target, indexPath);
        const linked = new RegExp(`${indexPath} is a symlink`);
        const c = await cli(['--check-index', `--root=${root}`, '--today=2026-07-18']);
        assert.equal(c.code, 2, 'a symlinked navigator is REFUSED, never compared');
        assert.match(c.stderr, linked);
        const w = await cli(['--write-index', `--root=${root}`]);
        assert.equal(w.code, 2);
        assert.match(w.stderr, linked);
        const d = await cli([`--root=${root}`]);
        assert.equal(d.code, 1);
        assert.match(d.stdout, /docs\/ai\/index\.md[\s\S]*?ERROR\s+is a symlink/);
      },
    );
  });
});

describe('check-docs-size — a symlink under docs/ai is NAMED, never read', () => {
  it('a link to a READABLE in-tree doc errors, its target is inspected once, and --report still exits 0', async () => {
    await withRoot(
      ({ docs }) => symlinkSync(join(docs, 'a.md'), join(docs, 'link.md')),
      async ({ root }) => {
        const { code, stdout } = await cli([`--root=${root}`]);
        assert.equal(code, 1);
        assert.match(stdout, /docs\/ai\/link\.md[\s\S]*?ERROR\s+is a symlink/);
        assert.equal(stdout.match(/docs\/ai\/a\.md/g).length, 1, 'the target is inspected exactly once');
        assert.match(stdout, /2 files inspected {2}— {2}1 error/, 'the refused link is counted');
        const r = await cli(['--report', `--root=${root}`]);
        assert.equal(r.code, 0);
        assert.match(r.stdout, /ERROR\s+is a symlink/);
      },
    );
  });

  it('a symlinked DIRECTORY errors instead of hiding its subtree', async () => {
    await withRoot(
      ({ root, docs }) => {
        mkdirSync(join(root, 'elsewhere'));
        writeFileSync(join(root, 'elsewhere', 'hidden.md'), 'no frontmatter at all\n');
        symlinkSync(join(root, 'elsewhere'), join(docs, 'history'));
      },
      async ({ root }) => {
        const { code, stdout } = await cli([`--root=${root}`]);
        assert.equal(code, 1);
        assert.match(stdout, /docs\/ai\/history[\s\S]*?ERROR\s+is a symlink to a directory/);
        assert.doesNotMatch(stdout, /hidden\.md/, 'the subtree behind the link is never walked');
      },
    );
  });

  // The name carries no regex metacharacter on purpose: a red-proof testId is matched as a pattern,
  // and a literal star makes the arm unselectable (measured — the mint refused it as unresolvable).
  it('a DANGLING doc link errors by NAME, never as an ENOENT stack trace', async () => {
    await withRoot(
      ({ docs }) => symlinkSync(join(docs, 'gone.md'), join(docs, 'dangling.md')),
      async ({ root }) => {
        const { code, stdout } = await cli([`--root=${root}`]);
        assert.equal(code, 1);
        assert.match(stdout, /docs\/ai\/dangling\.md[\s\S]*?ERROR\s+is a symlink/);
        assert.doesNotMatch(stdout, /ENOENT/);
      },
    );
  });

  it('a link under adr/ gets its OWN index row and joins neither the collapse count nor its range', async () => {
    await withRoot(
      ({ docs }) => {
        mkdirSync(join(docs, 'adr'));
        writeFileSync(join(docs, 'adr', 'AD-001-real.md'), DOC('AD-001', 400));
        writeFileSync(join(docs, 'adr', 'log.md'), DOC('log', 200));
        symlinkSync(join(docs, 'adr', 'AD-001-real.md'), join(docs, 'adr', 'AD-999-link.md'));
      },
      async ({ root }) => {
        assert.equal((await cli(['--write-index', `--root=${root}`])).code, 1);
        assert.match(indexOf(root), /\| 1 records \|/, 'the real record is the only one counted');
        assert.doesNotMatch(indexOf(root), /AD-999 \|/, 'the link never enters the id range');
        assert.match(indexOf(root), /adr\/AD-999-link\.md/, 'the link renders its own row');
      },
    );
  });

  it('--check-index reds until the regenerated navigator carries the LINK row', async () => {
    await withRoot(
      () => {},
      async ({ root, docs }) => {
        // The BASELINE navigator is written first, with no link present, so the red below can only
        // come from the added row — not from a missing index.md, which would let an implementation
        // that merely checks the navigator EXISTS pass this arm.
        await cli(['--write-index', `--root=${root}`, '--today=2026-07-18']);
        assert.equal((await cli(['--check-index', `--root=${root}`])).code, 0, 'the baseline is fresh');
        symlinkSync(join(docs, 'a.md'), join(docs, 'link.md'));
        assert.equal((await cli(['--check-index', `--root=${root}`])).code, 1, 'the link makes it stale');
        await cli(['--write-index', `--root=${root}`]);
        assert.equal((await cli(['--check-index', `--root=${root}`])).code, 0);
        assert.match(indexOf(root), /link\.md/);
      },
    );
  });

  // The PARTITION itself, both sides of it — not one example. ENOENT and ENOTDIR are the only codes
  // that mean "nothing is there"; every other one leaves the kind UNKNOWN, and unknown must never
  // read as skip, because that is how a link standing where a directory would, with a whole .md
  // subtree behind it, escapes the gate again. An implementation that skipped EACCES, or that
  // refused on ENOTDIR, passes a single-code arm and fails this one.
  const STAT_CASES = [
    { code: 'ELOOP', named: true },
    { code: 'EACCES', named: true },
    { code: 'EIO', named: true },
    { code: 'ENOENT', named: false },
    { code: 'ENOTDIR', named: false },
  ];

  it('a link whose kind cannot be determined is NAMED, never skipped', async () => {
    for (const { code, named } of STAT_CASES) {
      await withRoot(
        ({ root, docs }) => {
          mkdirSync(join(root, 'elsewhere'));
          writeFileSync(join(root, 'elsewhere', 'hidden.md'), 'no frontmatter at all\n');
          symlinkSync(join(root, 'elsewhere'), join(docs, 'history'));
        },
        async ({ root }) => {
          const stat = async () => {
            throw Object.assign(new Error(`${code}: injected`), { code });
          };
          const { code: exit, stdout } = await runCli([`--root=${root}`], { stat });
          if (named) {
            assert.equal(exit, 1, code);
            assert.match(stdout, new RegExp(`docs/ai/history[\\s\\S]*?ERROR\\s+is a symlink this run could not classify \\(${code}\\)`), code);
          } else {
            assert.equal(exit, 0, code);
            assert.doesNotMatch(stdout, /docs\/ai\/history/, code);
          }
          assert.doesNotMatch(stdout, /hidden\.md/, code);
        },
      );
    }
  });
});

// Characterization, GREEN before the refusal landed as well as after — these two pin what the
// change must NOT move, so neither carries a red-proof record.
describe('check-docs-size — what the symlink refusal preserves', () => {
  it('a symlinked NON-.md regular file is still skipped', async () => {
    await withRoot(
      ({ root, docs }) => {
        writeFileSync(join(root, 'orchestration.json'), '{ "plan-authoring": { "review": "reviewed" } }\n');
        symlinkSync(join(root, 'orchestration.json'), join(docs, 'orchestration.json'));
      },
      async ({ root }) => {
        const { code, stdout } = await cli([`--root=${root}`]);
        assert.equal(code, 0);
        assert.doesNotMatch(stdout, /orchestration\.json/);
        assert.match(stdout, /1 files inspected {2}— {2}0 error/);
      },
    );
  });

  it('a DANGLING link that is not named .md is skipped — an unclassifiable link is not in scope', async () => {
    await withRoot(
      ({ root, docs }) => symlinkSync(join(root, 'never-existed.json'), join(docs, 'orchestration.json')),
      async ({ root }) => {
        // stat throws here, so the kind is unknowable — and the NAME never put it in scope, so it
        // stays as skipped as a real non-.md file. Only a name-based refusal survives a failed stat.
        const { code, stdout } = await cli([`--root=${root}`]);
        assert.equal(code, 0);
        assert.doesNotMatch(stdout, /orchestration\.json/);
        assert.match(stdout, /1 files inspected {2}— {2}0 error/);
      },
    );
  });

  it('an OVER-CAP real adr/ record still collapses — the guard keys on the refusal, not on errors', async () => {
    await withRoot(
      ({ docs }) => {
        mkdirSync(join(docs, 'adr'));
        // 12 body lines under a maxLines of 5: a genuine cap ERROR on a genuine record.
        writeFileSync(join(docs, 'adr', 'AD-001-fat.md'), DOC('AD-001', 5) + 'x\n'.repeat(12));
        writeFileSync(join(docs, 'adr', 'log.md'), DOC('log', 200));
      },
      async ({ root }) => {
        assert.equal((await cli(['--write-index', `--root=${root}`])).code, 1, 'the cap error still reds the run');
        assert.match(indexOf(root), /\| 1 records \|/);
        assert.doesNotMatch(indexOf(root), /AD-001-fat\.md/, 'an errored REAL record stays inside the collapse');
      },
    );
  });

  it('a tree with NO symlink under docs/ai writes a BYTE-IDENTICAL navigator', async () => {
    await withRoot(
      () => {},
      async ({ root }) => {
        const { code, stdout } = await cli([`--root=${root}`, '--today=2026-07-18', '--write-index']);
        assert.equal(code, 0);
        assert.match(stdout, /1 files inspected {2}— {2}0 error\(s\), 0 warning\(s\)/);
        // The WHOLE file, not a filtered row: header, preamble, table and footer alike are what a
        // symlink-free tree must keep producing.
        assert.equal(indexOf(root), EXPECTED_INDEX);
      },
    );
  });
});

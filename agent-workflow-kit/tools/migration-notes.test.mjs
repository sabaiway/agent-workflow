import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_WORKFLOW_VERSION as HEAD } from './cheap-agents-read.mjs';

const loaded = await import('./migration-notes.mjs').catch(() => ({}));
const main = loaded.main ?? (() => {
  throw new Error('migration-notes.mjs is absent');
});
const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, '..');
const MIGRATIONS = join(KIT, 'migrations');
const LF = String.fromCharCode(10);
const ABOVE_HEAD = `${Number(HEAD.split('.')[0]) + 1}.0.0`;
const NOTE_TEXT = `# A${LF}Body${LF}`;
const NOTES = [
  ['1.1.0-a.md', NOTE_TEXT],
  ['1.2.0-b.md', `# B${LF}Body${LF}`],
  ['1.10.0-c.md', `# C${LF}Body${LF}`],
  ['2.0.0-d.md', `# D${LF}Body${LF}`],
  ['README.md', 'Read the notes.'],
];
const OWN_NOTES = [
  ['1.1.0', '1.1.0-communication-language.md', 'Migration 1.1.0-communication-language'],
  ['1.2.0', '1.2.0-agent-attribution.md', 'Migration 1.2.0-agent-attribution'],
  ['3.0.0', '3.0.0-hardened-core-loop.md', 'Migration 3.0.0-hardened-core-loop'],
];
const roots = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});
const createFixture = ({ stamp = '1.0.0', stampKind = 'file', notesKind = 'directory', entries = NOTES } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'migration-notes-'));
  roots.push(root);
  const project = join(root, 'project');
  const stampPath = join(project, 'docs', 'ai', '.workflow-version');
  const notesDir = join(root, 'notes');
  mkdirSync(dirname(stampPath), { recursive: true });
  if (stampKind === 'file') {
    writeFileSync(stampPath, stamp);
  }
  if (stampKind === 'directory') {
    mkdirSync(stampPath);
  }
  if (stampKind === 'symlink') {
    writeFileSync(join(root, 'stamp-target'), stamp);
    symlinkSync(join(root, 'stamp-target'), stampPath);
  }
  if (notesKind === 'file') {
    writeFileSync(notesDir, 'not a directory');
  }
  if (notesKind === 'symlink') {
    mkdirSync(join(root, 'notes-target'));
    symlinkSync(join(root, 'notes-target'), notesDir);
  }
  if (notesKind === 'directory') {
    mkdirSync(notesDir);
    for (const [name, text, kind = 'file'] of entries) {
      const path = join(notesDir, name);
      if (kind === 'file') {
        writeFileSync(path, text);
      }
      if (kind === 'directory') {
        mkdirSync(path);
      }
      if (kind === 'symlink') {
        writeFileSync(join(root, 'note-target.md'), NOTE_TEXT);
        symlinkSync(join(root, 'note-target.md'), path);
      }
    }
  }
  return { project, notesDir };
};
const runFixture = async (fixture, argv = ['--cwd', fixture.project], own = false) => {
  const result = await main(argv, own ? {} : { notesDir: fixture.notesDir });
  assert.equal(typeof result.code, 'number');
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
  if (result.code === 0) {
    assert.notEqual(result.stdout, '');
  }
  return result;
};
const splitLines = (text) => (text.endsWith(LF) ? text.slice(0, -1) : text).split(LF);
const assertListing = (result, expected) => {
  assert.equal(result.code, 0);
  assert.deepEqual(splitLines(result.stdout), expected);
};
const assertRefusal = (result, name, mentions = []) => {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trimEnd().split(LF).length, 1);
  assert.match(result.stderr, new RegExp(`^${name}(:|$)`, 'm'));
  for (const text of mentions) {
    assert.ok(result.stderr.includes(text), text);
  }
};
const buildExpectedLines = (notesDir, start = 0) => NOTES.slice(start, -1).map(([name, text]) =>
  `note ${name.split('-')[0]} ${join(notesDir, name)} :: ${text.split(LF)[0].slice(2)}`);
const takeSnapshot = (path) => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return { kind: 'symlink', target: readlinkSync(path) };
  }
  if (stat.isFile()) {
    return { kind: 'file', bytes: readFileSync(path).toString('hex') };
  }
  assert.ok(stat.isDirectory(), path);
  return { kind: 'directory', entries: readdirSync(path).sort().map((name) => [name, takeSnapshot(join(path, name))]) };
};

describe('spec:upgrade-delivery/S1 selection and headlines', () => {
  for (const [title, stamp, start] of [
    ['numeric ordering', '1.0.0', 0],
    ['strictly newer notes', '1.2.0', 2],
    ['trimmed stamp', ` 1.0.0 ${LF}`, 0],
  ]) {
    it(title, async () => {
      const fixture = createFixture({ stamp });
      assertListing(await runFixture(fixture), buildExpectedLines(fixture.notesDir, start));
    });
  }
  it('uses the first level-one headline and trims it', async () => {
    const text = ['intro', '## Sub', '#   Spaced Title  ', '# Second'].join(LF);
    const fixture = createFixture({ entries: [['1.1.0-a.md', text]] });
    assertListing(await runFixture(fixture), [`note 1.1.0 ${join(fixture.notesDir, '1.1.0-a.md')} :: Spaced Title`]);
  });
  it('defaults to the running kit notes directory', async () => {
    const fixture = createFixture();
    const result = await runFixture(fixture, undefined, true);
    assertListing(result, OWN_NOTES.map(([version, name, title]) => `note ${version} ${resolve(MIGRATIONS, name)} :: ${title}`));
  });
});

describe('spec:upgrade-delivery/S2 stated empty selections', () => {
  for (const [title, options] of [
    ['equal head', { stamp: HEAD }],
    ['below head with older notes only', { stamp: '2.0.0', entries: [NOTES[0]] }],
    ['below head with README only', { stamp: '1.0.0', entries: [NOTES[4]] }],
  ]) {
    it(title, async () => {
      const result = await runFixture(createFixture(options));
      assert.equal(result.code, 0);
      assert.equal(splitLines(result.stdout).length, 1);
      assert.ok(!result.stdout.startsWith('note '));
      assert.ok(result.stdout.includes(HEAD));
      assert.ok(result.stdout.includes(options.stamp));
    });
  }
  for (const [title, options, refusal] of [
    ['headline defect', { entries: [['1.1.0-a.md', 'Body only']] }, 'note-headline'],
    ['absent directory', { notesKind: 'absent' }, 'notes-absent'],
  ]) {
    it(`checks ${title} even at the head`, async () => {
      assertRefusal(await runFixture(createFixture({ ...options, stamp: HEAD })), refusal);
    });
  }
});

describe('spec:upgrade-delivery/S3 stamp refusals', () => {
  it('reports a stamp read failure after a regular-file probe', async () => {
    const { project, notesDir } = createFixture();
    const readStamp = (path, encoding) => {
      if (path.endsWith('.workflow-version')) {
        throw new Error('read boom');
      }
      return readFileSync(path, encoding);
    };
    assertRefusal(await main(['--cwd', project], { notesDir, readFileSync: readStamp }), 'stamp-unreadable', ['read boom']);
  });
  for (const [kind, refusal, mentions] of [
    ['absent', 'stamp-absent', ['bootstrap']],
    ['symlink', 'stamp-unreadable', []],
    ['directory', 'stamp-unreadable', []],
  ]) {
    it(`refuses a stamp that is ${kind}`, async () => {
      assertRefusal(await runFixture(createFixture({ stampKind: kind })), refusal, mentions);
    });
  }
  for (const stamp of ['', `   ${LF}`, 'v1.0.0', '1.0', '1.0.0-beta', '1.0.0 1.1.0']) {
    it(`refuses unparseable stamp ${JSON.stringify(stamp)}`, async () => {
      assertRefusal(await runFixture(createFixture({ stamp })), 'stamp-unparseable');
    });
  }
  it('refuses a stamp above the head and names both versions', async () => {
    assertRefusal(await runFixture(createFixture({ stamp: ABOVE_HEAD })), 'stamp-above-head', [ABOVE_HEAD, HEAD]);
  });
});

describe('spec:upgrade-delivery/S4 notes directory refusals and ignored entries', () => {
  it('reports a note read failure after a regular-file probe', async () => {
    const { project, notesDir } = createFixture({ entries: [NOTES[0]] });
    const readNote = (path, encoding) => {
      if (path === join(notesDir, '1.1.0-a.md')) {
        throw new Error('read boom');
      }
      return readFileSync(path, encoding);
    };
    assertRefusal(await main(['--cwd', project], { notesDir, readFileSync: readNote }), 'notes-unreadable', ['read boom']);
  });
  it('reports a notes directory listing failure', async () => {
    const { project, notesDir } = createFixture();
    const listNotes = () => {
      throw new Error('list boom');
    };
    assertRefusal(await main(['--cwd', project], { notesDir, readdirSync: listNotes }), 'notes-unreadable', ['list boom']);
  });
  for (const kind of ['absent', 'file', 'symlink']) {
    it(`refuses a notes path that is ${kind}`, async () => {
      const result = await runFixture(createFixture({ notesKind: kind }));
      assertRefusal(result, kind === 'absent' ? 'notes-absent' : 'notes-unreadable');
    });
  }
  for (const [name, kind = 'file'] of [
    ['notes.md'], ['1.1.0.md'], ['v1.1.0-x.md'], ['1.1.0-Bad_Slug.md'], ['1.1.0-a--b.md'], ['1.2.3.4-hotfix.md'],
    ['1.1.0-dir.md', 'directory'], ['1.1.0-link.md', 'symlink'], ['README.md', 'directory'],
  ]) {
    it(`refuses entry ${name} (${kind})`, async () => {
      const fixture = createFixture({ entries: [[name, NOTE_TEXT, kind]] });
      assertRefusal(await runFixture(fixture), 'notes-entry', [name]);
    });
  }
  it('refuses a note above the head', async () => {
    const fixture = createFixture({ entries: [[`${ABOVE_HEAD}-x.md`, NOTE_TEXT]] });
    assertRefusal(await runFixture(fixture), 'note-above-head');
  });
  it('refuses duplicate versions', async () => {
    const fixture = createFixture({ entries: [NOTES[0], ['1.1.0-b.md', NOTE_TEXT]] });
    assertRefusal(await runFixture(fixture), 'note-version-twice');
  });
  for (const [title, text, stamp] of [
    ['missing headline', 'Body only', '1.0.0'],
    ['empty headline', `#    ${LF}Body`, '1.0.0'],
    ['control byte in headline', `# Bad${String.fromCharCode(1)}Title${LF}Body`, '1.0.0'],
    ['unselected defective note', 'Body only', '2.0.0'],
  ]) {
    it(`refuses ${title}`, async () => {
      assertRefusal(await runFixture(createFixture({ stamp, entries: [['1.1.0-x.md', text]] })), 'note-headline');
    });
  }
  it('names every ignored entry without changing the listing', async () => {
    const ignored = [['.DS_Store', 'metadata'], ['.hidden.md', 'hidden'], ['notes.txt', 'text'], ['drafts', '', 'directory']];
    const fixture = createFixture({ entries: [...NOTES, ...ignored] });
    const result = await runFixture(fixture);
    assertListing(result, buildExpectedLines(fixture.notesDir));
    const lines = splitLines(result.stderr);
    assert.equal(lines.length, ignored.length);
    for (const [name] of ignored) {
      assert.equal(lines.filter((line) => line.includes(name) && /\bignored\b/.test(line)).length, 1, name);
    }
  });
  it('suppresses ignored-entry output when refusing', async () => {
    const fixture = createFixture({ entries: [['.DS_Store', 'metadata'], ['notes.md', NOTE_TEXT]] });
    const result = await runFixture(fixture);
    assertRefusal(result, 'notes-entry', ['notes.md']);
    assert.ok(!result.stderr.includes('.DS_Store'));
  });
  it('accepts a slug with a single internal hyphen', async () => {
    const fixture = createFixture({ entries: [['1.1.0-a-b.md', NOTE_TEXT]] });
    assertListing(await runFixture(fixture), [`note 1.1.0 ${join(fixture.notesDir, '1.1.0-a-b.md')} :: A`]);
  });
});

describe('spec:upgrade-delivery/S5 read-only execution, head source and usage', () => {
  it('runs the repository CLI for a listing and missing arguments', () => {
    const { project } = createFixture();
    const cli = join(HERE, 'migration-notes.mjs');
    const listing = spawnSync(process.execPath, [cli, '--cwd', project], { encoding: 'utf8' });
    const lines = OWN_NOTES.map(([version, name, title]) => `note ${version} ${resolve(MIGRATIONS, name)} :: ${title}`);
    assert.equal(listing.status, 0, listing.stderr);
    assert.equal(listing.stdout, lines.join(LF) + LF);
    assert.equal(listing.stderr, '');
    const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    assert.equal(usage.status, 2, usage.stderr);
    assert.equal(usage.stdout, '');
  });
  for (const [title, options, code] of [
    ['listing', {}, 0],
    ['equal head', { stamp: HEAD }, 0],
    ['stamp-absent', { stampKind: 'absent' }, 1],
    ['notes-entry', { entries: [['notes.md', NOTE_TEXT]] }, 1],
    ['usage', {}, 2],
    ['own directory', {}, 0],
  ]) {
    it(`preserves every path, kind and byte after ${title}`, async () => {
      const fixture = createFixture(options);
      const paths = [fixture.project, fixture.notesDir, MIGRATIONS];
      const snapshots = paths.map(takeSnapshot);
      const argv = title === 'usage' ? ['--bogus'] : ['--cwd', fixture.project];
      const result = await runFixture(fixture, argv, title === 'own directory');
      assert.equal(result.code, code);
      if (code === 1) {
        assertRefusal(result, title);
      }
      assert.deepEqual(paths.map(takeSnapshot), snapshots);
    });
  }
  it('imports the read-only head with no private literal or process spawning', async () => {
    await runFixture(createFixture());
    const source = readFileSync(join(HERE, 'migration-notes.mjs'), 'utf8');
    assert.match(source, /import\s*\{[^}]*\bEXPECTED_WORKFLOW_VERSION\b[^}]*\}\s*from\s*['"]\.\/cheap-agents-read\.mjs['"]/);
    assert.ok(!source.includes('velocity-profile'));
    assert.doesNotMatch(source, /(?:from\s*|import\s*(?:\(\s*)?)['"]node:child_process['"]/);
    assert.doesNotMatch(source, /['"`][0-9]+\.[0-9]+\.[0-9]+['"`]/);
  });
  it('pins the two existing head copies equal', async () => {
    const other = await import('./velocity-profile.mjs');
    assert.equal(HEAD, other.EXPECTED_WORKFLOW_VERSION);
  });
  for (const stampKind of ['file', 'absent']) {
    for (const usage of ['unknown flag', 'duplicate cwd', 'missing cwd']) {
      it(`judges ${usage} before a ${stampKind} stamp`, async () => {
        const fixture = createFixture({ stampKind });
        const argv = usage === 'unknown flag' ? ['--bogus'] : usage === 'missing cwd' ? []
          : ['--cwd', fixture.project, '--cwd', fixture.project];
        const previous = process.cwd();
        process.chdir(fixture.project);
        try {
          assert.equal((await runFixture(fixture, argv)).code, 2);
        } finally {
          process.chdir(previous);
        }
      });
    }
  }
});

describe('spec:upgrade-delivery/S11 one source and documented delivery', () => {
  const readKit = (path) => readFileSync(join(KIT, path), 'utf8');
  const getStepSpan = (start, end) => {
    const lines = readKit('references/modes/upgrade.md').split(LF);
    const first = lines.findIndex((line) => line.startsWith(`${start}. `));
    const last = lines.findIndex((line, index) => index > first && line.startsWith(`${end}. `));
    assert.ok(first >= 0 && last > first);
    return lines.slice(first, last).join(LF);
  };
  it('keeps template block fragments and headings out of every migration file', () => {
    const template = readKit('references/templates/AGENTS.md').split(LF);
    const blocks = [
      ['## 🗣️ Communication language', '{{COMM_LANGUAGE}}'],
      ['## ✍️ Attribution', '{{AGENT_ATTRIBUTION}}'],
    ];
    for (const [heading, placeholder] of blocks) {
      const start = template.indexOf(heading);
      const next = template.findIndex((line, index) => index > start && line.startsWith('## '));
      assert.ok(start >= 0 && next > start);
      const fragments = template.slice(start, next).filter((line) => line.startsWith('> '))
        .flatMap((line) => line.split(placeholder)).map((text) => text.trim()).filter((text) => text.length >= 24);
      assert.ok(fragments.length > 0);
      for (const name of readdirSync(MIGRATIONS)) {
        const path = join(MIGRATIONS, name);
        if (!lstatSync(path).isFile()) {
          continue;
        }
        for (const line of readFileSync(path, 'utf8').split(LF)) {
          assert.notEqual(line.trim(), heading, name);
          for (const fragment of fragments) {
            assert.ok(!line.includes(fragment), `${name}: ${fragment}`);
          }
        }
      }
    }
  });
  for (const name of ['1.1.0-communication-language.md', '1.2.0-agent-attribution.md']) {
    it(`${name} names the block writer`, () => {
      assert.ok(readKit(`migrations/${name}`).includes('migration-blocks.mjs'));
    });
  }
  it('README names the note selector', () => {
    assert.ok(readKit('migrations/README.md').includes('migration-notes.mjs'));
  });
  it('step 6 runs the selector and relays its lines', () => {
    const text = getStepSpan(6, 7);
    assert.ok(text.includes('migration-notes.mjs --cwd'));
    assert.match(text, /\brelay\b/);
  });
  it('steps 6 and 7 handle apply, bootstrap and withheld answers', () => {
    const text = getStepSpan(6, 8);
    for (const token of ['migration-blocks.mjs', '--apply', 'stamp-absent', 'step 1', 'answer-missing', 'STOP']) {
      assert.ok(text.includes(token), token);
    }
  });
  it('keeps the settings step outside the attribution heading check', () => {
    const text = readKit('migrations/1.2.0-agent-attribution.md');
    assert.ok(text.includes('includeCoAuthoredBy'));
    for (const line of text.split(LF).filter((line) => line.includes('✍️ Attribution'))) {
      assert.ok(!line.includes('skip to Verification'));
    }
  });
});

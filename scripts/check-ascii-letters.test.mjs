// check-ascii-letters.test.mjs — the English-only invariant, proven the only way a mechanism can be:
// on real trees, with the character actually present in the bytes on disk.
//
// Every fixture writes its non-ASCII character through a `\uXXXX` escape. That is not a workaround
// for the suite — it is the documented workaround the checker exists to leave open, so the tests are
// also the specimen: escaped source, literal bytes at runtime.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, findNonAsciiLetters, judgeTree, judgeMessages, main } from './check-ascii-letters.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aw-ascii-letters-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

let seq = 0;
// A real repository, because the checker's scope is the git INDEX and a fixture that fakes the index
// would prove the checker agrees with the fake.
const repo = (files, { commitMessage = 'seed: fixture', commit = true } = {}) => {
  const cwd = join(TMP, `r${seq += 1}`);
  mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(cwd, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git(cwd, ['add', '-A']);
  if (commit) {
    git(cwd, ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', commitMessage]);
  }
  return cwd;
};

const capture = (argv, deps = {}) => {
  const lines = [];
  const code = main(argv, { log: (line) => lines.push(line), ...deps });
  return { code, text: lines.join('\n') };
};

describe('check-ascii-letters — the predicate is a NON-ASCII LETTER, never one alphabet', () => {
  // Four scripts, one property. A checker written against "no Cyrillic" passes three of these, which
  // is exactly how 9 of the 21 offending files stayed invisible until the predicate was fixed.
  for (const [name, ch] of [
    ['cyrillic', '\u0442'],
    ['latin-1 accented', '\u00e9'],
    ['cjk', '\u4e2d'],
    ['modifier letter U+02BC', '\u02bc'],
  ]) {
    it(`flags a ${name} letter`, () => {
      const hits = findNonAsciiLetters(`const x = '${ch}';`);
      assert.equal(hits.length, 1, `${name} must be caught`);
      assert.equal(hits[0].char, ch);
    });
  }

  // Typography is not a language. These all ride in this family's own prose and must stay legal, or
  // the gate would force an ASCII-only house style nobody asked for.
  for (const [name, ch] of [
    ['em dash', '—'],
    ['guillemets', '«'],
    ['curly apostrophe', '’'],
    ['arrow', '→'],
    ['less-or-equal', '≤'],
    ['bullet', '•'],
    ['emoji', '🧭'],
    ['combining acute', '́'],
    ['numero sign', '№'],
  ]) {
    it(`does NOT flag a ${name} — punctuation and symbols are not letters`, () => {
      assert.deepEqual(findNonAsciiLetters(`a ${ch} b`), []);
    });
  }

  it('an escaped source line is ASCII — the documented workaround really works', () => {
    assert.deepEqual(findNonAsciiLetters("const nonce = '\\u00e91';"), []);
  });

  it('reports line, column and codepoint so the finding is actionable', () => {
    const [hit] = findNonAsciiLetters(`ok\nab\u0442cd\n`);
    assert.equal(hit.line, 2);
    assert.equal(hit.column, 3);
    assert.equal(hit.codepoint, 'U+0442');
    assert.match(hit.excerpt, /ab/);
  });

  it('an astral letter is one finding, not two halves', () => {
    const hits = findNonAsciiLetters('x \ud835\udc00 y'); // MATHEMATICAL BOLD CAPITAL A
    assert.equal(hits.length, 1);
    assert.equal(hits[0].codepoint, 'U+1D400');
  });
});

describe('check-ascii-letters — the tracked tree', () => {
  it('a clean repository passes', () => {
    const result = judgeTree(repo({ 'a.mjs': "const x = 'plain ascii';\n", 'README.md': '# Title\n' }));
    assert.deepEqual(result.findings, []);
    assert.equal(result.judged, 2);
  });

  it('a tracked file carrying the character FAILS, naming the exact position', () => {
    const cwd = repo({ 'a.mjs': "const x = 1;\nconst bad = '\u0447\u0438\u0441\u0442\u043e';\n" });
    const result = judgeTree(cwd);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, 'a.mjs');
    assert.equal(result.findings[0].hits.length, 5, 'every letter of the word is a hit');
    assert.equal(result.findings[0].hits[0].line, 2);
  });

  it('an UNTRACKED file is out of scope — the invariant is about what ships', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' });
    writeFileSync(join(cwd, 'scratch.md'), 'a note with \u0442 in it\n');
    assert.deepEqual(judgeTree(cwd).findings, []);
  });

  // The NAME ships in the git tree exactly as the content does, so it is judged too.
  it('a tracked FILENAME carrying the character is caught, on the name surface', () => {
    const cwd = repo({ 'h\u00e9llo.mjs': 'const x = 1;\n' });
    const result = judgeTree(cwd);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].surface, 'name');
    assert.equal(result.findings[0].hits[0].codepoint, 'U+00E9');
  });

  // A symlink's blob IS its target string — content the tree ships. Reading the blob rather than the
  // filesystem is what makes a DANGLING target judgeable at all: there is nothing on disk to follow.
  it('a tracked symlink TARGET is judged, dangling or not', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' });
    symlinkSync('\u00e9-missing-target.txt', join(cwd, 'link'));
    git(cwd, ['add', '-A']);
    const result = judgeTree(cwd);
    assert.equal(result.findings.length, 1, 'the target string is tree content');
    assert.equal(result.findings[0].surface, 'symlink target');
    assert.equal(result.judged, 2, 'a dangling target is read from its blob like any other');
  });

  it('an ASCII symlink target passes and is never read as file content', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' });
    symlinkSync('a.mjs', join(cwd, 'link'));
    git(cwd, ['add', '-A']);
    assert.deepEqual(judgeTree(cwd).findings, []);
  });

  // A gitlink names a commit in ANOTHER repository, so there is no blob here to read; only its name
  // can be judged, and the batch reader must never be asked for it.
  it('a gitlink contributes its NAME and nothing else', () => {
    const enumerate = () => [{ mode: '160000', sha: 'f'.repeat(40), stage: 0, path: Buffer.from('vendor/s\u00fcb', 'utf8') }];
    const spawn = () => { throw new Error('a gitlink has no blob to fetch'); };
    const result = judgeTree(TMP, { enumerate, spawn });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].surface, 'name');
  });

  // The hole that "invalid UTF-8 means binary" would leave wide open: 0xE9 alone IS the letter this
  // gate exists to catch, and the file carries no NUL, so it is text — unreadable text, which the
  // checker refuses rather than passes.
  it('a NON-UTF-8 text file with no NUL byte REFUSES — it is not a binary', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' });
    writeFileSync(join(cwd, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    git(cwd, ['add', '-A']);
    assert.throws(() => judgeTree(cwd), /latin1\.txt: carries no NUL byte but is not valid UTF-8/);
  });

  it('a binary is skipped BY KIND and COUNTED — a skip nobody can see is a hole', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' });
    writeFileSync(join(cwd, 'blob.bin'), Buffer.from([0x00, 0xff, 0xfe, 0x42]));
    git(cwd, ['add', '-A']);
    const result = judgeTree(cwd);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.skippedBinary, ['blob.bin']);
    const shown = capture(['--cwd', cwd, '--no-messages']);
    assert.match(shown.text, /1 binary skipped by kind/);
    assert.match(shown.text, /blob\.bin/, 'and it is named, not just counted');
  });

  // The three situations that make a WORKTREE read report a green over bytes it never saw. Each of
  // them is ordinary, and each is why the checker reads the index instead.
  it('a tracked path deleted from the WORKTREE is still judged — the index is what ships', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n', 'gone.mjs': "const y = '\u0442';\n" });
    rmSync(join(cwd, 'gone.mjs'));
    const result = judgeTree(cwd);
    assert.equal(result.judged, 2, 'a missing worktree file has no bearing on what the commit carries');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].path, 'gone.mjs');
  });

  it('a STAGED blob is judged even when the worktree copy is clean', () => {
    const cwd = repo({ 'a.mjs': "const bad = '\u0442';\n" });
    writeFileSync(join(cwd, 'a.mjs'), "const good = 'ascii';\n");
    const result = judgeTree(cwd);
    assert.equal(result.findings.length, 1, 'the staged wording is the one that would be committed');
    assert.equal(result.findings[0].surface, 'content');
  });

  it('a file the worktree does not hold at all is still judged from its blob', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n', 'sparse.md': 'plain\n' });
    rmSync(join(cwd, 'sparse.md'));
    assert.equal(judgeTree(cwd).judged, 2);
  });

  // A name that is not valid UTF-8 cannot be printed back losslessly, so the checker refuses rather
  // than address a file by a name that is not the file's name. Injected: git will not let a fixture
  // repository hold an invalid name on every platform, and the refusal must still be proven.
  it('a tracked path whose NAME is not valid UTF-8 refuses, naming the bytes', () => {
    const enumerate = () => [{ mode: '100644', stage: 0, path: Buffer.from([0xff, 0x2e, 0x6d, 0x6a, 0x73]) }];
    assert.throws(() => judgeTree(TMP, { enumerate }), /not valid UTF-8 \(bytes ff2e6d6a73\)/);
  });

  it('a batch reader that cannot run at all is a usage refusal, not a pass', () => {
    const enumerate = () => [{ mode: '100644', sha: 'a'.repeat(40), stage: 0, path: Buffer.from('a.mjs', 'utf8') }];
    const spawn = () => ({ error: new Error('git is gone'), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    assert.throws(() => judgeTree(TMP, { enumerate, spawn }), /the index blobs could not be read \(git is gone\)/);
  });

  // A short batch — fewer records back than object ids sent — must never read as "those paths were
  // fine". The two arms are distinct: git SAYING `missing`, and git saying nothing at all.
  it('a blob the batch never returned refuses — never a silent skip', () => {
    const enumerate = () => [{ mode: '100644', sha: 'b'.repeat(40), stage: 0, path: Buffer.from('quiet.mjs', 'utf8') }];
    const spawn = () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
    assert.throws(() => judgeTree(TMP, { enumerate, spawn }), /quiet\.mjs: the index names blob b{40} but git returned nothing/);
  });

  it('an object the index names but git cannot produce refuses — never a silent skip', () => {
    const enumerate = () => [{ mode: '100644', sha: '0'.repeat(40), stage: 0, path: Buffer.from('ghost.mjs', 'utf8') }];
    const spawn = () => ({ status: 0, stdout: Buffer.from(`${'0'.repeat(40)} missing\n`, 'utf8'), stderr: Buffer.alloc(0) });
    assert.throws(() => judgeTree(TMP, { enumerate, spawn }), /cannot read|nothing for it/);
  });

  // The blob's bytes are the target string, so an undecodable one is caught by the same strict
  // decode as any other content: a lossy read would turn 0xE9 into U+FFFD, which is not a letter.
  it('a symlink target that is not valid UTF-8 refuses rather than decoding lossily', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' });
    symlinkSync(Buffer.from([0x63, 0xe9]), join(cwd, 'link'));
    git(cwd, ['add', '-A']);
    assert.throws(() => judgeTree(cwd), /link: carries no NUL byte but is not valid UTF-8/);
  });

  it('an UNMERGED index refuses — an ambiguous index is never judged green', () => {
    const enumerate = () => [
      { mode: '100644', stage: 2, path: Buffer.from('a.mjs', 'utf8') },
      { mode: '100644', stage: 3, path: Buffer.from('a.mjs', 'utf8') },
    ];
    assert.throws(() => judgeTree(TMP, { enumerate }), /UNMERGED/);
  });

  it('an empty tracked tree refuses — never an empty green', () => {
    assert.throws(() => judgeTree(TMP, { enumerate: () => [] }), /empty tree is a broken invocation/);
  });

  it('a failed enumeration is a usage refusal, not a pass', () => {
    const enumerate = () => { throw new Error('git is gone'); };
    const result = capture(['--cwd', TMP], { enumerate });
    assert.equal(result.code, EXIT.usage);
    assert.match(result.text, /REFUSED/);
    assert.match(result.text, /git is gone/);
  });
});

describe('check-ascii-letters — commit messages', () => {
  it('a message carrying the character is flagged, with its short sha', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' }, { commitMessage: 'feat: \u0433\u043e\u0442\u043e\u0432\u043e' });
    const result = judgeMessages(cwd);
    assert.equal(result.commits, 1);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].sha.length, 12);
    assert.equal(result.findings[0].hits[0].codepoint, 'U+0433');
  });

  it('clean messages pass, and the count is reported', () => {
    const result = judgeMessages(repo({ 'a.mjs': 'const x = 1;\n' }, { commitMessage: 'feat: plain' }));
    assert.deepEqual(result.findings, []);
    assert.equal(result.commits, 1);
  });

  // Same lossy-decode hole as the symlink target, one layer over: an undecodable message byte would
  // become U+FFFD and pass the predicate by being unreadable.
  //
  // Driven through the spawn seam, and that is the honest shape rather than a shortcut: `git commit`
  // TRANSCODES a non-UTF-8 message on the way in (probed — a lone 0xE9 is warned about and stored as
  // C3 A9), so this repository's own git cannot produce the input. The arm exists for a history git
  // did not write this way: an `i18n.commitEncoding` project, or one imported by other tooling.
  it('a commit message that is not valid UTF-8 refuses rather than decoding lossily', () => {
    const stdout = Buffer.concat([
      Buffer.from('0123456789abcdef0123456789abcdef01234567\0feat: ', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from('\0', 'utf8'),
    ]);
    const spawn = () => ({ status: 0, stdout, stderr: Buffer.alloc(0) });
    assert.throws(() => judgeMessages(TMP, { spawn }), /not valid UTF-8/);
  });

  it('a repository with no commits yet is not a failure', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' }, { commit: false });
    assert.deepEqual(judgeMessages(cwd), { commits: 0, findings: [] });
  });

  it('--no-messages judges the files only', () => {
    const cwd = repo({ 'a.mjs': 'const x = 1;\n' }, { commitMessage: 'feat: \u0433\u043e\u0442\u043e\u0432\u043e' });
    assert.equal(capture(['--cwd', cwd, '--no-messages']).code, EXIT.ok);
    assert.equal(capture(['--cwd', cwd]).code, EXIT.finding);
  });
});

describe('check-ascii-letters — the CLI contract', () => {
  it('PASS is exit 0 and says what it judged', () => {
    const result = capture(['--check', '--cwd', repo({ 'a.mjs': 'const x = 1;\n' })]);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.text, /PASS — 1 tracked path\(s\) and 1 commit message\(s\)/);
    assert.match(result.text, /names, index contents and symlink targets all judged/);
  });

  it('FAIL is exit 1, names the file and prints the escape remedy', () => {
    const result = capture(['--cwd', repo({ 'a.mjs': "const bad = '\u0442';\n" })]);
    assert.equal(result.code, EXIT.finding);
    assert.match(result.text, /a\.mjs \(content\):1:14 — U\+0442/);
    assert.match(result.text, /\\uXXXX escape/);
  });

  // The per-file listing is capped so one bad file cannot bury the report — and a cap that is not
  // announced reads as "that was all of it", which is the silent truncation this family forbids.
  it('a capped per-file listing SAYS how many it did not print', () => {
    const cwd = repo({ 'a.mjs': "const bad = '\u043c\u043d\u043e\u0433\u043e\u0431\u0430\u0439\u0442';\n" });
    const result = capture(['--cwd', cwd, '--no-messages']);
    assert.equal(result.code, EXIT.finding);
    assert.match(result.text, /a\.mjs: \+4 more not listed/, '9 letters, 5 listed, the rest counted');
  });

  it('--help prints the usage and exits 0', () => {
    const result = capture(['--help']);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.text, /--no-messages judges the tracked files only/);
  });

  it('an unrecognised argument is exit 2 with the usage, never a silent pass', () => {
    const result = capture(['--strict']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.text, /unrecognised argument --strict/);
    assert.match(result.text, /Usage:/);
  });

  it('--cwd without a directory is exit 2', () => {
    assert.equal(capture(['--cwd']).code, EXIT.usage);
  });
});

// The rung that makes the checker real: a tool nobody declared is a tool nobody runs.
//
// `docs/ai/` is MACHINE-LOCAL in this repository (git-ignored by design, AD-006), so a clean clone
// carries no gate declaration to read — and a suite that assumed one would crash with ENOENT
// everywhere but this machine. The predicate is therefore two-sided and non-vacuous: where a
// declaration exists it MUST run the checker and the suite, and where `docs/ai` itself is absent
// there is nothing to declare. What it still catches — a deployment that keeps a declaration and
// drops this gate out of it — is exactly the drift worth catching.
describe('check-ascii-letters — the gate is DECLARED wherever a declaration exists', () => {
  const gatesPath = join(REPO_ROOT, 'docs/ai/gates.json');
  const readDeclaration = () => (existsSync(gatesPath) ? JSON.parse(readFileSync(gatesPath, 'utf8')) : null);

  it('a declaration that exists runs this checker', () => {
    const declaration = readDeclaration();
    if (declaration === null) {
      assert.equal(existsSync(join(REPO_ROOT, 'docs/ai')), false, 'a docs/ai WITHOUT gates.json is a broken deployment, not a clean clone');
      return;
    }
    const gate = declaration.gates.find((entry) => entry.cmd.includes('check-ascii-letters.mjs'));
    assert.ok(gate, 'the English-only invariant must be a declared gate, not a tool somebody remembers to run');
    assert.match(gate.cmd, /^node scripts\/check-ascii-letters\.mjs/);
  });

  it('a declaration that exists runs this suite in its unit-test matrix', () => {
    const declaration = readDeclaration();
    if (declaration === null) {
      assert.equal(existsSync(join(REPO_ROOT, 'docs/ai')), false);
      return;
    }
    const unit = declaration.gates.find((entry) => entry.id === 'unit-tests');
    assert.match(unit.cmd, /scripts\/check-ascii-letters\.test\.mjs/);
  });
});

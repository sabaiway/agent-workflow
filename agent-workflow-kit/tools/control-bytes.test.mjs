// control-bytes.test.mjs — the red-first suite for docs/ai/specs/kit/control-bytes.md S1-S6, plus
// the byte-domain claims pinned by that live spec. Real repositories through the hostile
// harness; spawn, fs and env injected where a class cannot be built on disk. The tool and the two
// leaf exports are imported DYNAMICALLY so the suite loads and FAILS on the pre-fix tree.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripGitLocationEnv } from './git-env.mjs';
import { fixtures, makeRepo, skipWithoutGit } from './hostile-git-harness.test.mjs';

const tool = await import('./control-bytes.mjs').catch(() => ({}));
const lex = await import('./repo-lex.mjs');
const nofollow = await import('./fs-read-nofollow.mjs');
const { main, CONTROL_BYTES_GIT_ARGV, READ_CAP } = tool;
const MODE_DOC = new URL('../references/modes/control-bytes.md', import.meta.url);
const TOOL_PATH = fileURLToPath(new URL('./control-bytes.mjs', import.meta.url));
const KIT_REPO_ROOT = dirname(dirname(dirname(TOOL_PATH)));

const run = (f, argv = ['--check'], deps = {}) => main(argv, { cwd: f.cwd, env: f.env, ...deps });
const text = (r) => r.lines.join('\n');
const withRepo = (body, files) => {
  const r = makeRepo('control-bytes', files);
  try {
    return body(r);
  } finally {
    r.cleanup();
  }
};
const withFixture = (build, body) => {
  const f = build();
  try {
    return body(f);
  } finally {
    f.cleanup();
  }
};
const REFUSED = new Set([...Array.from({ length: 9 }, (_, i) => i), 0x0b, 0x0c, ...Array.from({ length: 18 }, (_, i) => 0x0e + i), 0x7f]);
const ioThrowing = (match, code) => ({
  open: (path, flags) => {
    if (String(path).endsWith(match)) throw Object.assign(new Error(code), { code });
    return tool.defaultIo.open(path, flags);
  },
});

describe('control-bytes — S1 the domain and the three surfaces', { skip: skipWithoutGit }, () => {
  // spec:control-bytes/S1
  it('S1: tracked plus untracked-not-ignored from the work-tree root, judged from a subdirectory cwd; an ignored byte is outside the domain', () => withRepo((r) => {
    r.write('.gitignore', 'ignored.bin\n');
    r.write('ignored.bin', 'x\0y');
    mkdirSync(join(r.dir, 'sub'));
    r.write('sub/untracked.txt', 'a\0b');
    const result = main(['--check'], { cwd: join(r.dir, 'sub'), env: r.env });
    assert.equal(result.code, 1, text(result));
    assert.match(text(result), /^sub\/untracked\.txt content offset 1: 0x00$/mu);
    assert.doesNotMatch(text(result), /ignored\.bin/u);
    assert.match(text(result), /paths judged: 3 /u, 'f.txt, .gitignore and the untracked file');
  }));
  it('S1: the name is always judged, a symlink target is judged and never followed, a gitlink is name-only, a never-committable stat class is skipped by kind and counted', () => withRepo((r) => {
    writeFileSync(join(r.dir, 'na\x01me.txt'), 'clean\n');
    symlinkSync('tar\x02get-nowhere', join(r.dir, 'link'));
    const sha = r.must(['rev-parse', 'HEAD']);
    r.must(['update-index', '--add', '--cacheinfo', `160000,${sha},gi\x03tlink`]);
    // git lists no FIFO, socket or device under --others, so the class is reached the way a sandbox
    // mask reaches it: an lstat that reports a never-committable kind for a path git named.
    writeFileSync(join(r.dir, 'masked.txt'), '\0');
    writeFileSync(join(r.dir, 'turned.txt'), '\0');
    const lie = { isSymbolicLink: () => false, isFile: () => false };
    const lstat = (path) => (String(path).endsWith('masked.txt') ? { ...lie, isDirectory: () => false } : String(path).endsWith('turned.txt') ? { ...lie, isDirectory: () => true } : lstatSync(path));
    const result = run(r, ['--check'], { io: { lstat } });
    assert.equal(result.code, 1);
    assert.match(text(result), /^na\\u\{1\}me\.txt name offset 2: 0x01$/mu);
    assert.match(text(result), /^link symlink-target offset 3: 0x02$/mu);
    assert.match(text(result), /^gi\\u\{3\}tlink name offset 2: 0x03$/mu);
    assert.doesNotMatch(text(result), /absent|gitlink content|masked\.txt content/u, 'the link is never followed, the gitlink and the masked path have no content surface');
    assert.match(text(result), /REFUSED — turned\.txt: unreadable \(a directory where git named a file\)/u, 'a slash-less entry that became a directory is a refusal, never a nested-repository skip');
    assert.match(text(result), /paths judged: 6 · skipped by attribute: 0 · skipped by kind: 1 · findings: 3/u);
  }));
  it('S1: an untracked nested repository is name-only and counted as a skip by kind, never refused', () => withRepo((r) => {
    const nested = join(r.dir, 'nes\x01ted');
    mkdirSync(nested);
    r.must(['init', '-q'], { cwd: nested });
    writeFileSync(join(nested, 'inner.txt'), 'x\0');
    const result = run(r);
    assert.equal(result.code, 1);
    assert.match(text(result), /^nes\\u\{1\}ted\/ name offset 3: 0x01$/mu);
    assert.match(text(result), /skipped by kind: 1 /u);
    assert.doesNotMatch(text(result), /inner\.txt|REFUSED/u);
  }));
  it('S1: a sparse checkout — a tracked skip-worktree path missing from the work tree is a counted skip, never a refusal; present again, its content is judged', () => withRepo((r) => {
    r.write('sparse.txt', 'clean\n');
    r.must(['add', 'sparse.txt']);
    r.must(['commit', '-qm', 'sparse']);
    r.must(['update-index', '--skip-worktree', 'sparse.txt']);
    rmSync(join(r.dir, 'sparse.txt'));
    const gone = run(r);
    assert.equal(gone.code, 0, text(gone));
    assert.match(text(gone), /skipped by kind: 1 /u);
    writeFileSync(join(r.dir, 'sparse.txt'), '\0');
    const back = run(r);
    assert.equal(back.code, 1);
    assert.match(text(back), /^sparse\.txt content offset 0: 0x00$/mu);
  }));
  it('S4: an over-cap symlink target names the link remedy, never .gitattributes', () => withRepo((r) => {
    symlinkSync('f.txt', join(r.dir, 'ln'));
    r.must(['add', 'ln']);
    r.must(['commit', '-qm', 'link']);
    rmSync(join(r.dir, 'ln'));
    writeFileSync(join(r.dir, 'ln'), 'file-now');
    const spawn = (cmd, args, opts) => (args[0] === 'config' ? { status: 0, stdout: Buffer.from('false\n'), stderr: Buffer.alloc(0) } : spawnSync(cmd, args, opts));
    const io = { fstat: (fd) => ({ ...tool.defaultIo.fstat(fd), isFile: () => true }), read: (fd, buf, offset, length) => { buf.fill(0x61, offset, offset + length); return length; } };
    const result = run(r, ['--check'], { spawn, io });
    assert.equal(result.code, 1);
    assert.match(text(result), /ln: over the read cap .*restore the link or shorten its target/u);
    assert.doesNotMatch(text(result), /ln: over the read cap .*gitattributes/u);
  }));
  it('S1: a host that materialises symlinks (core.symlinks=false) judges a tracked symlink\'s placeholder file as its target, never refuses it', () => withRepo((r) => {
    symlinkSync('f.txt', join(r.dir, 'ln'));
    r.must(['add', 'ln']);
    r.must(['commit', '-qm', 'link']);
    rmSync(join(r.dir, 'ln'));
    writeFileSync(join(r.dir, 'ln'), 'tar\x02get');
    const spawn = (cmd, args, opts) => (args[0] === 'config' ? { status: 0, stdout: Buffer.from('false\n'), stderr: Buffer.alloc(0) } : spawnSync(cmd, args, opts));
    const result = run(r, ['--check'], { spawn });
    assert.equal(result.code, 1);
    assert.match(text(result), /^ln symlink-target offset 3: 0x02$/mu);
    assert.doesNotMatch(text(result), /REFUSED/u);
  }));
  it('S1: the kind is the index mode for a tracked path and the lstat for an untracked one — a tracked symlink replaced by a regular file is unreadable', () => withRepo((r) => {
    symlinkSync('f.txt', join(r.dir, 'ln'));
    r.must(['add', 'ln']);
    r.must(['commit', '-qm', 'link']);
    spawnSync('rm', [join(r.dir, 'ln')]);
    writeFileSync(join(r.dir, 'ln'), 'now a file\n');
    const result = run(r);
    assert.equal(result.code, 1);
    assert.match(text(result), /REFUSED — .*ln.*unreadable.*symlink/u);
  }));
});

describe('control-bytes — S2 the byte predicate and the injective render', () => {
  // spec:control-bytes/S2
  it('S2: exactly 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F and 0x7F refuse; TAB, LF, CR and every byte at or above 0x80 pass', () => {
    for (let byte = 0; byte < 256; byte += 1) assert.equal(lex.isRefusedControlByte(byte), REFUSED.has(byte), `byte 0x${byte.toString(16)}`);
  });
  it('S2: a finding names path, surface, offset and hex; TAB, LF, CR and 0xE9 in content pass', { skip: skipWithoutGit }, () => withRepo((r) => {
    writeFileSync(join(r.dir, 'ok.txt'), Buffer.from([0x61, 0x09, 0x0a, 0x0d, 0xe9, 0x0a]));
    assert.equal(run(r).code, 0, text(run(r)));
    writeFileSync(join(r.dir, 'x.txt'), 'ab\x0bc\x1fd');
    const result = run(r);
    assert.equal(result.code, 1);
    assert.match(text(result), /^x\.txt content offset 2: 0x0b \(\+1 more\)$/mu);
  }));
  it('S2: the render is injective — a raw byte, the literal escape text, an invalid byte, a line separator and a backslash all render apart, never a raw byte or U+FFFD', () => {
    const render = lex.renderPathForDisplay;
    assert.equal(render(Buffer.from('a\x01b')), 'a\\u{1}b');
    assert.equal(render(Buffer.from('a\\u{1}b')), 'a\\\\u{1}b');
    assert.equal(render(Buffer.from([0x61, 0xff, 0x62])), 'a\\xffb');
    assert.equal(render(Buffer.from(`a${String.fromCharCode(0x2028)}b`)), 'a\\u{2028}b');
    const acute = `caf${String.fromCharCode(0xe9)}`; // a non-ASCII LETTER stays an escape in source (the ascii-letters gate)
    assert.equal(render(Buffer.from(acute)), acute);
    assert.equal(render(Buffer.from(`a${String.fromCharCode(0xfffd)}b`)), 'a\\u{fffd}b', 'a VALID U+FFFD renders as its code point, so no line ever carries one');
    assert.equal(render(Buffer.from([0x61, 0xef, 0xbf, 0x62])), 'a\\xef\\xbfb', 'a truncated two-byte prefix of a three-byte sequence renders byte by byte');
    assert.notEqual(render(Buffer.from('a\x01b')), render(Buffer.from('a\\x01b')));
    for (const sample of [Buffer.from([0x00, 0x1b, 0x7f, 0xc3, 0xa9, 0xc3]), Buffer.from(`${String.fromCharCode(0x2029)} \\`)]) {
      const out = render(sample);
      for (const ch of out) assert.ok(ch.codePointAt(0) >= 0x20 && ![0x7f, 0xfffd, 0x2028, 0x2029].includes(ch.codePointAt(0)), `no raw control byte or U+FFFD in ${JSON.stringify(out)}`);
    }
  });
});

describe('control-bytes — S3 binary by attribute only', { skip: skipWithoutGit }, () => {
  // spec:control-bytes/S3
  it('S3: a binary or -diff attributed path skips content only and is named; its bad name still refuses; an unattributed NUL is a finding whatever the extension', () => withRepo((r) => {
    r.write('.gitattributes', 'blob.bin binary\nnodiff.dat -diff\nba*.bin binary\n');
    r.write('blob.bin', 'x\0y');
    r.write('nodiff.dat', 'x\0y');
    r.write('ba\x01d.bin', 'x\0y');
    r.write('image.png', 'PNG\0');
    r.write('big.txt', 'a'.repeat(200_000));
    const result = run(r);
    assert.equal(result.code, 1);
    assert.match(text(result), /skipped by attribute: 3 /u);
    assert.match(text(result), /^skipped by attribute: blob\.bin$/mu);
    assert.match(text(result), /^skipped by attribute: nodiff\.dat$/mu);
    assert.match(text(result), /^ba\\u\{1\}d\.bin name offset 2: 0x01$/mu);
    assert.match(text(result), /^image\.png content offset 3: 0x00$/mu);
    assert.doesNotMatch(text(result), /blob\.bin content|nodiff\.dat content|big\.txt/u);
  }));
  it('S3: an attribute skip covers the content only — a skipped path that vanished is absent, one replaced by a symlink or unreadable refuses, never a silent skip', () => withRepo((r) => {
    r.write('.gitattributes', '*.bin binary\n');
    r.write('gone.bin', 'x\0');
    r.write('link.bin', 'y\0');
    r.write('locked.bin', 'z\0');
    r.must(['add', '-A']);
    r.must(['commit', '-qm', 'binaries']);
    rmSync(join(r.dir, 'gone.bin'));
    rmSync(join(r.dir, 'link.bin'));
    symlinkSync('f.txt', join(r.dir, 'link.bin'));
    const result = run(r, ['--check'], { io: ioThrowing('locked.bin', 'EACCES') });
    assert.equal(result.code, 1);
    assert.match(text(result), /REFUSED — gone\.bin: absent/u);
    assert.match(text(result), /REFUSED — link\.bin: unreadable \(a symlink where git named a file\)/u);
    assert.match(text(result), /REFUSED — locked\.bin: unreadable \(EACCES\)/u);
    assert.match(text(result), /skipped by attribute: 0 /u);
  }));
  it('S3: the attribute answer is git\'s own under the caller\'s env — a global attributes file marking a path binary is honoured and named', () => withRepo((r) => {
    mkdirSync(join(r.home, 'git'), { recursive: true });
    writeFileSync(join(r.home, 'git', 'attributes'), '*.dat binary\n');
    r.write('raw.dat', 'x\0y');
    const result = run(r);
    assert.equal(result.code, 0, text(result));
    assert.match(text(result), /^skipped by attribute: raw\.dat$/mu);
  }));
});

describe('control-bytes — S4 the closed refusal table', { skip: skipWithoutGit }, () => {
  // spec:control-bytes/S4
  it('S4: an unreadable path (EACCES) is distinct from an absent one (ENOENT); both refuse', () => withRepo((r) => {
    r.write('gone.txt', 'g\n');
    r.write('locked.txt', 'l\n');
    const absent = run(r, ['--check'], { io: ioThrowing('gone.txt', 'ENOENT') });
    assert.equal(absent.code, 1);
    assert.match(text(absent), /REFUSED — gone\.txt: absent \(git named it, it vanished before the read\)/u);
    const unreadable = run(r, ['--check'], { io: ioThrowing('locked.txt', 'EACCES') });
    assert.equal(unreadable.code, 1);
    assert.match(text(unreadable), /REFUSED — locked\.txt: unreadable \(EACCES\)/u);
  }));
  it('S4: a tracked path missing from the work tree is absent with the deletion named, not a read race', () => withRepo((r) => {
    rmSync(join(r.dir, 'f.txt'));
    const result = run(r);
    assert.equal(result.code, 1);
    assert.match(text(result), /REFUSED — f\.txt: absent \(tracked but missing from the work tree — stage the deletion with git rm or git add -A, or it vanished before the read\)/u);
  }));
  it('S4: a failing, a killed and an absent git each refuse with their own message', () => {
    withFixture(() => fixtures.killedGit(['ls-files']), (f) => {
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(text(result), /REFUSED — git ls-files -s -z was killed by SIGKILL/u);
    });
    withFixture(fixtures.absentGit, (f) => {
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(text(result), /ENOENT/u);
    });
    withRepo((r) => {
      const spawn = (cmd, args, opts) => (args[0] === 'check-attr' ? { status: 129, stdout: Buffer.alloc(0), stderr: Buffer.from('boom') } : spawnSync(cmd, args, opts));
      const result = run(r, ['--check'], { spawn });
      assert.equal(result.code, 1);
      assert.match(text(result), /REFUSED — git check-attr --stdin -z binary diff exited 129 \(boom\)/u);
    });
  });
  it('S4: an unmerged index and an empty domain each refuse', () => {
    withFixture(fixtures.unmerged, (f) => {
      const result = run(f);
      assert.equal(result.code, 1);
      assert.match(text(result), /REFUSED — the git index is UNMERGED/u);
    });
    withRepo((r) => {
      r.must(['rm', '-q', 'f.txt']);
      r.must(['commit', '-qm', 'empty']);
      const result = run(r);
      assert.equal(result.code, 1);
      assert.match(text(result), /REFUSED — the domain is EMPTY/u);
    });
  });
  it('S4: a file over the read cap refuses, read as at most cap+1 bytes on the descriptor and never by trusting the fstat size', () => withRepo((r) => {
    let served = 0;
    const io = {
      fstat: (fd) => ({ ...tool.defaultIo.fstat(fd), size: 1, isFile: () => true }),
      read: (fd, buf, offset, length) => {
        served += length;
        buf.fill(0x61, offset, offset + length);
        return length;
      },
    };
    const result = run(r, ['--check'], { io });
    assert.equal(result.code, 1);
    assert.match(text(result), new RegExp(`REFUSED — f\\.txt: over the read cap \\(${READ_CAP} bytes\\).*declare the path binary in \\.gitattributes`, 'u'));
    assert.equal(served, READ_CAP + 1, 'exactly cap+1 bytes were asked of the descriptor');
  }));
  it('S4: every location that is not a work tree refuses by its own state name', () => {
    for (const [state, build] of [['not-a-repository', fixtures.notARepository], ['redirected', fixtures.redirectedGitDir], ['env-only', fixtures.envOnly], ['no-work-tree', fixtures.bare], ['no-work-tree', fixtures.insideGitDir]]) {
      withFixture(build, (f) => {
        const result = run(f);
        assert.equal(result.code, 1, state);
        assert.match(text(result), new RegExp(`REFUSED — the git location is ${state}`, 'u'));
      });
    }
    withFixture(fixtures.hookShapedEnv, (f) => assert.equal(run(f).code, 0, 'a hook-shaped env agrees and passes'));
  });
});

describe('control-bytes — S5 the exit table, --cwd and the seams', { skip: skipWithoutGit }, () => {
  // spec:control-bytes/S5
  it('S5: exit 0 clean, 1 a finding, 2 usage — an unknown argument, a valueless --cwd and a --cwd that is not a directory are usage', () => withRepo((r) => {
    assert.equal(run(r).code, 0);
    assert.equal(run(r, []).code, 0, 'the plain run shares the exit table');
    for (const argv of [['--bogus'], ['--cwd'], ['--cwd', join(r.dir, 'missing')], ['--cwd', join(r.dir, 'f.txt')], ['--check', 'extra']]) {
      const result = main(argv, { cwd: r.dir, env: r.env });
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(text(result), /^control-bytes: usage — /u);
    }
    r.write('n.txt', '\0');
    assert.equal(run(r).code, 1);
    assert.equal(run(r, []).code, 1);
  }));
  it('S5: --cwd anchors at that directory\'s work-tree root, whatever the process cwd', () => withRepo((r) => {
    mkdirSync(join(r.dir, 'deep', 'er'), { recursive: true });
    r.write('deep/er/n.txt', 'a\0');
    const result = main(['--check', '--cwd', join(r.dir, 'deep', 'er')], { cwd: '/', env: r.env });
    assert.equal(result.code, 1);
    assert.match(text(result), new RegExp(`^control-bytes: work tree ${r.dir.replaceAll('.', '\\.')}$`, 'mu'));
    assert.match(text(result), /^deep\/er\/n\.txt content offset 1: 0x00$/mu);
  }));
  it('S5: main returns and never exits; spawn, fs and env are injected', () => withRepo((r) => {
    const seen = [];
    const spawn = (cmd, args, opts) => {
      seen.push(args);
      return spawnSync(cmd, args, opts);
    };
    const exit = process.exit;
    process.exit = () => { throw new Error('process.exit was called'); };
    try {
      const result = run(r, ['--check'], { spawn, env: { ...r.env, GIT_DIR: join(r.dir, '.git') } });
      assert.equal(result.code, 0, text(result));
    } finally {
      process.exit = exit;
    }
    assert.ok(seen.some((args) => args[0] === 'ls-files'), 'the injected spawn carried the domain query');
  }));
});

describe('control-bytes — S6 read-only, the declared argv, the gate line', { skip: skipWithoutGit }, () => {
  // spec:control-bytes/S6
  const listing = (dir) => readdirSync(dir, { recursive: true }).sort();
  it('S6: the tool writes nothing and spawns only its declared read-only git argv (plus the location leaf\'s rev-parse probes)', () => withRepo((r) => {
    r.write('n.txt', '\0');
    const before = listing(r.dir);
    const seen = [];
    const spawn = (cmd, args, opts) => {
      seen.push({ cmd, args });
      return spawnSync(cmd, args, opts);
    };
    run(r, ['--check'], { spawn });
    assert.deepEqual(listing(r.dir), before, 'no file appeared');
    assert.equal(r.git(['status', '--porcelain']).stdout.toString('utf8').trim(), '?? n.txt', 'the index moved nothing');
    const declared = CONTROL_BYTES_GIT_ARGV.map((args) => JSON.stringify(args));
    for (const { cmd, args } of seen) {
      assert.equal(cmd, 'git');
      assert.ok(args[0] === 'rev-parse' || declared.includes(JSON.stringify(args)), `undeclared spawn: ${args.join(' ')}`);
    }
    assert.deepEqual(CONTROL_BYTES_GIT_ARGV, [['ls-files', '-s', '-z'], ['ls-files', '--others', '--exclude-standard', '-z'], ['check-attr', '--stdin', '-z', 'binary', 'diff'], ['config', '--type=bool', '--get', 'core.symlinks'], ['ls-files', '-v', '-z']]);
  }));
  it('S6: the gate line exits 0 on this tree', () => {
    const result = main(['--check'], { cwd: KIT_REPO_ROOT, env: process.env });
    assert.equal(result.code, 0, text(result));
  });
  it('S6: a NUL written into a test source flips the gate from 0 to 1, and the CLI prints the report before its exit code', () => withRepo((r) => {
    r.write('x.test.mjs', 'const s = String.fromCharCode(0);\n');
    const cli = (args) => spawnSync(process.execPath, [TOOL_PATH, ...args], { cwd: r.dir, env: r.env, encoding: 'utf8', windowsHide: true });
    assert.equal(cli(['--check']).status, 0);
    r.write('x.test.mjs', 'const s = \'\0\';\n');
    const red = cli(['--check']);
    assert.equal(red.status, 1);
    assert.match(red.stdout, /^control-bytes: work tree /u);
    assert.match(red.stdout, /^x\.test\.mjs content offset 11: 0x00$/mu);
    assert.equal(cli(['--bogus']).status, 2);
  }));
  it('a raw byte never renders as the literal text \\xNN: a name spelled with the four characters and a name carrying the byte render apart', () => withRepo((r) => {
    writeFileSync(join(r.dir, 'a\\x01b.txt'), '\0');
    writeFileSync(join(r.dir, 'a\x01b.txt'), '\0');
    const lines = text(run(r)).split('\n');
    assert.ok(lines.some((line) => line.startsWith('a\\\\x01b.txt content')), 'the literal text doubles its backslash');
    assert.ok(lines.some((line) => line.startsWith('a\\u{1}b.txt name')), 'the raw byte renders as its code point');
  }));
});

describe('the leaves the gate rides', () => {
  it('the GIT_ strip judges the ASCII-cased prefix and nothing else — Unicode case folding never widens it', () => {
    const dotless = `g${String.fromCharCode(0x131)}t_dir`; // Turkish dotless i uppercases to I — a FOREIGN variable
    assert.deepEqual(stripGitLocationEnv({ git_dir: 'a', Git_Work_Tree: 'b', GIT_DIR: 'c', PATH: 'p', GITHUB_TOKEN: 't', [dotless]: 'x' }), { PATH: 'p', GITHUB_TOKEN: 't', [dotless]: 'x' });
  });
  it('without O_NOFOLLOW or O_NONBLOCK the capped read and the kind probe refuse before any open', () => {
    let opened = 0;
    const io = { constants: { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 }, open: () => { opened += 1; return 3; } };
    assert.equal(nofollow.readFileBytesNoFollowCapped('/x', 10, io).outcome, 'error');
    assert.equal(nofollow.probeRegularFileNoFollow('/x', io).outcome, 'error');
    assert.equal(opened, 0, 'no descriptor is ever opened without the no-follow guarantee');
  });
  it('the mode doc\'s candidate gate line parses as JSON and quotes the tool path', () => {
    const doc = readFileSync(MODE_DOC, 'utf8').replace(/\n\s+/gu, ' ');
    const candidate = doc.match(/`(\{ "id": "control-bytes".*?\})`/u);
    assert.ok(candidate !== null, 'the doc carries the candidate line');
    assert.equal(JSON.parse(candidate[1]).cmd, 'node "<path-to-this-skill>/tools/control-bytes.mjs" --check');
  });
});

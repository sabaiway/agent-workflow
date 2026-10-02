// spec:jev-guide — docs/ai/specs/kit/jev-guide/jev-connect.md
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loaded = await import('../jev-connect.mjs').catch(() => ({}));
const absent = (name) => () => { throw new Error(`${name} is absent`); };
const targetsFor = loaded.targetsFor ?? absent('targetsFor');
const managedLine = loaded.managedLine ?? absent('managedLine');
const upsertManagedLine = loaded.upsertManagedLine ?? absent('upsertManagedLine');
const saveKey = loaded.saveKey ?? absent('saveKey');
const KEY = 'TYPESAFE_API_KEY';
const MARK = '# agent-workflow jev';
const HOME = '/h/user';
const HOSTILE = ['tsk-plain123', "it's got a quote", 'sp ace $dollar `tick`', 'dq"semi;', 'back\\slash'];
const LEGACY = (key) => `export ${KEY}=${key}`;

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-save-'));
  made.push(dir);
  return dir;
};
// A fake home: the files that exist and their bytes.
const fakeFs = (files) => ({ exists: (path) => Object.hasOwn(files, path), read: (path) => files[path] });
const at = (name) => join(HOME, name);
// The target descriptors: the export form per path, the fish form under a config dir, the windows form.
const ex = (...paths) => paths.map((path) => ({ form: 'export', path }));
const fish = (config) => [{ form: 'fish', path: join(config, 'fish', 'conf.d', 'typesafe-api-key.fish') }];
const WINDOWS = [{ form: 'windows', path: null }];

describe('spec:jev-guide/S25 the save rule: the targets by shell', () => {
  const CELLS = [
    ['zsh, no ZDOTDIR', { shell: '/bin/zsh' }, {}, ex(at('.zshrc'))],
    ['zsh, ZDOTDIR set', { shell: '/usr/local/bin/zsh', zdotdir: '/h/user/.config/zsh' }, {}, ex('/h/user/.config/zsh/.zshrc')],
    ['zsh, ZDOTDIR empty', { shell: 'zsh', zdotdir: '' }, {}, ex(at('.zshrc'))],
    ['bash, no login file', { shell: '/bin/bash' }, {}, ex(at('.bashrc'), at('.bash_profile'))],
    ['bash, .profile only', { shell: 'bash' }, { [at('.profile')]: '# login\n' }, ex(at('.bashrc'), at('.profile'))],
    ['bash, .bash_login and .profile', { shell: '/bin/bash' }, { [at('.bash_login')]: '', [at('.profile')]: '. ~/.bashrc\n' }, ex(at('.bashrc'), at('.bash_login'))],
    ['bash, .bash_profile first of three', { shell: '/bin/bash' }, { [at('.bash_profile')]: '# x\n', [at('.bash_login')]: '', [at('.profile')]: '' }, ex(at('.bashrc'), at('.bash_profile'))],
    ['bash, .bash_profile sources .bashrc: still both', { shell: '/bin/bash' }, { [at('.bash_profile')]: '[ -f ~/.bashrc ] && . ~/.bashrc\n' }, ex(at('.bashrc'), at('.bash_profile'))],
    ['bash, the sourcing line commented out', { shell: '/bin/bash' }, { [at('.bash_profile')]: '  # . ~/.bashrc\n' }, ex(at('.bashrc'), at('.bash_profile'))],
    ['bash, .profile sources .bashrc but .bash_profile exists', { shell: '/bin/bash' }, { [at('.bash_profile')]: '# x\n', [at('.profile')]: '. ~/.bashrc\n' }, ex(at('.bashrc'), at('.bash_profile'))],
    ['fish, no XDG_CONFIG_HOME', { shell: '/usr/bin/fish' }, {}, fish(at('.config'))],
    ['fish, XDG_CONFIG_HOME absolute', { shell: 'fish', xdgConfigHome: '/x/cfg' }, {}, fish('/x/cfg')],
    ['fish, XDG_CONFIG_HOME relative is ignored', { shell: '/usr/bin/fish', xdgConfigHome: 'cfg' }, {}, fish(at('.config'))],
    ['fish, XDG_CONFIG_HOME empty', { shell: '/usr/bin/fish', xdgConfigHome: '' }, {}, fish(at('.config'))],
    ['win32 under bash', { shell: '/bin/bash', platform: 'win32' }, {}, WINDOWS],
    ['win32 under fish', { shell: '/usr/bin/fish', platform: 'win32' }, {}, WINDOWS],
    ['win32, an absent SHELL', { platform: 'win32' }, {}, WINDOWS],
    ['win32, an empty home', { shell: '/bin/bash', platform: 'win32', home: '' }, {}, WINDOWS],
    ...['/bin/ksh', '/bin/dash', '/bin/tcsh', '/bin/bashful', undefined, ''].map((shell) => [`no target: SHELL ${JSON.stringify(shell)}`, { shell }, {}, []]),
    ['an empty home off win32', { shell: '/bin/bash', home: '' }, {}, []],
  ];
  for (const [name, input, files, expected] of CELLS) {
    it(name, () => {
      assert.deepEqual(targetsFor({ home: HOME, ...input }, fakeFs(files)), expected);
    });
  }

  it('no file content decides the targets: the login file is never read', () => {
    const files = { [at('.bash_profile')]: '. ~/.bashrc\n' };
    const reads = [];
    const deps = { exists: (path) => Object.hasOwn(files, path), read: (path) => { reads.push(path); return files[path]; } };
    assert.deepEqual(targetsFor({ shell: '/bin/bash', home: HOME }, deps), ex(at('.bashrc'), at('.bash_profile')));
    assert.deepEqual(reads, []);
  });

  it('a login file that sources .bashrc and then exports an older key reads the new key after the save', () => {
    const which = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' });
    if (which.status !== 0) { console.log('# skip: bash is not installed'); return; }
    const home = tmp();
    writeFileSync(join(home, '.bashrc'), '');
    writeFileSync(join(home, '.bash_profile'), `. ~/.bashrc\n${LEGACY('old')}\n`);
    const targets = targetsFor({ shell: '/bin/bash', home });
    assert.deepEqual(targets, ex(join(home, '.bashrc'), join(home, '.bash_profile')));
    assert.ok(saveKey('k-new', targets, home).every(({ saved }) => saved));
    const back = spawnSync('bash', ['--noprofile', '--norc', '-c', `. "$HOME/.bash_profile"; printf %s "$${KEY}"`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.deepEqual([back.status, back.stdout], [0, 'k-new'], back.stderr);
  });
});

describe('the managed line and the upsert (S25, continued)', () => {
  it('quotes the key for bash and zsh and ends with the mark', () => {
    assert.equal(managedLine('plain'), `export ${KEY}='plain'  ${MARK}`);
    assert.equal(managedLine("it's"), `export ${KEY}='it'\\''s'  ${MARK}`);
  });

  it('appends on its own line to an empty, a newline-ended and an unterminated file', () => {
    const line = managedLine('k');
    assert.equal(upsertManagedLine('', line), `${line}\n`);
    assert.equal(upsertManagedLine('a\nb\n', line), `a\nb\n${line}\n`);
    assert.equal(upsertManagedLine('a\nb', line), `a\nb\n${line}\n`);
  });

  it('replaces every prior export line, the earlier kit\'s form included, in place with the managed line, its indent kept', () => {
    const line = managedLine('new');
    const prior = `# head\n${LEGACY("'old one'")}\nalias x=y\n  export ${KEY}=old2  ${MARK}\n# export ${KEY}=commented\ntail\n`;
    assert.equal(upsertManagedLine(prior, line), `# head\n${line}\nalias x=y\n  ${line}\n# export ${KEY}=commented\ntail\n`);
  });

  it('keeps an if/else whose branches each hold only an export line valid: no branch is emptied, bash -n passes and both branches read the key', () => {
    const prior = `if [ -n "$A" ]; then\n  ${LEGACY('a')}\nelse\n  ${LEGACY('b')}\nfi\n`;
    const line = managedLine('k-new');
    assert.equal(upsertManagedLine(prior, line), `if [ -n "$A" ]; then\n  ${line}\nelse\n  ${line}\nfi\n`);
    const which = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' });
    if (which.status !== 0) { console.log('# skip: bash is not installed'); return; }
    const home = tmp();
    const file = join(home, '.bashrc');
    writeFileSync(file, prior);
    assert.ok(saveKey('k-new', ex(file), home)[0].saved);
    const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    for (const branch of ['', 'set']) {
      const back = spawnSync('bash', ['-c', `. "$1"; printf %s "$${KEY}"`, 'bash', file], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, A: branch } });
      assert.deepEqual([back.status, back.stdout], [0, 'k-new'], `A=${branch} ${back.stderr}`);
    }
  });

  it('keeps every other byte: CRLF lines, tabs and a trailing space survive', () => {
    const line = managedLine('k');
    const prior = `a\t \r\n${LEGACY('x')}\r\nb\r\n`;
    assert.equal(upsertManagedLine(prior, line), `a\t \r\n${line}\r\nb\r\n`);
  });
});

describe('saveKey on a real tree (S25, continued)', () => {
  it('creates a new file 0600 with the one line and keeps an existing file\'s mode and other bytes', () => {
    const home = tmp();
    const fresh = join(home, '.bashrc');
    const kept = join(home, '.bash_profile');
    writeFileSync(kept, `# mine\n${LEGACY('old')}\nexport PATH=$PATH:/x\n`);
    chmodSync(kept, 0o644);
    const results = saveKey('k1', ex(fresh, kept), home);
    assert.deepEqual(results.map(({ saved, line }) => [saved, line]), [[true, `saved: ${fresh}`], [true, `saved: ${kept}`]]);
    assert.equal(readFileSync(fresh, 'utf8'), `${managedLine('k1')}\n`);
    assert.equal(statSync(fresh).mode & 0o777, 0o600);
    assert.equal(readFileSync(kept, 'utf8'), `# mine\n${managedLine('k1')}\nexport PATH=$PATH:/x\n`);
    assert.equal(statSync(kept).mode & 0o777, 0o644);
  });

  it('refuses a link and a directory with their lines and never writes through them; names a failing write by its code', () => {
    const home = tmp();
    writeFileSync(join(home, 'real'), 'untouched\n');
    symlinkSync(join(home, 'real'), join(home, '.zshrc'));
    mkdirSync(join(home, '.bashrc'));
    const results = saveKey('k', ex(join(home, '.zshrc'), join(home, '.bashrc'), join(home, 'missing-dir', '.profile')), home);
    assert.deepEqual(results.map(({ saved }) => saved), [false, false, false]);
    assert.equal(results[0].line, `not saved: ${join(home, '.zshrc')} is a link — nothing written`);
    assert.equal(results[1].line, `not saved: ${join(home, '.bashrc')} is not a regular file`);
    assert.equal(results[2].line, `not saved: ${join(home, 'missing-dir', '.profile')} — ENOENT`);
    assert.equal(readFileSync(join(home, 'real'), 'utf8'), 'untouched\n');
    assert.ok(lstatSync(join(home, '.zshrc')).isSymbolicLink());
  });

  it('refuses a target under a linked directory mid-path below the home and a target outside the home, writing through neither', () => {
    const home = tmp();
    mkdirSync(join(home, 'dotfiles', 'zsh', 'rc'), { recursive: true });
    mkdirSync(join(home, '.config'));
    symlinkSync(join(home, 'dotfiles', 'zsh'), join(home, '.config', 'zsh'));
    const linked = join(home, '.config', 'zsh', 'rc', '.zshrc');
    const outside = join(tmp(), '.zshrc');
    const results = saveKey('k', ex(linked, outside), home);
    assert.deepEqual(results.map(({ saved, line }) => [saved, line]), [
      [false, `not saved: ${linked} — ${join(home, '.config', 'zsh')} is a link — nothing written`],
      [false, `not saved: ${outside} is outside the home — nothing written`]]);
    assert.deepEqual([existsSync(join(home, 'dotfiles', 'zsh', 'rc', '.zshrc')), existsSync(outside)], [false, false]);
  });

  for (const shell of ['bash', 'zsh']) {
    it(`five hostile keys read back byte-equal through ${shell} sourcing the written file`, () => {
      const which = spawnSync('sh', ['-c', `command -v ${shell}`], { encoding: 'utf8' });
      if (which.status !== 0) { console.log(`# skip: ${shell} is not installed`); return; }
      for (const key of HOSTILE) {
        const home = tmp();
        const file = join(home, shell === 'zsh' ? '.zshrc' : '.bashrc');
        writeFileSync(file, `${LEGACY('stale')}\n`);
        assert.ok(saveKey(key, ex(file), home)[0].saved, key);
        const back = spawnSync(shell, ['-c', `. "$1"; printf %s "$${KEY}"`, shell, file], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
        assert.deepEqual([back.status, back.stdout], [0, key], `${shell}: ${key} ${back.stderr}`);
        assert.equal(readFileSync(file, 'utf8').split('\n').filter((line) => line.includes(`export ${KEY}`)).length, 1, key);
      }
    });
  }
});

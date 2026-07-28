import { describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from './_expect-shim.mjs';
import {
  parseKnownIssues,
  classifySection,
  buildResolvedFile,
} from './archive-issues.mjs';

const FM = '---\ntype: reference\nlastUpdated: 2026-05-24\nmaxLines: 240\n---\n';
const CUTOFF = new Date('2026-05-20T00:00:00Z');

describe('parseKnownIssues', () => {
  it('extracts frontmatter and each ### section', () => {
    const text = `${FM}\n# Known Issues\n\n## High\n\n### Issue-001: foo\n\nbody one.\n\n### ~~Issue-002: bar~~\n\nbody two.\n`;
    const parsed = parseKnownIssues(text);
    expect(parsed.frontmatter).toBe(FM);
    const issueSections = parsed.sections.filter((s) => s.heading !== null);
    expect(issueSections).toHaveLength(2);
    expect(issueSections[0].heading).toBe('### Issue-001: foo');
  });

  it('treats body before any ### as a preamble section', () => {
    const text = `${FM}\n# Header\n\npreamble text\n\n### Issue-001: foo\n\nbody.\n`;
    const parsed = parseKnownIssues(text);
    expect(parsed.sections[0].heading).toBeNull();
    expect(parsed.sections[0].lines.join('\n')).toContain('preamble text');
  });
});

describe('classifySection', () => {
  const cutoff = new Date('2026-05-20T00:00:00Z'); // 14 days before today=2026-05-24 ... actually let's use real cutoff math

  it('returns preamble when heading is null', () => {
    expect(classifySection({ heading: null, lines: [] }, cutoff).kind).toBe('preamble');
  });

  it('returns open when issue heading is not strikethrough', () => {
    const section = {
      heading: '### Issue-013: example open issue',
      lines: ['### Issue-013: example open issue', '', '**Status:** Accepted'],
    };
    expect(classifySection(section, cutoff).kind).toBe('open');
  });

  it('returns archivable when strikethrough AND FIXED date older than cutoff', () => {
    const section = {
      heading: '### ~~Issue-001: example fixed feature~~',
      lines: ['### ~~Issue-001: example fixed feature~~', '', '**Status:** ✅ FIXED (2026.04.10)'],
    };
    const result = classifySection(section, cutoff);
    expect(result.kind).toBe('archivable');
    expect(result.fixedDate.toISOString().slice(0, 10)).toBe('2026-04-10');
  });

  it('returns fixed-recent when strikethrough AND FIXED date newer than cutoff', () => {
    const section = {
      heading: '### ~~Issue-015: example recently-fixed item~~',
      lines: ['### ~~Issue-015: example recently-fixed item~~', '', '**Status:** ✅ FIXED (2026.05.23)'],
    };
    expect(classifySection(section, cutoff).kind).toBe('fixed-recent');
  });

  it('returns fixed-undated when strikethrough has no FIXED date', () => {
    const section = {
      heading: '### ~~Issue-002: example undated-fixed item~~',
      lines: ['### ~~Issue-002: example undated-fixed item~~', '', '**Status:** ✅ FIXED'],
    };
    expect(classifySection(section, cutoff).kind).toBe('fixed-undated');
  });
});

// Phase 2 (the tokenizer contract): section boundaries are heading TOKENS — column-0 level-3
// headings outside fences — and an ISSUE-shaped heading anywhere else is loud, never silently
// glued or silently split. The marker/section-model contract (category H2s, the resolved set)
// is Phase 3 and is deliberately NOT pinned here.
describe('sections split only at real heading tokens', () => {
  const FENCE = '```';

  it('a prose H3 section is never classified as an issue', () => {
    const text = `${FM}\n# Known Issues\n\n### Issue-001 — real\n\nbody.\n\n### The 2026-07-02 upgrade-session misreport — closed\n\nprose section body.\n`;
    const { sections } = parseKnownIssues(text);
    const prose = sections.find((s) => s.heading !== null && /misreport/.test(s.heading));
    expect(Boolean(prose)).toBe(true);
    expect(classifySection(prose, CUTOFF).kind).toBe('other');
  });

  it('an issue-shaped heading inside a fence never starts a section', () => {
    const text = `${FM}\n# Known Issues\n\n### Issue-001 — teaches the form\n\nWrite issues like:\n\n${FENCE}markdown\n### Issue-999 — a fenced sample\n${FENCE}\n\nend.\n`;
    const { sections } = parseKnownIssues(text);
    const issueSections = sections.filter((s) => s.heading !== null);
    expect(issueSections).toHaveLength(1);
    expect(issueSections[0].lines.join('\n')).toContain('Issue-999');
  });

  it('an unclosed fence refuses loudly naming its opening line', () => {
    const text = `${FM}\n# Known Issues\n\n### Issue-001 — x\n\n${FENCE}markdown\n### Issue-002 — hidden\n`;
    let threw = null;
    try {
      parseKnownIssues(text, 'docs/ai/known_issues.md');
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(threw.exitCode).toBe(1);
    expect(threw.message).toMatch(/never closed/);
  });

  it('a wrong-level or indented issue heading refuses naming file and line', () => {
    for (const bad of ['## Issue-020 — wrong level', '#### Issue-021 — too deep', '  ### Issue-022 — indented', '###  Issue-123 — double space', '###\tIssue-124 — tab separated']) {
      const text = `${FM}\n# Known Issues\n\n### Issue-001 — good\n\nbody.\n\n${bad}\n\norphan body.\n`;
      let threw = null;
      try {
        parseKnownIssues(text, 'ki.md');
      } catch (err) {
        threw = err;
      }
      expect(threw).not.toBeNull();
      expect(threw.exitCode).toBe(1);
      expect(threw.message).toMatch(/^ki\.md:\d+:/);
    }
  });

  it('a CRLF file classifies identically to its LF twin', () => {
    const lf = `${FM}\n# Known Issues\n\n### ~~Issue-002 — struck~~\n\n**Status:** ✅ FIXED (2026.04.10)\n\n### Issue-003 — open\n\nbody.\n`;
    const kinds = (text) =>
      parseKnownIssues(text)
        .sections.filter((s) => s.heading !== null)
        .map((s) => classifySection(s, CUTOFF).kind);
    expect(kinds(lf.replace(/\n/g, '\r\n'))).toEqual(kinds(lf));
  });
});

// Arm B at the CLI seam. `runCli` is imported dynamically so this file still LOADS against an
// archiver that predates it — the tests then fail as honest reds instead of taking the whole
// suite down with a module-load error.
describe('reading modes agree on refusal and write nothing', () => {
  const seedTree = (dir, text) => {
    mkdirSync(join(dir, 'docs/ai'), { recursive: true });
    writeFileSync(join(dir, 'docs/ai/known_issues.md'), text, 'utf8');
  };
  const malformed = `${FM}\n# Known Issues\n\n### Issue-001 — good\n\nbody.\n\n## Issue-020 — wrong level\n\norphan body.\n`;

  for (const mode of [['--check'], ['--dry-run'], []]) {
    it(`${JSON.stringify(mode)} refuses the same malformed heading with exit 1 and leaves the tree untouched`, async () => {
      const { runCli } = await import('./archive-issues.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
      try {
        seedTree(dir, malformed);
        const before = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
        const errs = [];
        const code = runCli(mode, { root: dir, log: () => {}, logError: (m) => errs.push(m) });
        expect(code).toBe(1);
        expect(errs.join('\n')).toContain('docs/ai/known_issues.md:');
        expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(before);
        expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('the check verdict names the counts it acted on', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, `${FM}\n# Known Issues\n\n### Issue-001 — open one\n\n**Status:** Open\n\n### ~~Issue-002 — struck~~\n\n**Status:** ✅ FIXED (2026.05.23)\n`);
      const logs = [];
      const code = runCli(['--check', '--today=2026-05-24'], { root: dir, log: (m) => logs.push(m), logError: (m) => logs.push(m) });
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('2 issue sections');
      expect(out).toContain('0 archivable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rotation end to end through runCli', () => {
  const seedTree = (dir, text) => {
    mkdirSync(join(dir, 'docs/ai'), { recursive: true });
    writeFileSync(join(dir, 'docs/ai/known_issues.md'), text, 'utf8');
  };
  const MIXED = `${FM}\n# Known Issues\n\n### ~~Issue-001 — done long ago~~\n\n- **Status:** ✅ FIXED (2026.04.10)\n\n### Issue-002 — still open\n\n**Status:** Open\n`;

  it('a default run archives the struck dated issue and keeps the open one', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, MIXED);
      const code = runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} });
      expect(code).toBe(0);
      const resolved = readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8');
      expect(resolved).toContain('Issue-001');
      const kept = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      expect(kept).toContain('Issue-002');
      expect(kept).not.toContain('Issue-001');
      expect(runCli(['--check', '--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('check fails naming the archivable set; dry-run prints the plan and writes nothing', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, MIXED);
      const errs = [];
      expect(runCli(['--check', '--today=2026-07-28'], { root: dir, log: () => {}, logError: (m) => errs.push(m) })).toBe(1);
      expect(errs.join('\n')).toContain('Issue-001');
      const logs = [];
      expect(runCli(['--dry-run', '--today=2026-07-28'], { root: dir, log: (m) => logs.push(m), logError: () => {} })).toBe(0);
      expect(logs.join('\n')).toContain('archivable: 1');
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a nothing-to-archive run names the counts; help 0, unknown argument 2, missing file 1', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, `${FM}\n# Known Issues\n\n### Issue-002 — still open\n\n**Status:** Open\n`);
      const logs = [];
      expect(runCli(['--today=2026-07-28'], { root: dir, log: (m) => logs.push(m), logError: () => {} })).toBe(0);
      expect(logs.join('\n')).toContain('nothing to archive');
      expect(logs.join('\n')).toContain('1 issue sections');
      const help = [];
      expect(runCli(['--help'], { root: dir, log: (m) => help.push(m), logError: () => {} })).toBe(0);
      expect(help.join('\n')).toContain('Usage');
      const errs = [];
      expect(runCli(['--wat'], { root: dir, log: () => {}, logError: (m) => errs.push(m) })).toBe(2);
      expect(errs.join('\n')).toContain('unknown argument');
      const missing = [];
      const empty = mkdtempSync(join(tmpdir(), 'archive-issues-'));
      try {
        expect(runCli([], { root: empty, log: () => {}, logError: (m) => missing.push(m) })).toBe(1);
        expect(missing.join('\n')).toContain('not found');
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildResolvedFile', () => {
  it('writes new file with header + frontmatter when existing is empty', () => {
    const result = buildResolvedFile(
      '',
      [{ heading: '### ~~Issue-001~~', lines: ['### ~~Issue-001~~', '', '**Status:** ✅ FIXED (2026.01.01)'] }],
      '2026-05-24',
    );
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/maxLines: 3500/);
    expect(result).toMatch(/# Resolved Issues/);
    expect(result).toMatch(/### ~~Issue-001~~/);
  });

  it('appends new sections to existing content without re-emitting the header', () => {
    const existing = '---\ntype: history\nlastUpdated: 2026-04-01\nmaxLines: 3500\n---\n\n# Resolved Issues\n\n### ~~Issue-000~~\n\nold body.\n';
    const result = buildResolvedFile(
      existing,
      [{ heading: '### ~~Issue-099~~', lines: ['### ~~Issue-099~~', '', 'new body.'] }],
      '2026-05-24',
    );
    expect(result.split('# Resolved Issues').length).toBe(2); // header appears exactly once
    expect(result).toMatch(/### ~~Issue-099~~/);
    expect(result).toMatch(/### ~~Issue-000~~/);
  });
});

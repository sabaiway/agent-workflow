import { describe, it } from 'node:test';
import { expect } from './_expect-shim.mjs';
import {
  parseKnownIssues,
  classifySection,
  buildResolvedFile,
} from './archive-issues.mjs';

const FM = '---\ntype: reference\nlastUpdated: 2026-05-24\nmaxLines: 240\n---\n';

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

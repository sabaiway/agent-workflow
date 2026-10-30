import { describe, it } from 'node:test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect } from './_expect-shim.mjs';
import {
  parseKnownIssues,
  classifySection,
  buildResolvedFile,
} from './archive-issues.mjs';

const FM = '---\ntype: reference\nlastUpdated: 2026-05-24\nmaxLines: 240\n---\n';
const CUTOFF = new Date('2026-05-20T00:00:00Z');
// Past every real-corpus resolution date, so the exact real-world marker strings classify archivable.
const LATE_CUTOFF = new Date('2026-08-20T00:00:00Z');
const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// A hand-built section in the parser's shape: the heading line is lines[0].
const sec = (heading, ...body) => ({ heading, lines: [heading, ...body] });

describe('parseKnownIssues — the section model', () => {
  it('extracts frontmatter, file-structural chunks, and each ### section', () => {
    const text = `${FM}\n# Known Issues\n\n## High\n\n### Issue-001: foo\n\nbody one.\n\n### ~~Issue-002: bar~~\n\nbody two.\n`;
    const parsed = parseKnownIssues(text);
    expect(parsed.frontmatter).toBe(FM);
    const issueSections = parsed.sections.filter((s) => s.structural === false);
    expect(issueSections).toHaveLength(2);
    expect(issueSections[0].heading).toBe('### Issue-001: foo');
    const category = parsed.sections.find((s) => s.heading === '## High');
    expect(Boolean(category)).toBe(true);
    expect(category.structural).toBe(true);
  });

  it('treats body before any boundary as a structural preamble chunk', () => {
    const text = `${FM}\n# Header\n\npreamble text\n\n### Issue-001: foo\n\nbody.\n`;
    const parsed = parseKnownIssues(text);
    expect(parsed.sections[0].heading).toBeNull();
    expect(parsed.sections[0].structural).toBe(true);
    expect(parsed.sections[0].lines.join('\n')).toContain('preamble text');
  });

  // Phase 3.1 (L8): category H2s, the preamble and the trailing footer belong to the FILE — an
  // issue section contains only its own issue, so a rotation can never carry them into an archive.
  it('a category H2 between two issues belongs to the file, not to the preceding issue', () => {
    const text = `${FM}\n# Known Issues\n\n### ~~Issue-001 — done~~\n\n- **Status:** ✅ FIXED (2026.04.10)\n\n## 🟢 Resolved\n\n### Issue-002 — listed resolved\n\n- **Resolved:** 2026-04-11 — fixed.\n`;
    const parsed = parseKnownIssues(text);
    const first = parsed.sections.find((s) => s.heading !== null && s.heading.includes('Issue-001'));
    expect(first.lines.join('\n')).not.toContain('## 🟢 Resolved');
    const category = parsed.sections.find((s) => s.heading === '## 🟢 Resolved');
    expect(Boolean(category)).toBe(true);
    expect(category.structural).toBe(true);
  });

  it('the trailing separator and closing note parse as a FILE chunk, not the last issue body', () => {
    const text = `${FM}\n# Known Issues\n\n### ~~Issue-001 — done~~\n\n- **Status:** ✅ FIXED (2026.04.10)\n\n---\n\n> Resolved issues older than the window are rotated to \`history/issues-resolved.md\` by the issue-archive script.\n`;
    const parsed = parseKnownIssues(text);
    const issue = parsed.sections.find((s) => s.heading !== null && s.heading.includes('Issue-001'));
    expect(issue.lines.join('\n')).not.toContain('> Resolved issues');
    const footer = parsed.sections[parsed.sections.length - 1];
    expect(footer.structural).toBe(true);
    expect(footer.lines.join('\n')).toContain('---');
    expect(footer.lines.join('\n')).toContain('> Resolved issues');
  });

  // CommonMark allows 0-3 leading spaces on a thematic break — an indented separator before the
  // canonical note is still the FILE footer, so a rotation can never carry the note away.
  it('an indented CommonMark separator still introduces the canonical footer', async () => {
    const text = `${FM}\n# Known Issues\n\n### ~~Issue-072 — done~~\n\n- **Status:** ✅ FIXED (2026-04-10)\n\n  ---\n\n> Resolved issues older than the window are rotated to \`history/issues-resolved.md\` by the issue-archive script.\n`;
    const parsed = parseKnownIssues(text);
    const footer = parsed.sections[parsed.sections.length - 1];
    expect(footer.structural).toBe(true);
    expect(footer.lines.join('\n')).toContain('> Resolved issues');
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      mkdirSync(join(dir, 'docs/ai'), { recursive: true });
      writeFileSync(join(dir, 'docs/ai/known_issues.md'), text, 'utf8');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const kept = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      expect(kept).toContain('  ---');
      expect(kept).toContain('> Resolved issues older than the window');
      expect(kept).not.toContain('Issue-072');
      expect(readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8')).toContain('Issue-072');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The footer anchor is the CANONICAL closing note, never a mere path mention — an issue-owned
  // trailing quote (even one naming the archive) belongs to its section and archives WITH it.
  it('a trailing quote that is not the canonical closing note stays with its issue, and archives with it', async () => {
    const text = `${FM}\n# Known Issues\n\n### ~~Issue-071 — done~~\n\n- **Status:** ✅ FIXED (2026-04-10)\n\n---\n\n> This caveat is about Issue-071 itself, not the file — see history/issues-resolved.md.\n`;
    const parsed = parseKnownIssues(text);
    const last = parsed.sections[parsed.sections.length - 1];
    expect(last.structural).toBe(false);
    expect(last.lines.join('\n')).toContain('about Issue-071 itself');
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      mkdirSync(join(dir, 'docs/ai'), { recursive: true });
      writeFileSync(join(dir, 'docs/ai/known_issues.md'), text, 'utf8');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      expect(readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8')).toContain('about Issue-071 itself');
      expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).not.toContain('about Issue-071 itself');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classifySection', () => {
  it('returns structure for the preamble and any file-structural chunk', () => {
    expect(classifySection({ heading: null, structural: true, lines: [] }, CUTOFF).kind).toBe('structure');
    expect(classifySection({ heading: '## 🟢 Resolved', structural: true, lines: ['## 🟢 Resolved', ''] }, CUTOFF).kind).toBe('structure');
  });

  it('returns open when an issue carries no resolution marker', () => {
    expect(classifySection(sec('### Issue-013: example open issue', '', '**Status:** Accepted'), CUTOFF).kind).toBe('open');
  });

  it('returns archivable when the legacy struck dotted marker is older than cutoff', () => {
    const result = classifySection(sec('### ~~Issue-001: example fixed feature~~', '', '**Status:** ✅ FIXED (2026.04.10)'), CUTOFF);
    expect(result.kind).toBe('archivable');
    expect(result.fixedDate.toISOString().slice(0, 10)).toBe('2026-04-10');
  });

  it('returns fixed-recent when the resolution date is newer than cutoff', () => {
    const section = sec('### ~~Issue-015: example recently-fixed item~~', '', '**Status:** ✅ FIXED (2026.05.23)');
    expect(classifySection(section, CUTOFF).kind).toBe('fixed-recent');
  });

  it('returns fixed-undated when a struck heading carries no marker date', () => {
    const section = sec('### ~~Issue-002: example undated-fixed item~~', '', '**Status:** ✅ FIXED');
    expect(classifySection(section, CUTOFF).kind).toBe('fixed-undated');
  });
});

// Phase 3.2/3.3 (Decision 7): strikethrough stops gating archivability — a recognised, line-leading,
// dated resolution marker decides alone. Fixtures are the exact real-world strings.
describe('the marker contract — real-world resolution shapes', () => {
  it('a struck heading with an ISO dated marker classifies archivable', () => {
    const result = classifySection(
      sec(
        '### ~~Issue-013 — publish lane needed an env relay, and every relay shape eventually gets refused~~',
        '- **Status:** **Resolved** (FIXED 2026-07-21, [[AD-066]]: `--token-file` on `dispatch-publish.mjs`).',
      ),
      LATE_CUTOFF,
    );
    expect(result.kind).toBe('archivable');
    expect(result.fixedDate.toISOString().slice(0, 10)).toBe('2026-07-21');
  });

  it('an UNSTRUCK section with a dated resolution marker classifies archivable', () => {
    const result = classifySection(
      sec(
        '### Issue-011 — seed-gates offer screening: three residuals closed by construction (AD-052)',
        '- **Resolved:** 2026-07-10 — kit **1.43.0** ([[AD-052]]; the U2-DEBT closed-world offer-derivation plan).',
      ),
      LATE_CUTOFF,
    );
    expect(result.kind).toBe('archivable');
    expect(result.fixedDate.toISOString().slice(0, 10)).toBe('2026-07-10');
  });

  it('the list-item prefix is optional — both prefixed and bare markers classify identically', () => {
    const prefixed = classifySection(sec('### Issue-020 — prefixed', '- **Status:** ✅ FIXED (2026-04-10)'), CUTOFF);
    const bare = classifySection(sec('### Issue-021 — bare', '**Status:** ✅ FIXED (2026-04-10)'), CUTOFF);
    expect(prefixed.kind).toBe('archivable');
    expect(bare.kind).toBe('archivable');
    expect(bare.fixedDate.toISOString()).toBe(prefixed.fixedDate.toISOString());
  });

  it('both separator forms of one date classify to the same day', () => {
    const dotted = classifySection(sec('### ~~Issue-022 — dotted~~', '- **Status:** ✅ FIXED (2026.04.10)'), CUTOFF);
    const iso = classifySection(sec('### ~~Issue-023 — iso~~', '- **Status:** ✅ FIXED (2026-04-10)'), CUTOFF);
    expect(dotted.kind).toBe('archivable');
    expect(iso.kind).toBe('archivable');
    expect(iso.fixedDate.toISOString()).toBe(dotted.fixedDate.toISOString());
  });

  it('a resolution marker with trailing prose classifies archivable on its leading date', () => {
    const result = classifySection(
      sec(
        '### Issue-003 — the publish workflow lagged best practice',
        '- **Resolved:** 2026-07-01 ([[AD-031]] release) — the **first live OIDC publish succeeded**, proving the token exchange.',
      ),
      LATE_CUTOFF,
    );
    expect(result.kind).toBe('archivable');
    expect(result.fixedDate.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('a prose H3 with a dated resolution marker is archivable — the marker decides alone', () => {
    const result = classifySection(
      sec(
        '### The 2026-07-02 upgrade-session misreport — four diagnosed defect classes closed (AD-034)',
        '- **Resolved:** 2026-07-02 — engine **1.9.0** / kit **1.26.0** ([[AD-034]]).',
      ),
      LATE_CUTOFF,
    );
    expect(result.kind).toBe('archivable');
  });

  it('an open issue mentioning a date in prose does not classify archivable', () => {
    const result = classifySection(
      sec(
        '### Issue-006 — preflight resolves under the ambient env',
        '- **Discovered:** 2026-06-29 (Codex-bridge overhaul).',
        'Upstream shipped their fix on 2026-07-01; ours still reproduces.',
        '- **Status:** Open — **deferred** (cosmetic edge case; recorded, not fixed).',
      ),
      LATE_CUTOFF,
    );
    expect(result.kind).toBe('open');
  });

  // The pre-4.0.0 template seeded this EXACT example section; a pristine legacy deployment must
  // not red its gate forever over our own blank. Only the exact heading+placeholder pair is inert.
  it('the pristine pre-4.0.0 template seed classifies template-blank and keeps the gate green', async () => {
    expect(
      classifySection(
        sec('### Issue-XXX — {{Title}}', '- **Resolved:** {{DATE}}', '- **Resolution:** {{what fixed it}}', '- **Commit:** {{SHA}}'),
        LATE_CUTOFF,
      ).kind,
    ).toBe('template-blank');
    const LEGACY = `---\ntype: reference\nlastUpdated: {{DATE}}\nscope: permanent\nstaleAfter: 30d\nowner: none\nmaxLines: 300\n---\n\n# Known Issues\n\n> Every bug we hit. Status, workaround, impact, plan. Avoids re-discovering pain.\n\n## 🔴 Open\n\n### Issue-001 — {{Title}}\n- **Discovered:** {{DATE}}\n- **Status:** Open\n- **Impact:** {{user-facing? dev-only? blocking?}}\n- **Workaround:** {{if any}}\n- **Plan:** {{next action}}\n- **Related files:** \`{{src/...}}\`\n\n## 🟢 Resolved\n\n### Issue-XXX — {{Title}}\n- **Resolved:** {{DATE}}\n- **Resolution:** {{what fixed it}}\n- **Commit:** {{SHA}}\n\n---\n\n> Resolved issues older than the window are rotated to \`history/issues-resolved.md\` by the issue-archive script.\n`;
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      mkdirSync(join(dir, 'docs/ai'), { recursive: true });
      writeFileSync(join(dir, 'docs/ai/known_issues.md'), LEGACY, 'utf8');
      const logs = [];
      expect(runCli(['--check', '--today=2026-07-28'], { root: dir, log: (m) => logs.push(m), logError: (m) => logs.push(m) })).toBe(0);
      expect(logs.join('\n')).toContain('template-blank 1');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
      expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(LEGACY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unfilled date placeholder in a REAL section stays loud, never a template blank', () => {
    expect(classifySection(sec('### ~~Issue-055 — real struck~~', '- **Resolved:** {{DATE}} — what fixed it'), LATE_CUTOFF).kind).toBe('fixed-undated');
    expect(classifySection(sec('### Issue-055 — real unstruck', '- **Resolved:** {{DATE}}'), LATE_CUTOFF).kind).toBe('fixed-undated');
  });

  // The blank's identity is the exact literal heading — no real issue carries `{{Title}}` — so a
  // half-substituted blank (an agent dated the placeholders) still never enters the archive.
  it('the legacy blank stays inert after an agent substitutes the date placeholders', async () => {
    expect(
      classifySection(sec('### Issue-XXX — {{Title}}', '- **Resolved:** 2026-05-12', '- **Resolution:** {{what fixed it}}'), LATE_CUTOFF).kind,
    ).toBe('template-blank');
    const LEGACY = `---\ntype: reference\nlastUpdated: {{DATE}}\nscope: permanent\nstaleAfter: 30d\nowner: none\nmaxLines: 300\n---\n\n# Known Issues\n\n> Every bug we hit.\n\n## 🔴 Open\n\n### Issue-001 — {{Title}}\n- **Discovered:** {{DATE}}\n- **Status:** Open\n\n## 🟢 Resolved\n\n### Issue-XXX — {{Title}}\n- **Resolved:** {{DATE}}\n- **Resolution:** {{what fixed it}}\n- **Commit:** {{SHA}}\n\n---\n\n> Resolved issues older than the window are rotated to \`history/issues-resolved.md\` by the issue-archive script.\n`;
    const substituted = LEGACY.replaceAll('{{DATE}}', '2026-05-12');
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      mkdirSync(join(dir, 'docs/ai'), { recursive: true });
      writeFileSync(join(dir, 'docs/ai/known_issues.md'), substituted, 'utf8');
      const logs = [];
      expect(runCli(['--check', '--today=2026-07-28'], { root: dir, log: (m) => logs.push(m), logError: (m) => logs.push(m) })).toBe(0);
      expect(logs.join('\n')).toContain('template-blank 1');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Contradictory state refuses: Resolved-priority would silently archive a genuinely reopened
  // issue, Status-priority would silently skip a resolved one forever — loud is the only
  // direction that hides nothing.
  it('contradictory open status and dated resolution marker classify conflict, in either order', () => {
    expect(
      classifySection(sec('### Issue-080 — forgot to flip', '- **Status:** Open', '- **Resolved:** 2026-04-10 — fixed.'), LATE_CUTOFF)
        .kind,
    ).toBe('conflict');
    expect(
      classifySection(sec('### Issue-081 — stale resolved', '- **Resolved:** 2026-04-10 — old note.', '- **Status:** Open — reopened'), LATE_CUTOFF)
        .kind,
    ).toBe('conflict');
  });

  it('emphasis and emoji variants of the resolution signal classify archivable', () => {
    for (const value of ['**FIXED** (2026-04-10)', '✅ **FIXED** (2026-04-10)', '✅ **Resolved** (2026-04-10)']) {
      const result = classifySection(sec('### ~~Issue-070 — emphasised~~', `- **Status:** ${value}`), CUTOFF);
      expect(result.kind).toBe('archivable');
    }
  });

  it('a struck heading with an explicit open status classifies open — strikethrough is cosmetic in both directions', () => {
    expect(classifySection(sec('### ~~Issue-060 — reopened~~', '- **Status:** Open — reopened 2026-07-25'), LATE_CUTOFF).kind).toBe('open');
    expect(classifySection(sec('### ~~Issue-061 — mitigated~~', '- **Status:** Mitigated forward in kit `1.8.0`'), LATE_CUTOFF).kind).toBe('open');
    // A bare struck heading with NO status/resolved field stays a loud undated resolution claim.
    expect(classifySection(sec('### ~~Issue-062 — bare struck~~', 'prose only.'), LATE_CUTOFF).kind).toBe('fixed-undated');
  });

  // A struck heading is itself a resolution signal: an UNRECOGNISED status value under it is a
  // resolution claim with no recognisable date (Arm C loud) — while UNSTRUCK sections keep a free
  // status vocabulary, so an allowlist can never false-red a legitimately open issue.
  it('a struck heading with an unrecognised status is a loud undated claim, not silently open', () => {
    expect(classifySection(sec('### ~~Issue-085 — closed word~~', '- **Status:** Closed — long ago'), LATE_CUTOFF).kind).toBe('fixed-undated');
    expect(classifySection(sec('### ~~Issue-086 — done word~~', '- **Status:** DONE'), LATE_CUTOFF).kind).toBe('fixed-undated');
  });

  it('unstruck status vocabulary stays free — Deferred, Wontfix, Investigating classify open', () => {
    for (const value of ['Deferred until the next release', 'Wontfix — by design', 'Investigating']) {
      expect(classifySection(sec('### Issue-087 — free vocabulary', `- **Status:** ${value}`), LATE_CUTOFF).kind).toBe('open');
    }
  });

  it('a resolved field with no recognisable date classifies fixed-undated, never open', () => {
    expect(classifySection(sec('### Issue-051 — undated resolved field', '- **Resolved:** kit **1.43.0** shipped it'), CUTOFF).kind).toBe('fixed-undated');
    expect(classifySection(sec('### Issue-052 — undated status', '- **Status:** ✅ FIXED'), CUTOFF).kind).toBe('fixed-undated');
  });

  it('an impossible or mixed-separator marker date classifies bad-date, never normalises', () => {
    expect(classifySection(sec('### ~~Issue-053 — impossible~~', '- **Status:** ✅ FIXED (2026.02.30)'), CUTOFF).kind).toBe('bad-date');
    expect(classifySection(sec('### Issue-054 — mixed separators', '- **Resolved:** 2026-07.20 — x'), CUTOFF).kind).toBe('bad-date');
    expect(classifySection(sec('### Issue-055 — single digit', '- **Resolved:** 2026-7-2 — x'), CUTOFF).kind).toBe('bad-date');
  });

  it('a struck section whose only marker sits inside a fence is fixed-undated, never archivable', () => {
    const text = `${FM}\n# Known Issues\n\n### ~~Issue-030 — teaches the marker form~~\n\n\`\`\`markdown\n- **Status:** ✅ FIXED (2026.04.10)\n\`\`\`\n`;
    const { sections } = parseKnownIssues(text);
    const section = sections.find((s) => s.structural === false);
    expect(Boolean(section)).toBe(true);
    expect(classifySection(section, CUTOFF).kind).toBe('fixed-undated');
  });

  // In the PACKAGE this file sits beside references/templates/ and the seed is asserted; the
  // DEPLOYED copy runs in a consumer's scripts/ where no ../templates exists — a stated skip, not
  // an ENOENT crash (the canon-side kit template-parity suite still pins the seed every run).
  it('the shape seeded by references/templates/known_issues.md classifies archivable', { skip: !existsSync(resolve(TEMPLATES_DIR, 'known_issues.md')) && 'deployed copy: the template ships in the package, not at the consumer' }, () => {
    const template = readFileSync(resolve(TEMPLATES_DIR, 'known_issues.md'), 'utf8');
    const fence = /```markdown\n([\s\S]*?)\n```/.exec(template);
    expect(Boolean(fence)).toBe(true);
    const { sections } = parseKnownIssues(`${FM}\n# Known Issues\n\n${fence[1]}\n`);
    const section = sections.find((s) => s.structural === false);
    expect(Boolean(section)).toBe(true);
    expect(classifySection(section, LATE_CUTOFF).kind).toBe('archivable');
  });

  // The teaching block lives in the file PREAMBLE (structural, no user insertion point) — a real
  // section inserted directly under the bare `## 🟢 Resolved` heading archives ALONE, never
  // carrying the instructions, categories or footer with it.
  it('the full template rotates cleanly with a real issue inserted directly under the Resolved category', { skip: !existsSync(resolve(TEMPLATES_DIR, 'known_issues.md')) && 'deployed copy: the template ships in the package, not at the consumer' }, async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const template = readFileSync(resolve(TEMPLATES_DIR, 'known_issues.md'), 'utf8').replaceAll('{{DATE}}', '2026-01-10');
    const inserted = template.replace(
      '## 🟢 Resolved\n',
      '## 🟢 Resolved\n\n### ~~Issue-090 — real resolved~~\n- **Resolved:** 2026-01-15 — done.\n',
    );
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      mkdirSync(join(dir, 'docs/ai'), { recursive: true });
      writeFileSync(join(dir, 'docs/ai/known_issues.md'), inserted, 'utf8');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const kept = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      expect(kept).toContain('```markdown');
      expect(kept).toContain('## 🔴 Open');
      expect(kept).toContain('## 🟢 Resolved');
      expect(kept).toContain('> Resolved issues older than the window');
      expect(kept).toContain('Issue-001');
      expect(kept).not.toContain('Issue-090');
      expect(readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8')).toContain('Issue-090');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Lockstep pin: the closing note the template seeds is byte-for-byte the anchor the parser's
  // footer rule recognises — a reworded template would silently un-anchor every fresh project.
  it('the template closing note is the canonical footer anchor the parser recognises', { skip: !existsSync(resolve(TEMPLATES_DIR, 'known_issues.md')) && 'deployed copy: the template ships in the package, not at the consumer' }, async () => {
    const { CANONICAL_FOOTER_NOTE } = await import('./archive-issues.mjs');
    expect(typeof CANONICAL_FOOTER_NOTE).toBe('string');
    const template = readFileSync(resolve(TEMPLATES_DIR, 'known_issues.md'), 'utf8');
    expect(template).toContain(`> ${CANONICAL_FOOTER_NOTE}`);
  });
});

// Phase 2 (the tokenizer contract): section boundaries are heading TOKENS — column-0 headings
// outside fences — and an ISSUE-shaped heading anywhere else is loud, never silently glued or
// silently split.
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

// Arm C at the CLI seam: the predicate (a resolution claim without a recognisable date, or a
// malformed date) AND the disposition (exit 1, file:line, nothing written) — in every mode.
describe('a resolved section with no recognisable date is reported LOUDLY, never silently skipped', () => {
  const seedTree = (dir, text) => {
    mkdirSync(join(dir, 'docs/ai'), { recursive: true });
    writeFileSync(join(dir, 'docs/ai/known_issues.md'), text, 'utf8');
  };
  const undated = `${FM}\n# Known Issues\n\n### ~~Issue-007 — struck, no recognisable date~~\n\n- **Status:** ✅ FIXED\n\n### Issue-008 — open\n\n- **Status:** Open\n`;

  for (const mode of [['--check'], ['--dry-run'], []]) {
    it(`${JSON.stringify(mode)} refuses the undated resolution claim with exit 1 and writes nothing`, async () => {
      const { runCli } = await import('./archive-issues.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
      try {
        seedTree(dir, undated);
        const before = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
        const errs = [];
        const code = runCli(mode, { root: dir, log: () => {}, logError: (m) => errs.push(m) });
        expect(code).toBe(1);
        expect(errs.join('\n')).toMatch(/known_issues\.md:\d+/);
        expect(errs.join('\n')).toContain('✅ FIXED');
        expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(before);
        expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('a struck unrecognised status refuses without writing', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, `${FM}\n# Known Issues\n\n### ~~Issue-085 — closed word~~\n\n- **Status:** Closed — long ago\n`);
      const before = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      const errs = [];
      expect(runCli(['--check'], { root: dir, log: () => {}, logError: (m) => errs.push(m) })).toBe(1);
      expect(errs.join('\n')).toMatch(/known_issues\.md:\d+/);
      expect(errs.join('\n')).toContain('Closed');
      expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(before);
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a status/resolution conflict refuses naming both lines and writes nothing', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, `${FM}\n# Known Issues\n\n### Issue-080 — forgot to flip\n\n- **Status:** Open\n- **Resolved:** 2026-04-10 — fixed.\n`);
      const before = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      const errs = [];
      const code = runCli(['--check'], { root: dir, log: () => {}, logError: (m) => errs.push(m) });
      expect(code).toBe(1);
      const out = errs.join('\n');
      expect(out).toMatch(/known_issues\.md:\d+/);
      expect(out).toContain('**Resolved:** 2026-04-10');
      expect(out).toContain('**Status:** Open');
      expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(before);
      expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an impossible or mixed-separator marker date is refused, not normalised', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    for (const [marker, token] of [
      ['- **Status:** ✅ FIXED (2026.02.30)', '2026.02.30'],
      ['- **Resolved:** 2026-07.20 — x', '2026-07.20'],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
      try {
        seedTree(dir, `${FM}\n# Known Issues\n\n### ~~Issue-009 — bad date~~\n\n${marker}\n`);
        const before = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
        const errs = [];
        const code = runCli(['--check'], { root: dir, log: () => {}, logError: (m) => errs.push(m) });
        expect(code).toBe(1);
        expect(errs.join('\n')).toMatch(/known_issues\.md:\d+/);
        expect(errs.join('\n')).toContain(token);
        expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(before);
        expect(existsSync(join(dir, 'docs/ai/history'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

// Phase 3.1 at the write path: structural lines survive, and a rewrite is verbatim — nothing
// silently dropped OR duplicated (the L8 data-loss class, pinned as conservation).
describe('rotation keeps the file structure and conserves every line', () => {
  const seedTree = (dir, text) => {
    mkdirSync(join(dir, 'docs/ai'), { recursive: true });
    writeFileSync(join(dir, 'docs/ai/known_issues.md'), text, 'utf8');
  };
  // today=2026-07-28 → cutoff 2026-07-15: Issue-102 and Issue-103 archivable, Issue-101 open.
  const ROTATION_CUTOFF = new Date('2026-07-15T00:00:00Z');
  const STRUCTURED = `${FM}\n# Known Issues\n\n> Every bug we hit.\n\n## 🔴 Open\n\n### Issue-101 — still open\n- **Discovered:** 2026-04-01\n- **Status:** Open\n\n### ~~Issue-102 — struck resolved~~\n- **Status:** ✅ FIXED (2026.04.10)\n\n## 🟢 Resolved\n\n### Issue-103 — unstruck resolved\n- **Resolved:** 2026-07-01 — fixed for good ([[AD-031]]).\n\n---\n\n> Resolved issues older than the window are rotated to \`history/issues-resolved.md\` by the issue-archive script.\n`;

  it('the trailing separator and closing note survive a rotation that archives the last issue', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, STRUCTURED);
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const kept = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      expect(kept).toContain('## 🔴 Open');
      expect(kept).toContain('## 🟢 Resolved');
      expect(kept).toContain('---');
      expect(kept).toContain('> Resolved issues older than the window');
      expect(kept).toContain('Issue-101');
      expect(kept).not.toContain('Issue-102');
      expect(kept).not.toContain('Issue-103');
      const archive = readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8');
      expect(archive).toContain('Issue-102');
      expect(archive).toContain('Issue-103');
      expect(archive).not.toContain('## 🟢 Resolved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotation conserves content — every input line lands in exactly one of kept file and archive', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      const parsed = parseKnownIssues(STRUCTURED);
      const archivedChunks = parsed.sections.filter((s) => classifySection(s, ROTATION_CUTOFF).kind === 'archivable');
      expect(archivedChunks).toHaveLength(2);
      const keptExpected =
        parsed.frontmatter +
        parsed.sections
          .filter((s) => classifySection(s, ROTATION_CUTOFF).kind !== 'archivable')
          .flatMap((s) => s.lines)
          .join('\n');
      seedTree(dir, STRUCTURED);
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const kept = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      expect(kept).toBe(keptExpected);
      const archive = readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8');
      for (const chunk of archivedChunks) expect(archive).toContain(chunk.lines.join('\n'));
      // The accounting reads the ACTUAL written files, never the parsed chunks — a writer that
      // duplicated blocks or invented lines must fail here. Blank lines are the stated droppable
      // decoration (the changelog conservation harness accounting); everything else is a multiset.
      const header = buildResolvedFile('', [], '2026-07-28');
      expect(archive.startsWith(header)).toBe(true);
      const counts = (text) => {
        const map = {};
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          map[line] = (map[line] ?? 0) + 1;
        }
        return map;
      };
      const merged = counts(kept.slice(parsed.frontmatter.length));
      for (const [line, n] of Object.entries(counts(archive.slice(header.length)))) {
        merged[line] = (merged[line] ?? 0) + n;
      }
      expect(merged).toEqual(counts(STRUCTURED.slice(parsed.frontmatter.length)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a CRLF corpus rotates with exact CRLF separators in the archive', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const lf = `${FM}\n# Known Issues\n\n### ~~Issue-201 — first done~~\n- **Status:** ✅ FIXED (2026.04.10)\n\n### ~~Issue-202 — second done~~\n- **Status:** ✅ FIXED (2026.04.11)\n`;
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, lf.replace(/\n/g, '\r\n'));
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const archive = readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8');
      // The between-block separator is EXACTLY one CRLF blank line — no lone-CR lines, no
      // mixed-EOL runs between the archived CRLF blocks.
      expect(archive).toContain('- **Status:** ✅ FIXED (2026.04.10)\r\n\r\n### ~~Issue-202 — second done~~');
      expect(/\n\r(?!\n)/.test(archive)).toBe(false);
      expect(/\n{3,}/.test(archive.replace(/\r\n/g, '\n'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second rotation is a no-op — the rotated tree is a fixed point', async () => {
    const { runCli } = await import('./archive-issues.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'archive-issues-'));
    try {
      seedTree(dir, STRUCTURED);
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      const keptOnce = readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8');
      const archiveOnce = readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8');
      expect(runCli(['--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
      expect(readFileSync(join(dir, 'docs/ai/known_issues.md'), 'utf8')).toBe(keptOnce);
      expect(readFileSync(join(dir, 'docs/ai/history/issues-resolved.md'), 'utf8')).toBe(archiveOnce);
      expect(runCli(['--check', '--today=2026-07-28'], { root: dir, log: () => {}, logError: () => {} })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The partition tripwire's own refusal contract — predicate AND disposition. Imported dynamically
// so this file still loads against an archiver that predates the export.
describe('the section-model partition tripwire', () => {
  it('a partition that drops, duplicates or reorders lines refuses with a typed error naming the file', async () => {
    const { verifySectionPartition } = await import('./archive-issues.mjs');
    verifySectionPartition([{ heading: null, structural: true, lines: ['a', 'b'] }], ['a', 'b'], 'ki.md'); // exact partition passes silently
    const corruptions = [
      [[{ lines: ['a', 'a'] }], ['a', 'b']], // equal-cardinality: one line lost, another duplicated
      [[{ lines: ['a'] }], ['a', 'b']], // dropped line
      [[{ lines: ['b', 'a'] }], ['a', 'b']], // reordered
    ];
    for (const [sections, body] of corruptions) {
      let threw = null;
      try {
        verifySectionPartition(sections, body, 'ki.md');
      } catch (err) {
        threw = err;
      }
      expect(threw).not.toBeNull();
      expect(threw.exitCode).toBe(1);
      expect(threw.message).toContain('ki.md');
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

  // Appending to an EXISTING CRLF archive: the separator follows the header's own EOL flavor and
  // the trailing run collapses to one terminator — never a mixed `\r\n\n` run.
  it('appending to an existing CRLF archive never mixes EOL runs', () => {
    const existing = '---\r\ntype: history\r\n---\r\n\r\n# Resolved Issues\r\n\r\n### ~~Issue-000~~\r\n- **Status:** ✅ FIXED (2026.01.01)\r\n';
    const result = buildResolvedFile(
      existing,
      [{ heading: '### ~~Issue-099~~', lines: ['### ~~Issue-099~~\r', '- **Resolved:** 2026-01-02 — done.\r', '\r'] }],
      '2026-07-28',
    );
    expect(result).toContain('(2026.01.01)\r\n\r\n### ~~Issue-099~~');
    expect(/\r\n\n|\n\n\n/.test(result)).toBe(false);
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

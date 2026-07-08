#!/usr/bin/env node
// sarif.mjs — a dependency-free SARIF (2.1.0) reader for the OPTIONAL advisory findings surface
// (BUGFREE-3, AD-049, step 1.4 — the reviewdog pattern). Findings are ADVISORY ONLY: they are NEVER
// recorded on a fold run record (SARIF stays entirely out of the fold result schema — no v4 quartet
// coupling, no sequencing dependency) and NEVER gate-blocking (fold-completeness --check never reads
// SARIF). A malformed SARIF fails the advisory READ loudly (a nonzero exit on the advisory verb), but
// the fold gate — fold-completeness --check — is unaffected. No side effects on import; Node >= 18.

export const SARIF_STOP = 'SARIF_STOP';
const stop = (message) => Object.assign(new Error(`[agent-workflow-kit] ${message}`), { name: 'SarifStop', code: SARIF_STOP });

// parseSarif(text) → { findings: [{ ruleId, level, message, file, line }] }. THROWS on a malformed
// SARIF (not JSON, or no runs[] array) — the advisory read is LOUD, never a silent empty result. A
// well-formed run with zero results yields an empty findings list (a clean advisory).
export const parseSarif = (text) => {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw stop(`SARIF is not valid JSON (${err.message})`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.runs)) {
    throw stop('SARIF has no runs[] array — not a SARIF 2.1.0 document');
  }
  const findings = [];
  for (const run of doc.runs) {
    const results = Array.isArray(run?.results) ? run.results : [];
    for (const r of results) {
      const loc = r?.locations?.[0]?.physicalLocation ?? {};
      findings.push({
        ruleId: typeof r?.ruleId === 'string' ? r.ruleId : '(no rule)',
        level: typeof r?.level === 'string' ? r.level : 'warning',
        message: typeof r?.message?.text === 'string' ? r.message.text : '',
        file: typeof loc?.artifactLocation?.uri === 'string' ? loc.artifactLocation.uri : null,
        line: Number.isInteger(loc?.region?.startLine) ? loc.region.startLine : null,
      });
    }
  }
  return { findings };
};

// renderSarifFindings(findings) → a human advisory block (one line per finding). Empty → a stated
// "no findings" note. Always advisory — the caller never blocks a gate on this.
export const renderSarifFindings = (findings) => {
  if (findings.length === 0) return 'SARIF advisory: no findings (advisory only — never gate-blocking).';
  const lines = [`SARIF advisory: ${findings.length} finding(s) (advisory only — never gate-blocking):`];
  for (const f of findings) {
    const at = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ''}` : '(no location)';
    lines.push(`  [${f.level}] ${f.ruleId} — ${at}${f.message ? ` — ${f.message}` : ''}`);
  }
  return lines.join('\n');
};

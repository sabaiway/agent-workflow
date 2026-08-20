// flow-finding-manifest.mjs — the wrapper finding manifest (Phase 4.2, Decision 2 / P5 / P24): the
// SAFE nonce grammar, the manifest filename prefix and the basename derived from the dispatch
// identity, the closed manifest shape, and the ONE fatal-UTF-8 decoder both kit consumers share.
// Split out of flow-record.mjs unchanged (baseline-practices tranche 3), which now re-exports every
// name here.
//
// Pure form: no filesystem, no git, no CLI, no side effects on import — it validates and DERIVES a
// name, it never opens the file the name denotes. Imports run ONE way: the vocabulary leaf owns the
// schema version and the shared form bindings, and nothing here reaches back up to the facade.

import { FLOW_SCHEMA_VERSION, isHex64, isNonEmptyString, isPlainObject, refuse } from './flow-vocabulary.mjs';

// ── the wrapper finding manifest (Phase 4.2, Decision 2 / P5 / P24) — pure form ──────────────────

// The SAFE nonce grammar (containment-checked): the nonce enters a DERIVED FILENAME in the git
// dir, so only this closed byte set is accepted — anything else refuses before a name composes.
export const SAFE_NONCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const FINDING_MANIFEST_PREFIX = 'agent-workflow-finding-manifest-';

// The manifest filename derives from the DISPATCH IDENTITY {backend, nonce} — two backends can
// never collide on one nonce (P24). Both halves are containment-checked; null on any violation.
export const findingManifestBasename = (backend, nonce) => {
  if (typeof backend !== 'string' || !SAFE_NONCE_RE.test(backend)) return null;
  if (typeof nonce !== 'string' || !SAFE_NONCE_RE.test(nonce)) return null;
  return `${FINDING_MANIFEST_PREFIX}${backend}-${nonce}.json`;
};

// The closed manifest shape {schema, backend, nonce, fingerprint, findings} (P24) — findings is
// the wrapper-captured findings payload VERBATIM (form-provable; semantics stay an honest limit).
const FINDING_MANIFEST_KEYS = ['schema', 'backend', 'nonce', 'fingerprint', 'findings'];

export const validateFindingManifest = (manifest) => {
  if (!isPlainObject(manifest)) return refuse('finding manifest: not an object');
  const stray = Object.keys(manifest).find((k) => !FINDING_MANIFEST_KEYS.includes(k));
  if (stray !== undefined) return refuse(`finding manifest: unknown field "${stray}" — the key set is closed (fail closed)`);
  const missing = FINDING_MANIFEST_KEYS.find((k) => !(k in manifest));
  if (missing !== undefined) return refuse(`finding manifest: missing field "${missing}"`);
  if (manifest.schema !== FLOW_SCHEMA_VERSION) {
    return refuse(`finding manifest: unknown schema ${JSON.stringify(manifest.schema)} — this reader accepts schema ${FLOW_SCHEMA_VERSION} only (fail closed)`);
  }
  if (typeof manifest.backend !== 'string' || !SAFE_NONCE_RE.test(manifest.backend)) return refuse('finding manifest: backend must satisfy the safe name grammar ([A-Za-z0-9._-]{1,64})');
  if (typeof manifest.nonce !== 'string' || !SAFE_NONCE_RE.test(manifest.nonce)) return refuse('finding manifest: nonce must satisfy the safe nonce grammar ([A-Za-z0-9._-]{1,64})');
  if (manifest.fingerprint !== null && !isHex64(manifest.fingerprint)) return refuse('finding manifest: fingerprint must be a 64-hex tree fingerprint, or null when the wrapper could not compute one');
  if (!isNonEmptyString(manifest.findings)) return refuse('finding manifest: findings must be the non-empty captured findings payload (one string)');
  if (!manifest.findings.isWellFormed()) return refuse('finding manifest: findings must be a well-formed Unicode string — utf8-hashing a lone surrogate would substitute U+FFFD and corrupt the findingDigest domain (fail closed)');
  return { ok: true };
};

// The ONE manifest reader both kit consumers share (flow-writer's consult arm, the
// receipt-deadline runner): FATAL UTF-8 decode — a lossy toString would substitute U+FFFD and
// silently mutate the digest domain — with ignoreBOM, so a BOM-prefixed file keeps refusing at
// JSON.parse exactly as the pre-helper path did (no behavior widening).
export const decodeFindingManifest = (bytes) => {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse('finding manifest: not valid UTF-8 — a lossy decode would silently mutate the findings digest domain (fail closed)');
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return refuse('finding manifest: not valid JSON (fail closed)');
  }
  const valid = validateFindingManifest(manifest);
  if (!valid.ok) return valid;
  return { ok: true, manifest };
};

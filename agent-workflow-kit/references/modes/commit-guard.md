### Mode: commit-guard

The **read-only pre-commit guard** (strip-the-kit D10) — the last line of the loop: a commit is permitted only against the LATEST completed `run-gates --final` receipt that binds EXACTLY the current tree. It re-runs NO gate or test subprocess — the heavy D3 verification lives in the final run; the guard recomputes the tree fingerprint (read-only git plumbing) and compares file contents.

Run `node ${CLAUDE_SKILL_DIR}/tools/commit-guard.mjs --check [--cwd <dir>]` — it refuses, each with a named recovery, on:

1. no completed final record for the CURRENT fingerprint (the tree moved after the final run — any edit re-stales it);
2. a RED latest attempt (a dead green never revives — the latest attempt at a fingerprint is authoritative);
3. fingerprint before ≠ after on the receipt (the tree moved UNDER the final run);
4. a LATER `final-start` whose attempt never completed (interrupted run / failed receipt append — an attempt of unknown outcome never lets an earlier green stand);
5. declaration content drift (the current `docs/ai/gates.json` {id, cmd} array no longer matches the receipt's recorded one);
6. evidence-hash drift (the store's canonical red-proof/degrade serializations moved under the receipt) or lcov drift (the consumed file's sha moved or vanished);
7. unsatisfied review obligations — the SAME normative decision `review-state --check` computes (configured recipe backends, ship-class-only on the latest normal receipt, veto, the explicit degrade escape), recomputed over a SANITIZED env: the guard resolves FIXED git-dir paths for its own reads and ignores `AW_REVIEW_RECEIPTS`/`AW_CORE_EVIDENCE` (producer test seams are never guard inputs — a forged out-of-repo store never satisfies).

**Wiring:** this repo's dogfood rides `scripts/install-git-hooks.mjs`; a consumer install is a consented surface (init/recommendations) — the hook INSTALLER resolves the installed kit location at install time and writes the RESOLVED invocation into the hook it places (no runtime guessing). The final-run ordering that keeps the guard green is D13: stage everything FIRST → run the reviews on the staged tree → `run-gates --final` → commit immediately (any index/worktree mutation after the final run re-stales the receipt).

**Human residual (stated, accepted):** `git commit --no-verify` bypasses any pre-commit hook — a self-discipline mechanism, not a security boundary.

**Invariants:** read-only · re-runs nothing · fixed git-dir reads (env overrides ignored) · exit 0 pass / 1 refused (reason + recovery named) / 2 usage.

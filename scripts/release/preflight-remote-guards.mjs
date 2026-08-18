// preflight-remote-guards.mjs — everything the preflight verifies BEFORE it touches the network.
//
// Split out of the driver when five review rounds grew it past the 400-line cap; the guards were the
// block that had grown most, and they are one concern: is the ref the operator named the ref this run
// may verify, and would their push reach the place this run is about to fetch from? Every refusal here
// happens before the single network act.
//
// Dependency-free, Node >= 22. No side effects on import.

import { EXIT, REMOTE, fail, firstLine } from './preflight-remote-core.mjs';

// Rendered into copy-paste commands, so no shell-significant byte may reach one. This is the exact
// character class the family's canonical quoter (agent-workflow-kit/tools/repo-lex.mjs) treats as
// needing no quoting at all — refusing at that same boundary keeps ONE definition of shell-safe
// instead of adding a fourth escaper to the family.
const SHELL_SAFE_REF = /^[A-Za-z0-9._/-]+$/;

// Only exit 1 is git's "this ref does not exist". Any other outcome means the PROBE failed, and a
// failed guard must never let the network step proceed.
const refExists = async (fullRef, runGit, what) => {
  const res = await runGit(['rev-parse', '--verify', '--quiet', fullRef]);
  if (res.status === 0) return true;
  if (res.status === 1 && !res.error && res.signal === null) return false;
  throw fail(
    EXIT.refusal,
    `the ${what} probe for "${fullRef}" did not answer (status ${res.status}, signal ${res.signal}, ${res.error?.code ?? 'no error'}) — refusing fail-closed rather than reading a broken probe as "absent"`,
  );
};

// "Is this a branch and not a tag" cannot be settled by a regex, so git decides. Two measured facts
// make this MORE than one call: `check-ref-format --branch refs/heads/main` exits 0, so a full ref
// PASSES git's own validator; and `check-ref-format --branch @{-1}` exits 0 while REWRITING the value
// to a different branch off the reflog. So the value is also refused when it names a full ref, and
// when git hands back something other than what was passed in.
export const assertShortBranchName = async (ref, runGit) => {
  if (ref === '') throw fail(EXIT.usage, '--ref must not be empty');
  if (ref.startsWith('refs/')) {
    throw fail(EXIT.usage, `--ref must be a SHORT branch name, not a full ref (got "${ref}")`);
  }
  const res = await runGit(['check-ref-format', '--branch', ref]);
  // A structural NON-ANSWER is not a verdict on the name: a spawn failure or a signal means git never
  // judged anything, so calling it a usage error would blame the operator's ref for a broken probe.
  // Only a real non-zero EXIT is git saying "invalid".
  if (res.status === null) {
    throw fail(
      EXIT.refusal,
      `git check-ref-format did not answer for "${ref}" (signal ${res.signal}, ${res.error?.code ?? 'no error'}) — refusing fail-closed; the name was never judged`,
    );
  }
  if (res.status !== 0) {
    throw fail(EXIT.usage, `--ref "${ref}" is not a valid branch name: ${firstLine(res.stderr) || `git exited ${res.status}`}`);
  }
  const resolved = res.stdout.trim();
  if (resolved !== ref) {
    throw fail(
      EXIT.usage,
      `--ref "${ref}" is a shorthand git resolves to "${resolved}" — name the branch itself, so the ref this run verifies is the ref you asked for`,
    );
  }
  // Measured: `release;uname`, `quo'te`, `amp&and` and `dollar$sub` are ALL legal branch names, and
  // `git branch "release;uname"` really creates one. Interpolated into a printed remedy, the first of
  // those splits the force-push line and leaves `git push --force-with-lease=refs/heads/release` as
  // its own command — a lease with NO VALUE, which is exactly the form this script exists to never
  // print. Refusing is the subtractive fix: with no such byte able to reach the string, the escaping
  // surface does not exist. The dispatcher accepts more, and being stricter here is safe — this
  // refuses rather than mis-verifies.
  if (!SHELL_SAFE_REF.test(ref)) {
    throw fail(
      EXIT.usage,
      `--ref "${ref}" carries a shell-significant byte — refused because this run renders the branch name into copy-paste remedy commands, where such a byte would split one command into several. Allowed: letters, digits, and . _ / -`,
    );
  }
  // A TAG must exit 2, and check-ref-format cannot deliver that: a short tag name like "v5.10.0" is a
  // perfectly valid BRANCH name, so git's validator accepts it. Addressing refs/heads/<ref> at fetch
  // time already makes it impossible to verify a tag by accident — that is the safety property — but
  // the operator would then read a fetch failure ("refusing fail-closed") for what is really a usage
  // mistake. One local lookup buys the right category. When BOTH a tag and a branch carry the name,
  // the explicit refspec settles it and the run proceeds.
  if (await refExists(`refs/tags/${ref}`, runGit, 'tag') && !await refExists(`refs/heads/${ref}`, runGit, 'branch')) {
    throw fail(EXIT.usage, `--ref "${ref}" names a TAG here, not a branch — this check verifies the branch the release will push to`);
  }
};

// @{push} survives ONLY as a guard on the operator's own push — never as a source of the destination.
// Probed: with branch.<name>.pushRemote set and the default push.default=simple, `git rev-parse
// @{push}` FAILS ("cannot resolve 'simple' push to a single destination") while @{u} resolves, so
// "just use @{push}" would trade a hole for a crash. Here an unresolvable @{push} refuses, which is
// the safe direction.
//
// The URLs are read through `git remote get-url`, never from raw config. Measured: with
// `url.<base>.pushInsteadOf` set, raw `remote.<name>.url` reads the original and raw `pushurl` is
// ABSENT, so a raw comparison sees "nothing configured" and passes — while
// `git remote get-url --push --all` reports the rewritten host the push would really reach.
export const assertPushTargetsDestination = async (ref, runGit) => {
  const destination = `${REMOTE}/${ref}`;
  const pushRef = await runGit(['rev-parse', '--abbrev-ref', '@{push}']);
  if (pushRef.status !== 0) {
    throw fail(
      EXIT.refusal,
      `@{push} does not resolve (${firstLine(pushRef.stderr) || `git exited ${pushRef.status}`}) — this run cannot show that your push would reach ${destination}, so it refuses rather than verify a ref you may not be pushing to`,
    );
  }
  const resolved = pushRef.stdout.trim();
  if (resolved !== destination) {
    throw fail(
      EXIT.refusal,
      `@{push} resolves to "${resolved}" but this run verifies "${destination}" — refusing: a PASS would say nothing about the ref your push actually updates`,
    );
  }
  const fetchUrl = await runGit(['remote', 'get-url', REMOTE]);
  if (fetchUrl.status !== 0 || fetchUrl.stdout.trim() === '') {
    throw fail(EXIT.refusal, `the fetch URL of remote "${REMOTE}" could not be read (exit ${fetchUrl.status}) — refusing fail-closed`);
  }
  const pushUrls = await runGit(['remote', 'get-url', '--push', '--all', REMOTE]);
  if (pushUrls.status !== 0) {
    throw fail(EXIT.refusal, `the effective push URLs of remote "${REMOTE}" could not be read (exit ${pushUrls.status}) — refusing fail-closed`);
  }
  const fetchesFrom = fetchUrl.stdout.trim();
  // Only the trailing newline is stripped — the entries are NOT individually trimmed away. An EMPTY
  // entry is a real misconfiguration, not noise: measured, `remote.<name>.pushurl=` makes
  // `git remote get-url --push --all` exit 0 with stdout "\n", and filtering that out let the guard
  // pass over a push destination nothing can name.
  const effective = pushUrls.stdout.replace(/\n$/, '').split('\n');
  if (effective.some((url) => url.trim() === '')) {
    throw fail(
      EXIT.refusal,
      `remote "${REMOTE}" has an EMPTY effective push URL — refusing: a push destination this run cannot name is one it cannot verify (check remote.${REMOTE}.pushurl)`,
    );
  }
  // The differing entries are named by POSITION, never by value. A redaction rule is a filter and a
  // filter can be wrong; not printing the URL at all cannot be. The operator has the config in front of
  // them, so a position and a count are enough to find it, and nothing here could leak a credential
  // even if the sanitizer were deleted.
  const divergentPositions = effective
    .map((url, index) => (url === fetchesFrom ? null : index + 1))
    .filter((position) => position !== null);
  if (divergentPositions.length > 0) {
    throw fail(
      EXIT.refusal,
      `remote "${REMOTE}" pushes somewhere it does not fetch from — refusing: this run can only check where it fetches from, so a PASS would describe a different place than your push reaches.\n`
        + `  ${divergentPositions.length} of ${effective.length} effective push URL(s) differ from the fetch URL, at position(s) ${divergentPositions.join(', ')}.\n`
        + `  The values are deliberately not printed. Read them with:\n    git remote get-url --push --all ${REMOTE}`,
    );
  }
};

// A SHALLOW clone cannot be counted. `rev-list --left-right --count` walks the graph it has, and a
// truncated history hides the very commits that would prove a fast-forward — so on a shallow clone
// the counts can report remote-only commits where the complete graph has none (the objects are real;
// the truncation misclassifies them), this run would print that as a divergence, and the divergence
// arm's remedy is a FORCE-PUSH. Printing a force-push against a
// false divergence is the worst outcome this script could produce, so the shallow case is refused
// BEFORE the fetch: no network act, no counts, no topology, no remedy — only the condition and how
// to remove it.
export const assertCompleteHistory = async (runGit) => {
  const res = await runGit(['rev-parse', '--is-shallow-repository']);
  if (res.error != null || res.signal != null || res.status !== 0) {
    throw fail(
      EXIT.refusal,
      'whether this repository is shallow could not be established — refusing fail-closed, because every count this run would print depends on a complete history.'
        + (res.stderr?.trim() ? `\n  git said (verbatim except credential redaction):\n${res.stderr.trim()}` : ''),
    );
  }
  // EXACTLY `true`/`false` with at most one trailing newline — the same bytes dispatch-publish's
  // probe accepts, so the two scripts cannot disagree about the one question that gates a force-push.
  const answer = res.stdout.endsWith('\n') ? res.stdout.slice(0, -1) : res.stdout;
  if (answer === 'false') return;
  if (answer !== 'true') {
    throw fail(
      EXIT.refusal,
      `git answered ${JSON.stringify(res.stdout)} when asked whether this repository is shallow — refusing fail-closed rather than reading an unrecognised answer as a complete history`,
    );
  }
  throw fail(
    EXIT.refusal,
    'this repository is SHALLOW, so a divergence count would be computed over a truncated history and could report remote-only commits where the complete graph has none — refusing before the fetch rather than printing counts, a verdict, or a remedy this run cannot stand behind.\n'
      + '  Deepen the history first:\n    git fetch --unshallow\n'
      + '  Then re-run this check.',
  );
};

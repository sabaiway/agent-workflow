// preflight-remote-sanitize.mjs — the ONE credential-redaction rule the preflight applies to every
// line it emits.
//
// It lives in its own file because it is the concern that churned hardest under review — seven rounds
// found a leak in it — so it earns its own unit of review and its own arms.
//
// THE GOVERNING RULE, learned the expensive way: NEVER RE-EMIT A BYTE THAT CAME OUT OF THE MATCH.
// Every earlier version failed by trying to be clever about the shape of what it redacted, and each new
// cleverness had a new hole:
//   • a denylist of query-parameter NAMES missed `oauth_token` / `client_secret` / `X-Amz-Signature`;
//   • an allowlist of name CHARACTERS then missed `?access[token]=`, `?token~=` and `?a:b=`;
//   • that still missed an EMPTY name (`?=SECRET`) and a quoted one (`?access'token=SECRET`);
//   • a lookahead meant to spare a wrapping quote instead ended the match INSIDE the value, so
//     `?token=AAA'BBB` published `BBB`;
//   • and restoring a "quote plus punctuation" run from the match published a punctuation-only value
//     outright: `?token='!` came back as `?<redacted>'!`.
// The bound that actually holds is on PROVENANCE, not on character class: what gets written after a
// redaction is synthesized from the text BEFORE the match, so no value byte can survive whatever the
// value looked like.
//
// Dependency-free, Node >= 22. No side effects on import.

// Userinfo runs to the LAST `@` inside the authority, not the first: `https://user:tok@TAIL@host/` is a
// single credential and stopping at the first `@` published `TAIL`. `[^/\s]*` cannot cross a `/`, so a
// path segment containing `@` is never mistaken for userinfo.
const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s]*@/g;
const SCP_USERINFO = /(^|[\s'"(<])([^\s/]*)@([^\s@/]+:)/g;

// A `?` reaches this rule only when an `=` follows it before any whitespace, so prose ending in a
// question mark is untouched. The match is GREEDY to the next whitespace: a quote is legal inside a
// query, so nothing inside one may end the match.
const QUERY_STRING = /\?[^\s]*=[^\s]*/g;

// The opening delimiter, read from the UNREDACTED text that precedes the match. git quotes urls in its
// own messages, so a closing quote is worth re-emitting — but it is SYNTHESIZED from this, never copied
// out of the match.
const OPENING_QUOTE = /(['"])[^\s'"]*$/;

const redactQuery = (match, offset, whole) => {
  const opener = OPENING_QUOTE.exec(whole.slice(0, offset));
  return opener === null ? '?<redacted>' : `?<redacted>${opener[1]}`;
};

export const sanitize = (text) => String(text ?? '')
  .replace(URL_USERINFO, '$1<redacted>@')
  .replace(SCP_USERINFO, '$1<redacted>@$3')
  .replace(QUERY_STRING, redactQuery);

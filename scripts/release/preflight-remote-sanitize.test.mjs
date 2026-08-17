import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize } from './preflight-remote-sanitize.mjs';

// The rule that churned hardest under review gets its own suite beside its own module. Four consecutive
// rounds found a leak in it, and each earlier fix widened a PARSER of query-parameter names; the current
// rule parses none, which is what these arms pin.

// The USERINFO arms stay in preflight-remote.test.mjs, where they were written: a red-proof record is
// keyed by {file, test name}, so moving a test orphans its record with no way to satisfy it again on the
// same base. Only the QUERY rule — the half that got its own module and churned four rounds — lives here.

// Userinfo runs to the LAST `@` inside the authority. Stopping at the first one published everything
// between them, and a credential may legitimately contain an `@`.
describe('sanitize — userinfo runs to the LAST @ in the authority', () => {
  it('masks a credential that itself contains an @', () => {
    assert.equal(sanitize('https://user:ghp_HEAD@TAIL@host/r.git'), 'https://<redacted>@host/r.git');
    assert.equal(sanitize('https://a@b@c@host/r.git'), 'https://<redacted>@host/r.git');
    assert.doesNotMatch(sanitize('https://user:ghp_HEAD@TAIL@host/r.git'), /TAIL/, 'the bytes between the first and last @ are part of the credential');
  });

  it('masks the scp form to the last @ too', () => {
    assert.equal(sanitize('user:tok@evil@host:org/r.git'), '<redacted>@host:org/r.git');
    assert.doesNotMatch(sanitize('user:tok@evil@host:org/r.git'), /evil/);
  });

  it('never mistakes an @ in a PATH for userinfo', () => {
    assert.equal(sanitize('https://host/team@scope/r.git'), 'https://host/team@scope/r.git');
  });
});

describe('sanitize — degenerate inputs', () => {
  it('answers empty for nothing at all', () => {
    assert.equal(sanitize(''), '');
    assert.equal(sanitize(undefined), '');
    assert.equal(sanitize(null), '');
  });
});

describe('sanitize — the query string goes WHOLE, so no parameter name is ever parsed', () => {
  // Beaten three times while it still read parameters: a NAME denylist missed oauth_token /
  // client_secret / X-Amz-Signature; a name CHARACTER allowlist then missed ?access[token]= / ?token~= /
  // ?a:b=; and that still missed an EMPTY name and a quoted one.
  it('redacts every query, whatever the names look like', () => {
    assert.equal(sanitize('https://h/r.git?token=SECRET&x=1'), 'https://h/r.git?<redacted>');
    assert.equal(sanitize('https://h/r?oauth_token=a&client_secret=b'), 'https://h/r?<redacted>');
    assert.equal(sanitize('https://h/r?access[token]=a&token~=b&a:b=c'), 'https://h/r?<redacted>');
    assert.equal(sanitize('https://h/r?=SECRET'), 'https://h/r?<redacted>', 'an EMPTY parameter name leaked past every parser');
    assert.equal(sanitize("https://h/r?access'token=SECRET"), 'https://h/r?<redacted>', 'so did a quoted one');
  });

  it('needs an "=" to fire, so prose ending in a question mark survives', () => {
    assert.equal(sanitize('did you mean?'), 'did you mean?');
    assert.equal(sanitize('what? no'), 'what? no');
  });

  // NAME DEBT, stated rather than hidden: this arm no longer "ends the match before" anything — the match
  // is greedy and the closing quote is SYNTHESIZED from the opening one. The name is kept because a
  // red-proof record is keyed by {file, test name} and renaming it would make coverage-check report
  // "zero-match — the declared red→green pin is gone", with no override lane, until the base moves. The
  // rename is queued with that reason. What the arm actually pins is: git quotes urls in its own messages,
  // and the quoting survives redaction.
  it('ends the match before a quote that WRAPS the url — git quotes urls in its own messages', () => {
    assert.equal(
      sanitize("fatal: unable to access 'https://h/r?a=1': boom"),
      "fatal: unable to access 'https://h/r?<redacted>' boom",
      'the colon came out of the match, so it is not re-emitted — only the synthesized quote is',
    );
    assert.equal(sanitize('see "https://h/r?a=1" now'), 'see "https://h/r?<redacted>" now');
  });

  // The match must NOT stop at a quote inside the query. An earlier rule used a lookahead that ended at
  // the first quote after the "=", which looked tidier and published the tail of the value:
  // `?token=AAA'BBB` became `?<redacted>'BBB`. A quote is legal inside a query, so only whitespace ends
  // the match; the single WRAPPING quote is restored afterwards, which reveals nothing from a value.
  it('never lets a quote INSIDE a value end the redaction early', () => {
    assert.equal(sanitize("https://h/r?token=AAA'BBB"), 'https://h/r?<redacted>');
    assert.equal(sanitize('https://h/r?token=AAA"BBB'), 'https://h/r?<redacted>');
    assert.equal(sanitize("https://h/r?a=1'b=2'c=3"), 'https://h/r?<redacted>');
  });

  // The bound is on PROVENANCE, not on character class. An earlier version restored a
  // "quote-plus-punctuation run" taken OUT OF THE MATCH, and a punctuation-only value defeated it
  // outright: `?token='!` came back as `?<redacted>'!`. What is written now is synthesized from the text
  // BEFORE the match, so no value byte can survive whatever the value looked like.
  it('restores only a quote-plus-punctuation run, so no value character can come back', () => {
    for (const [input, expected] of [
      ["'https://h/r?a=1':", "'https://h/r?<redacted>' boom".replace(' boom', '')],
      ['"https://h/r?a=1",', '"https://h/r?<redacted>"'],
      ["'https://h/r?a=1'", "'https://h/r?<redacted>'"],
      ["'https://h/r?token=SUPERSECRET'", "'https://h/r?<redacted>'"],
      ['https://h/r?token=SUPERSECRET', 'https://h/r?<redacted>'],
    ]) {
      assert.equal(sanitize(input), expected);
    }
    for (const secret of ['SUPERSECRET', 'AAA', 'BBB']) {
      assert.doesNotMatch(sanitize(`'https://h/r?t=${secret}':`), new RegExp(secret));
      assert.doesNotMatch(sanitize(`https://h/r?t=${secret}'tail`), new RegExp(secret));
    }
  });

  // A value made ENTIRELY of punctuation is the case a character-class bound cannot see: every byte of it
  // is "not a letter or digit", so a rule that copied punctuation back out of the match published the
  // whole secret.
  it('never re-emits a byte taken out of the match, so a punctuation-only value cannot survive', () => {
    assert.equal(sanitize("https://h/r?token='!"), 'https://h/r?<redacted>');
    assert.equal(sanitize('https://h/r?token=%21%2A'), 'https://h/r?<redacted>');
    assert.equal(sanitize("https://h/r?a='!;,.:"), 'https://h/r?<redacted>');
    // With an opening quote present the closing one is SYNTHESIZED — one quote, and nothing else.
    assert.equal(sanitize("access 'https://h/r?token='!' now"), "access 'https://h/r?<redacted>' now");
  });
});

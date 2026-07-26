// state-block-guard.test.mjs — spec-first for the CONTINUATION-STALL detector (queue class, part 2
// plus the announce-and-stop sub-shape). The guard is a `Stop` hook: at Stop time the turn is
// ENDING, which makes two closing-block shapes provably false rather than merely discouraged —
//   • «what I need from you: nothing» — a stopped turn always needs a resume, so the slot must name
//     it. Honest only while work is actually running, and at Stop nothing is;
//   • a first-person promise of imminent work («беру…», «начинаю…», «I'll start…») — the turn is
//     over, so the work is not starting. This is the announce-and-stop shape that fired five times.
// The module is imported DYNAMICALLY (the authoring pattern): this spec LOADS on the
// pre-implementation tree and fails per assertion, never with a load error.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK_PATH = fileURLToPath(new URL('../references/hooks/state-block-guard.mjs', import.meta.url));

const mod = await import('../references/hooks/state-block-guard.mjs').catch(() => null);
const { findStateBlock, decideStop, runHook, readStdin, main, HOOK_EVENT_NAME } = mod ?? {};

const GOOD = `
Работа закрыта, гейты зелёные.

**Что сейчас:** kit 3.13.0 отгружен, дерево чистое.
**Что нужно от вас:** одно «да» на публикацию — без него дальше не двигаюсь.
**Что дальше:** после вашего «да» — дispatch и смоук.
`;

describe('state-block-guard — the closing block is found at all', () => {
  it('module exists (authored red-first)', () => {
    assert.ok(mod, 'references/hooks/state-block-guard.mjs must exist and load');
  });

  it('finds the three slots in a well-formed closing block', () => {
    const block = findStateBlock(GOOD);
    assert.notEqual(block, null, 'a well-formed block must be recognised');
    assert.match(block.now, /3\.13\.0/);
    assert.match(block.fromYou, /одно «да»/);
    assert.match(block.next, /dispatch|дispatch/);
  });

  // The kit does NOT mandate the three-part block — it is a per-project dialogue contract. Warning
  // whenever a block is absent would fire on nearly every turn of a project that never adopted it,
  // which is the noise a hook running on EVERY turn must not become. So the absent-block report is
  // opt-in, and the default is silence.
  it('a message with NO closing block is SILENT by default — the block is opt-in, not assumed', () => {
    const r = decideStop({ closingText: 'Готово, всё зелёное.' });
    assert.equal(r.ok, true, 'a project that never adopted the block must not be warned every turn');
  });

  it('a message with NO closing block IS reported under requireBlock', () => {
    const r = decideStop({ closingText: 'Готово, всё зелёное.', requireBlock: true });
    assert.equal(r.ok, false);
    assert.ok(r.reasons.some((reason) => /no state block/i.test(reason)));
  });

  it('a well-formed block naming a real unblocker passes', () => {
    const r = decideStop({ closingText: GOOD });
    assert.equal(r.ok, true, r.reasons.join(' · '));
  });
});

describe('state-block-guard — «nothing needed» is FALSE at Stop, not merely discouraged', () => {
  const banned = [
    'ничего',
    'сейчас — ничего; разблокировка на мне',
    'ничего для следующего шага — беру класс и начинаю',
    'ваше присутствие не требуется прямо сейчас',
    'от вас ничего не требуется',
    'nothing right now',
    'n/a',
  ];
  for (const slot of banned) {
    it(`rejects a from-you slot reading «${slot.slice(0, 40)}»`, () => {
      const text = GOOD.replace('одно «да» на публикацию — без него дальше не двигаюсь', slot);
      const r = decideStop({ closingText: text });
      assert.equal(r.ok, false, 'a stopped turn always needs a resume — the slot must name it');
      assert.ok(r.reasons.some((reason) => /from-you/i.test(reason)), r.reasons.join(' · '));
    });
  }

  it('a slot that merely CONTAINS the word later is fine — only the opening answer is judged', () => {
    const text = GOOD.replace(
      'одно «да» на публикацию — без него дальше не двигаюсь',
      'подтвердите публикацию; ничего другого от вас не нужно',
    );
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `the slot answers with a real ask first: ${r.reasons.join(' · ')}`);
  });
});

describe('state-block-guard — the announce-and-stop shape', () => {
  const promises = ['беру класс и начинаю', 'перехожу к следующему классу', 'сажусь за хук', 'I\'ll start on the hook'];
  for (const promise of promises) {
    it(`rejects a what-next slot promising imminent work: «${promise}»`, () => {
      const text = GOOD.replace('после вашего «да» — дispatch и смоук', promise);
      const r = decideStop({ closingText: text });
      assert.equal(r.ok, false, 'the turn is ending, so the promised work is not starting');
      assert.ok(r.reasons.some((reason) => /announce/i.test(reason)), r.reasons.join(' · '));
    });
  }

  it('a CONDITIONAL next step is not an announce — it waits on something named', () => {
    const text = GOOD.replace('после вашего «да» — дispatch и смоук', 'после вашего согласия беру следующий класс');
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `a promise gated on the maintainer is honest: ${r.reasons.join(' · ')}`);
  });
});

// The real specimens. These are the VERBATIM closing slots that fired this class on 2026-07-25 and
// were each caught by the maintainer reading carefully. A detector that cannot catch its own corpus
// is decoration, so they are pinned as fixtures rather than paraphrased.
describe('state-block-guard — the live corpus it exists to catch', () => {
  const corpus = [
    {
      firing: '№3 — hedged nothing, unblocker named afterwards',
      fromYou: 'сейчас — ничего; разблокировка на мне (финальная аттестация → red-proof → --final)',
      next: 'доведу до сводного спроса и покажу точные командные строки',
      expect: /from-you/i,
    },
    {
      firing: '№4 — hedged nothing PLUS announce-and-stop in one line',
      fromYou: 'ничего для следующего шага — беру AGY-OVERSIZED-CODE-REVIEW и начинаю',
      next: 'сажусь за agy-класс — разбираюсь, почему обход упирается в auto-deny',
      expect: /from-you/i,
    },
    {
      firing: '№5 — presence-not-required, the sharpest hedge',
      fromYou: 'ваше присутствие не требуется прямо сейчас; когда дойдёт до правки прав agy — принесу дифф',
      next: 'проверяю, даёт ли этот хост хук Stop с доступом к транскрипту, и если да — пишу его',
      expect: /from-you/i,
    },
  ];

  for (const { firing, fromYou, next, expect } of corpus) {
    it(`catches firing ${firing}`, () => {
      const text = `**Что сейчас:** дерево чистое.\n**Что нужно от вас:** ${fromYou}\n**Что дальше:** ${next}`;
      const r = decideStop({ closingText: text });
      assert.equal(r.ok, false, 'a specimen the maintainer caught by hand must not pass the detector');
      assert.ok(r.reasons.some((reason) => expect.test(reason)), r.reasons.join(' · '));
    });
  }

  it('the announce half is caught independently of the from-you half', () => {
    const text = '**Что сейчас:** дерево чистое.\n'
      + '**Что нужно от вас:** одно «да» на публикацию.\n'
      + '**Что дальше:** сажусь за agy-класс — разбираюсь, почему обход упирается в auto-deny';
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, false, 'an honest from-you slot does not excuse promising work as the turn ends');
    assert.ok(r.reasons.some((reason) => /announce/i.test(reason)), r.reasons.join(' · '));
    assert.ok(r.reasons.every((reason) => !/from-you/i.test(reason)), 'and the from-you slot is NOT flagged here');
  });
});

// The council folds. Every case below is a specimen a review backend produced against the first
// draft; each was confirmed against the code before it was folded, and each is pinned here rather
// than described in prose, because prose has no checker.
describe('state-block-guard — council folds: the honest phrase must survive the banned one', () => {
  const withFromYou = (slot) => GOOD.replace('одно «да» на публикацию — без него дальше не двигаюсь', slot);

  // `'не нужно'` occurs INSIDE «мне нужно» — «м|не нужно» — so raw substring matching flags the most
  // natural way there is to name a real ask. JavaScript's \b is ASCII-only and cannot help with
  // Cyrillic; the boundaries have to be Unicode-aware.
  const honest = [
    'мне нужно ваше подтверждение по версии',
    'мне нужен ваш ответ про публикацию',
    'скажите, не нужно ли добавить ещё один тест',
    'a nonexistent flag needs your call before I proceed',
  ];
  for (const slot of honest) {
    it(`passes an honest ask that merely CONTAINS a banned form inside a word: «${slot.slice(0, 44)}»`, () => {
      const r = decideStop({ closingText: withFromYou(slot) });
      assert.equal(r.ok, true, r.reasons.join(' · '));
    });
  }

  it('still catches the banned form when it stands as its own word', () => {
    for (const slot of ['ничего не нужно', 'от вас ничего не требуется', 'nothing needed right now']) {
      const r = decideStop({ closingText: withFromYou(slot) });
      assert.equal(r.ok, false, `«${slot}» must still be caught`);
    }
  });

  it('an EMPTY or whitespace-only from-you slot is a "nothing" answer, not a pass', () => {
    for (const slot of ['', '   ']) {
      const text = `**Что сейчас:** ok\n**Что нужно от вас:** ${slot}\n**Что дальше:** после вашего «да» — публикую`;
      const r = decideStop({ closingText: text });
      assert.equal(r.ok, false, 'a slot that answers nothing at all names no unblocker');
      assert.ok(r.reasons.some((reason) => /from-you/i.test(reason)), r.reasons.join(' · '));
    }
  });
});

describe('state-block-guard — council folds: a condition excuses only what it precedes', () => {
  const withNext = (slot) => GOOD.replace('после вашего «да» — дispatch и смоук', slot);

  for (const slot of ['беру класс; если тест упадёт, сообщу', 'беру класс, а если тест упадёт, сообщу']) {
    it(`catches a promise whose condition gates something else: «${slot}»`, () => {
      const r = decideStop({ closingText: withNext(slot) });
      assert.equal(r.ok, false, 'the condition does not gate the promise — the work still is not starting');
      assert.ok(r.reasons.some((reason) => /announce/i.test(reason)), r.reasons.join(' · '));
    });
  }

  it('a condition stated BEFORE the promise still passes', () => {
    const r = decideStop({ closingText: withNext('после вашего согласия беру следующий класс') });
    assert.equal(r.ok, true, r.reasons.join(' · '));
  });

  // The STATED residual, pinned so it cannot drift silently: a trailing condition reads as an
  // announce. Leading with the gate is both the fix and the clearer sentence.
  it('a TRAILING condition is flagged — the documented residual, lead with the gate instead', () => {
    const r = decideStop({ closingText: withNext('беру, когда вы скажете') });
    assert.equal(r.ok, false, 'documented residual: state the condition first');
  });
});

describe('state-block-guard — council folds: judge the REAL closing block, never quoted prose', () => {
  const REAL = '**Что сейчас:** ok\n**Что нужно от вас:** одно «да» на публикацию.\n**Что дальше:** после вашего «да» — публикую';

  it('a defective block QUOTED earlier in the message does not decide the turn', () => {
    const text = `Разбираю прошлый дефект. Тогда слот читался так:\n\n> **Что сейчас:** ok\n> **Что нужно от вас:** ничего\n> **Что дальше:** беру класс\n\nТеперь по делу.\n\n${REAL}`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `the real closing block is well-formed: ${r.reasons.join(' · ')}`);
  });

  it('a defective block inside a FENCED CODE example does not decide the turn', () => {
    const text = `Пример того, что ловит хук:\n\n\`\`\`\n**Что сейчас:** ok\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс\n\`\`\`\n\n${REAL}`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `the fenced example is not the closing block: ${r.reasons.join(' · ')}`);
  });

  it('a REAL defective block still loses to nothing — it is the last block that decides', () => {
    const text = `${REAL}\n\nА теперь настоящий финал:\n\n**Что сейчас:** ok\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, false, 'the LAST block is the one the turn ends on');
    assert.ok(r.reasons.some((reason) => /from-you/i.test(reason)), r.reasons.join(' · '));
  });

  it('slot labels mentioned INLINE in prose do not form a block', () => {
    const text = `Правило простое: слот «что нужно от вас:» никогда не отвечает «ничего».\n\n${REAL}`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `an inline mention is not a block: ${r.reasons.join(' · ')}`);
  });
});

// Round-2 council folds.
describe('state-block-guard — council folds: the block is a GROUP, never spliced labels', () => {
  const COMPLETE_BAD = '**Что сейчас:** ok\n**Что нужно от вас:** ничего\n**Что дальше:** после «да» — публикую';
  const COMPLETE_GOOD = '**Что сейчас:** ok\n**Что нужно от вас:** одно «да».\n**Что дальше:** после «да» — публикую';

  // Taking the LAST match of each label independently splices a trailing INCOMPLETE block with the
  // from-you line of an earlier one — fabricating a block nobody wrote, and satisfying --require-block
  // when no complete block exists.
  it('a trailing INCOMPLETE block does not borrow the missing slot from an earlier block', () => {
    const text = `${COMPLETE_GOOD}\n\nПостскриптум:\n**Что сейчас:** ещё пара мыслей\n**Что дальше:** беру класс`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `an incomplete tail is NOT a block: ${r.reasons.join(' · ')}`);
  });

  it('the incomplete trailing block means NO block — so --require-block reports it', () => {
    const text = `${COMPLETE_GOOD}\n\nПостскриптум:\n**Что сейчас:** ещё пара мыслей\n**Что дальше:** беру класс`;
    const r = decideStop({ closingText: text, requireBlock: true });
    assert.equal(r.ok, false, 'the turn did not END on a complete block');
    assert.ok(r.reasons.some((reason) => /no state block/i.test(reason)), r.reasons.join(' · '));
  });

  it('a candidate abandoned by a REPEATED label restarts there and the later complete block decides', () => {
    const text = `**Что сейчас:** черновик\n**Что сейчас:** правка\n\n${COMPLETE_BAD}`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, false, 'the completed block after the repeat is the one that decides');
    assert.ok(r.reasons.some((reason) => /from-you/i.test(reason)), r.reasons.join(' · '));
  });
});

describe('state-block-guard — council folds: the gate rides the promise segment', () => {
  const withNext = (slot) => GOOD.replace('после вашего «да» — дispatch и смоук', slot);

  it('a gate before the promise INSIDE one segment passes, comma and all', () => {
    const r = decideStop({ closingText: withNext('если вы согласны, беру класс') });
    assert.equal(r.ok, true, r.reasons.join(' · '));
  });

  it('a gate belonging to a COMPLETED earlier segment does not excuse the promise', () => {
    const r = decideStop({ closingText: withNext('если тест упадёт, сообщу; беру класс') });
    assert.equal(r.ok, false, 'that condition gates a finished clause, not the promise');
    assert.ok(r.reasons.some((reason) => /announce/i.test(reason)), r.reasons.join(' · '));
  });

  // `.` was taught to end a sentence and `!` / `?` were not, so an exclamation reopened the exact
  // hole the dot fix closed.
  for (const slot of ['если тест упадёт, сообщу! начинаю следующий класс', 'если тест упадёт, сообщу? беру класс']) {
    it(`«!» and «?» end a segment too: «${slot.slice(0, 44)}»`, () => {
      const r = decideStop({ closingText: withNext(slot) });
      assert.equal(r.ok, false, 'the gate belongs to the finished sentence, not to the promise');
      assert.ok(r.reasons.some((reason) => /announce/i.test(reason)), r.reasons.join(' · '));
    });
  }

  it('"going to" is only a promise in the FIRST person', () => {
    const r = decideStop({ closingText: withNext('CI is going to finish, then I report') });
    assert.equal(r.ok, true, `someone else's future is not my announce: ${r.reasons.join(' · ')}`);
  });
});

describe('state-block-guard — council folds: a comma never carries the answer', () => {
  const withFromYou = (slot) => GOOD.replace('одно «да» на публикацию — без него дальше не двигаюсь', slot);

  // The comma must NOT become a clause boundary: it would let a harmless prefix carry the answer.
  it('a comma does NOT let a bare "nothing" hide behind a prefix', () => {
    for (const slot of ['сейчас, ничего', 'от вас, по сути, ничего']) {
      const r = decideStop({ closingText: withFromYou(slot) });
      assert.equal(r.ok, false, `«${slot}» must still be caught`);
    }
  });

  it('a bare "ничего другого не нужно" with no ask before it is caught', () => {
    const r = decideStop({ closingText: withFromYou('ничего другого не нужно') });
    assert.equal(r.ok, false, 'qualifying the nothing does not name an unblocker');
  });
});

// Round-3 council folds.
describe('state-block-guard — council folds: the answer is a clause, not a character count', () => {
  const withFromYou = (slot) => GOOD.replace('одно «да» на публикацию — без него дальше не двигаюсь', slot);
  const withNext = (slot) => GOOD.replace('после вашего «да» — дispatch и смоук', slot);

  it('a banned form after a LONG preamble is still the answer', () => {
    const slot = 'по итогам сегодняшнего разбора всей серии, всех гейтов и всех мостов — ничего';
    assert.ok(slot.indexOf('ничего') > 60, 'the fixture must sit past the old character cap');
    const r = decideStop({ closingText: withFromYou(slot) });
    assert.equal(r.ok, false, 'a character cap cannot decide where an answer ends');
  });

  // A bare `.` is not a sentence boundary — file names carry dots, and splitting on them both hid a
  // banned form and split an honest gated promise across two segments.
  it('a dot inside a filename does not end the clause', () => {
    const r = decideStop({ closingText: withFromYou('по README.md ничего не требуется') });
    assert.equal(r.ok, false, 'the answer is still "nothing" — README.md is not a sentence end');
  });

  it('a dot inside a filename does not split a gated promise', () => {
    const r = decideStop({ closingText: withNext('после решения по README.md беру класс') });
    assert.equal(r.ok, true, `the gate and the promise are one thought: ${r.reasons.join(' · ')}`);
  });
});

describe('state-block-guard — council folds: a verb of opinion is not a promise of work', () => {
  const withNext = (slot) => GOOD.replace('после вашего «да» — дispatch и смоук', slot);

  for (const slot of ['считаю задачу завершённой', 'смотрю на вопрос как на закрытый']) {
    it(`does not read a stative verb as an announce: «${slot}»`, () => {
      const r = decideStop({ closingText: withNext(slot) });
      assert.equal(r.ok, true, r.reasons.join(' · '));
    });
  }
});

// Round-4 folds. Two rules were DELETED rather than tightened a third time: each had produced a
// finding in three consecutive rounds, and each next fix needed a second classifier. What replaces
// them is a named residual with a test, so the limit is visible instead of drifting.
describe('state-block-guard — deleted rule: a comma-joined qualifier is FLAGGED (named residual)', () => {
  const withFromYou = (slot) => GOOD.replace('одно «да» на публикацию — без него дальше не двигаюсь', slot);

  for (const slot of ['одно «да», ничего другого не нужно', 'прямо сейчас, ничего другого не нужно']) {
    it(`flags «${slot.slice(0, 40)}» — the writer's fix is a clause break, not a comma`, () => {
      const r = decideStop({ closingText: withFromYou(slot) });
      assert.equal(r.ok, false, 'no qualifier rule survives: every version excused a banned answer behind a prefix');
    });
  }

  it('the clause-break form of the same sentence passes', () => {
    const r = decideStop({ closingText: withFromYou('одно «да» на публикацию; ничего другого не нужно') });
    assert.equal(r.ok, true, r.reasons.join(' · '));
  });
});

describe('state-block-guard — named residual: a gate in an earlier comma-clause still excuses', () => {
  // Pinned as CURRENT BEHAVIOUR, not as a preference. Lexical token order cannot bind a condition to
  // the promise it actually gates; every candidate fix reopened a shape that is green above. The
  // limit is recorded here so it cannot change silently.
  it('does not catch «если тест упадёт, сообщу, а сейчас начинаю следующий класс»', () => {
    const text = GOOD.replace('после вашего «да» — дispatch и смоук', 'если тест упадёт, сообщу, а сейчас начинаю следующий класс');
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, 'accepted lexical-layer residual — documented in the mode contract');
  });
});

// Round-5 folds.
describe('state-block-guard — council folds: the English twins must actually be twins', () => {
  const withNext = (slot) => GOOD.replace('после вашего «да» — дispatch и смоук', slot);

  for (const slot of [
    "if CI passes, I'll publish",
    "when CI finishes, I'll publish",
    "after the review lands, I'll publish",
    "as soon as you say yes, I'll publish",
  ]) {
    it(`an English gated promise is not an announce: «${slot}»`, () => {
      const r = decideStop({ closingText: withNext(slot) });
      assert.equal(r.ok, true, `the doc promises English twins: ${r.reasons.join(' · ')}`);
    });
  }

  // A model writes «What’s next» and «I’ll» with a TYPOGRAPHIC apostrophe far more often than with
  // the ASCII one. Matching only ASCII meant the English half silently failed on ordinary output.
  it('typographic apostrophes parse — the label AND the promise', () => {
    const text = '**Что сейчас:** ok\n**Что нужно от вас:** одно «да».\n**What’s next:** I’ll start on the hook';
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, false, 'a curly apostrophe is not a hiding place');
    assert.ok(r.reasons.some((reason) => /announce/i.test(reason)), r.reasons.join(' · '));
  });

  // Waiting is not work — it is what a turn that ENDS actually does — so it needs no gate to be
  // honest. The English markers are pronoun+modal and cannot tell «I'll start» from «I'll wait».
  for (const slot of ["I'll wait for your approval", 'I will stand by until you reply', "I'll hold until you say go"]) {
    it(`waiting is not an announce: «${slot}»`, () => {
      const r = decideStop({ closingText: withNext(slot) });
      assert.equal(r.ok, true, r.reasons.join(' · '));
    });
  }

  it('an UNgated English promise is still an announce', () => {
    const r = decideStop({ closingText: withNext("I'll publish the release now") });
    assert.equal(r.ok, false, 'no gate, no excuse');
  });

  // «по вашему запросу» names a PAST request, not a future dependency, so it excused an announce
  // that waits on nothing. Removed from the gate list rather than qualified — «после вашего
  // согласия» already covers the honest shape.
  it('a past-tense "at your request" is not a gate', () => {
    const r = decideStop({ closingText: withNext('по вашему запросу начинаю следующий класс') });
    assert.equal(r.ok, false, 'nothing is being waited on — the work simply is not starting');
  });
});

describe('state-block-guard — council folds: a fence closes only on its own line', () => {
  const REAL = '**Что сейчас:** ok\n**Что нужно от вас:** одно «да» на публикацию.\n**Что дальше:** после «да» — публикую';

  it('a LONGER closing fence still closes the block', () => {
    const text = `Пример:\n\n\`\`\`\n**Что нужно от вас:** ничего\n\`\`\`\`\n\n${REAL}`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `the example is fenced: ${r.reasons.join(' · ')}`);
  });

  it('a closing fence carrying trailing text does NOT close — the fence runs on', () => {
    const text = `Пример:\n\n\`\`\`\n**Что сейчас:** x\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс\n\`\`\`suffix\n\n${REAL}`;
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `nothing survives the fence, so there is nothing to flag: ${r.reasons.join(' · ')}`);
    const strict = decideStop({ closingText: text, requireBlock: true });
    assert.equal(strict.ok, false, 'and the strict mode says there is no block at all');
  });

  // An UNCLOSED fence must swallow the rest of the message. The doc promises fenced code is excluded;
  // a stripper that only removes CLOSED fences would take an unfinished example's labels for a real
  // block — judging a demonstration as if it were the turn.
  // CRLF is not an exotic input: on a Windows host every line ends `\r\n`, and a close pattern that
  // forbids the stray `\r` would leave EVERY fence open, swallowing the real closing block and
  // blinding the guard completely and silently.
  it('a CRLF fence still closes', () => {
    const text = 'Пример:\r\n\r\n```\r\n**Что нужно от вас:** ничего\r\n```\r\n\r\n'
      + '**Что сейчас:** ok\r\n**Что нужно от вас:** ничего\r\n**Что дальше:** беру класс\r\n';
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, false, 'the fence closed, so the REAL block after it is judged');
    assert.ok(r.reasons.some((reason) => /from-you/i.test(reason)), r.reasons.join(' · '));
  });

  it('an UNCLOSED fence runs to the end — its example labels are not a block', () => {
    const text = 'Вот что ловит хук:\n\n```\n**Что сейчас:** x\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс\n';
    const r = decideStop({ closingText: text });
    assert.equal(r.ok, true, `an unfinished example is still an example: ${r.reasons.join(' · ')}`);
    const strict = decideStop({ closingText: text, requireBlock: true });
    assert.equal(strict.ok, false, 'and the strict mode reports the missing block');
  });
});

describe('state-block-guard — the real CLI process, stdin to stdout', () => {
  // The in-process seams prove the logic; only a real subprocess proves the WARNING SURVIVES the
  // exit. `process.exit()` can truncate a pending pipe write, and the warning is the whole product.
  // The child must not inherit this runner's own instrumentation: `NODE_TEST_CONTEXT` and
  // `NODE_V8_COVERAGE` would make the spawned hook behave like a test process and write coverage
  // artefacts of its own.
  const cleanEnv = () => Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_V8_COVERAGE'),
  );
  const runCli = (payload, args = []) => spawnSync(process.execPath, [HOOK_PATH, ...args], {
    input: payload,
    encoding: 'utf8',
    env: cleanEnv(),
  });

  it('emits the warning on stdout and exits 0', () => {
    const result = runCli(JSON.stringify({
      last_assistant_message: '**Что сейчас:** ok\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс',
    }));
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.systemMessage, /from-you/i);
    assert.match(payload.systemMessage, /announce/i);
  });

  it('stays silent on a well-formed block and still exits 0', () => {
    const result = runCli(JSON.stringify({
      last_assistant_message: '**Что сейчас:** ok\n**Что нужно от вас:** одно «да».\n**Что дальше:** после «да» — публикую',
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  });
});

// runHook is the ACTUAL entry point the harness calls — a suite that only exercises decideStop would
// leave the payload→decision chain unproven. `last_assistant_message` is the ONLY source: a
// transcript fallback existed and was deleted, because a lagging transcript can end on the PREVIOUS
// turn's assistant entry and no tail check can tell that apart from the current one. The payload
// shape here is the one this host really delivers, captured live from a real turn end before it was
// pinned.
describe('state-block-guard — runHook, the payload the harness delivers', () => {
  it('judges the delivered last_assistant_message', () => {
    const decision = runHook(JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: '/home/user/.claude/projects/whatever/session.jsonl',
      last_assistant_message: '**Что сейчас:** готово.\n**Что нужно от вас:** ничего\n**Что дальше:** отдыхаю',
    }));
    assert.equal(decision.ok, false);
    assert.ok(decision.reasons.some((r) => /from-you/i.test(r)), decision.reasons.join(' · '));
  });

  it('a well-formed delivered message passes', () => {
    const decision = runHook(JSON.stringify({
      last_assistant_message: '**Что сейчас:** готово.\n**Что нужно от вас:** одно «да» на публикацию.\n**Что дальше:** после вашего «да» — публикую',
    }));
    assert.equal(decision.ok, true, decision.reasons.join(' · '));
  });

  // "Exit 0 on every path" and "say nothing on every path" are DIFFERENT promises, and only the first
  // was ever justified. A guard that has gone blind is a real failure and this project forbids silent
  // ones — so a failure is surfaced. Having nothing to judge is not a failure and stays silent, or a
  // hook that fires every turn would warn every turn on hosts that simply deliver no closing text.
  it('SURFACES a real failure instead of going dark', () => {
    const junk = runHook('not json');
    assert.equal(junk.ok, false);
    assert.ok(junk.reasons.some((r) => /payload/i.test(r)), junk.reasons.join(' · '));

    for (const notAnObject of ['null', '[]', '42', '"a string"']) {
      const decision = runHook(notAnObject);
      assert.equal(decision.ok, false, `${notAnObject} is valid JSON but not a Stop payload`);
      assert.ok(decision.reasons.some((r) => /not a json object/i.test(r)), decision.reasons.join(' · '));
    }
  });

  it('stays SILENT when the host delivers no closing text at all', () => {
    assert.equal(runHook(JSON.stringify({ hook_event_name: 'Stop' })), null);
    assert.equal(
      runHook(JSON.stringify({ transcript_path: '/some/session.jsonl' })),
      null,
      'a transcript path alone is not a source — the fallback was deleted deliberately',
    );
  });

  // An EMPTY string is delivered text, not an absent field: a turn that ended with no prose really
  // did end without a closing block, and the strict mode must be able to say so.
  // A corrupt payload must not look like a quiet host. An ABSENT field is "this host delivers
  // nothing" (silent); a PRESENT field of the wrong type is a broken payload, and silently skipping
  // the check on it would be the loud-failure contract quietly not holding.
  it('a PRESENT last_assistant_message of the wrong type is a FAILURE, not silence', () => {
    for (const value of [42, null, {}, ['x']]) {
      const decision = runHook(JSON.stringify({ last_assistant_message: value }));
      assert.notEqual(decision, null, `${JSON.stringify(value)} is a corrupt payload, not an absent field`);
      assert.equal(decision.ok, false);
      assert.ok(decision.reasons.some((r) => /last_assistant_message/i.test(r)), decision.reasons.join(' · '));
    }
  });

  it('an EMPTY last_assistant_message is judged, not treated as absent', () => {
    assert.equal(runHook(JSON.stringify({ last_assistant_message: '' })).ok, true, 'silent by default');
    const strict = runHook(JSON.stringify({ last_assistant_message: '' }), { requireBlock: true });
    assert.equal(strict.ok, false);
    assert.ok(strict.reasons.some((r) => /no state block/i.test(r)), strict.reasons.join(' · '));
  });
});

describe('state-block-guard — hook posture: it warns, it never blocks', () => {
  it('names the Stop event it wires into', () => {
    assert.equal(HOOK_EVENT_NAME, 'Stop');
  });

  it('reads its payload off the stream it is handed', async () => {
    const payload = JSON.stringify({ last_assistant_message:'x' });
    const got = await readStdin(Readable.from([Buffer.from(payload)]));
    assert.equal(got, payload);
  });

  // The channel is the whole point: on exit 0 a Stop hook's stderr goes to the debug log and is seen
  // by NOBODY (vendor contract, confirmed 2026-07-26). The one user-visible lane at exit 0 is JSON on
  // stdout carrying `systemMessage`. A guard that warns down an invisible channel is decoration.
  it('emits ONE JSON systemMessage carrying every reason, and exits 0', async () => {
    const written = [];
    const code = await main({
      readInput: async () => JSON.stringify({ last_assistant_message:'**Что сейчас:** ok\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс' }),
      write: (line) => written.push(line),
    });
    assert.equal(code, 0, 'the guard reports; it is never what stops a session');
    assert.equal(written.length, 1);
    const payload = JSON.parse(written[0]);
    assert.match(payload.systemMessage, /state-block-guard/i);
    assert.match(payload.systemMessage, /from-you/i);
    assert.match(payload.systemMessage, /announce/i, 'both violations ride the one message');
  });

  // A failure and a finding are different claims: saying "the closing state block is defective" when
  // no block was ever read would be the guard misreporting its own blindness as the writer's fault.
  it('a FAILURE is headed as a failure, not as a defective block', async () => {
    const written = [];
    await main({ readInput: async () => 'not json at all', write: (line) => written.push(line) });
    const message = JSON.parse(written[0]).systemMessage;
    assert.doesNotMatch(message, /closing state block is defective/i, 'no block was judged');
    assert.match(message, /not judged|could not/i, message);
  });

  it('never emits a blocking field — no decision, no continue, no stopReason', async () => {
    const written = [];
    await main({
      readInput: async () => JSON.stringify({ last_assistant_message:'**Что сейчас:** ok\n**Что нужно от вас:** ничего\n**Что дальше:** беру класс' }),
      write: (line) => written.push(line),
    });
    const payload = JSON.parse(written[0]);
    for (const blocking of ['decision', 'continue', 'stopReason', 'hookSpecificOutput']) {
      assert.equal(payload[blocking], undefined, `the guard detects; it must never carry \`${blocking}\``);
    }
  });

  it('stays silent on a well-formed block', async () => {
    const written = [];
    const code = await main({
      readInput: async () => JSON.stringify({ last_assistant_message:'**Что сейчас:** ok\n**Что нужно от вас:** одно «да».\n**Что дальше:** после вашего «да» — публикую' }),
      write: (line) => written.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(written, []);
  });

  // The strict mode and its argument. A misspelled flag must never be read as "default" — that would
  // silently weaken the guard the user opted into, which is the failure mode an opt-in must not have.
  it('--require-block turns the absent-block report on', async () => {
    const written = [];
    await main({
      argv: ['--require-block'],
      readInput: async () => JSON.stringify({ last_assistant_message:'Готово, всё зелёное.' }),
      write: (line) => written.push(line),
    });
    assert.equal(written.length, 1);
    assert.match(JSON.parse(written[0]).systemMessage, /no state block/i);
  });

  it('without the flag an absent block is silent', async () => {
    const written = [];
    await main({
      argv: [],
      readInput: async () => JSON.stringify({ last_assistant_message:'Готово, всё зелёное.' }),
      write: (line) => written.push(line),
    });
    assert.deepEqual(written, []);
  });

  it('an UNKNOWN argument is reported loudly and never silently treated as the default', async () => {
    const written = [];
    const code = await main({
      argv: ['--require-blocks'],
      readInput: async () => JSON.stringify({ last_assistant_message:'Готово, всё зелёное.' }),
      write: (line) => written.push(line),
    });
    assert.equal(code, 0, 'even a usage error never stops the session');
    assert.equal(written.length, 1);
    assert.match(JSON.parse(written[0]).systemMessage, /--require-blocks/, 'the bad argument is named back');
  });

  it('a THROWING input read exits 0 and SAYS SO — never the blocker, never silent either', async () => {
    const written = [];
    const code = await main({
      readInput: async () => { throw new Error('stdin exploded'); },
      write: (line) => written.push(line),
    });
    assert.equal(code, 0, 'the guard is never what stops a session');
    assert.equal(written.length, 1, 'a blind guard is a real failure and this project forbids silent ones');
    assert.match(JSON.parse(written[0]).systemMessage, /stdin exploded/);
  });

  // "Never throws" is a contract, not a tendency: an explicit null argument must not crash the hook
  // that judges every turn.
  it('never throws when handed null instead of an options object', () => {
    assert.doesNotThrow(() => decideStop(null));
    assert.doesNotThrow(() => decideStop());
    assert.doesNotThrow(() => runHook('{}', null));
    assert.equal(runHook('{}', null), null, 'and it still decides nothing when there is nothing to judge');
  });

  it('every decision carries actionable reasons and never throws on junk input', () => {
    for (const junk of [undefined, null, '', 42, {}]) {
      const r = decideStop({ closingText: junk });
      assert.equal(typeof r.ok, 'boolean', `junk input must still decide: ${JSON.stringify(junk)}`);
      assert.ok(Array.isArray(r.reasons));
    }
  });
});

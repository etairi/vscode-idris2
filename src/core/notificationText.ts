/**
 * Notification text shown as it is (`window.show{Information,Warning,Error}Message`).
 *
 * VS Code turns `[label](target)` in a notification's message into a link when the target starts
 * with `command:`, `http://`, `https://` or `file:`, and a click opens it with commands allowed, so
 * a `command:` link runs any command with the arguments in its query [src: VS Code 1.139.1
 * workbench bundle: `parseNotificationMessage` cuts the message at 1,000 characters, replaces each
 * line break with a space and parses it with `parseLinkedText`, whose pattern is
 * `/\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi`; the
 * message renderer makes each link an anchor whose click is opened with `allowCommands: true`].
 * The messages of this extension quote paths, compiler output and error texts, which anybody who
 * can name a folder or write a file controls: a POSIX folder may be called
 * `[Don't Allow](command:workbench.action.terminal.sendSequence?…)`, which would put a link labelled
 * like a button into the consent question itself (M2 third review). No notification of this extension
 * has a link of its own, so every message goes through `plainText`.
 */

/**
 * `message` with a zero-width space (U+200B) between every `]` and a `(` right after it. A link
 * needs `](` (see above), so none can be formed, wherever the text came from; what is shown does
 * not change.
 */
export function plainText(message: string): string {
  return message.replace(/\](?=\()/g, ']\u200b');
}

/**
 * The most a path that `shownPath` shows may take of a message, in UTF-16 code units (what VS
 * Code's cut at 1,000 counts, `parseNotificationMessage`); the middle of a longer one is cut.
 */
export const MAX_SHOWN_PATH = 200;

/**
 * Characters that change how a message reads without being seen: the controls (`\p{Cc}`, C0 and C1;
 * VS Code shows a line break in a notification as a space), U+2028 and U+2029 (`\p{Zl}`, `\p{Zp}`),
 * every format character (`\p{Cf}`: the bidirectional controls U+061C, U+200E, U+200F,
 * U+202A–U+202E and U+2066–U+2069, the zero-width characters U+200B–U+200D, U+2060 and U+FEFF, the
 * soft hyphen U+00AD, the invisible operators U+2061–U+2064, U+180E, U+206A–U+206F, the tag
 * characters U+E0001 and U+E0020–U+E007F, among others), the characters drawn as nothing or as a
 * blank although they are letters or marks (U+034F, the Hangul fillers U+115F, U+1160, U+3164 and
 * U+FFA0, U+17B4, U+17B5, U+2800, and the variation selectors U+180B–U+180D, U+180F, U+FE00–U+FE0F
 * and U+E0100–U+E01EF), the quotes `shownPath` puts around a path (U+201C, U+201D), and the
 * characters drawn like a double quote, so that a name cannot seem to end the quotation: the whole
 * group that Unicode's `confusables.txt` maps to two apostrophes, as U+0022 (U+0022, U+02BA,
 * U+02DD, U+02EE, U+02F6, U+05F2, U+05F4, U+1CD3, U+201C, U+201D, U+201F, U+2033, U+2036, U+3003,
 * U+FF02 [src: `confusables.txt` 18.0.0, 2026-08-06, read on 2026-09-28]), the characters that
 * file maps to three or four apostrophes, which hold two (U+2034, U+2037, U+2057 [src: the same
 * file]), U+201E, U+275D, U+275E, U+2760, U+2E42, U+301D–U+301F and U+1F676–U+1F678, which it does
 * not list but which are drawn as double quotes, and every space other than U+0020 (`\p{Zs}`: the
 * no-break, the en and em, the thin and hair spaces, among others), so that a narrow space cannot
 * join two apostrophes into a double quote either.
 * (*M2 integration after the verification of the third review*: the list named only the bidi and
 * zero-width characters above, so a folder name with a soft hyphen or U+2063 was shown exactly like
 * the name without it. *Second verification*: a name with U+02EE or U+201F seemed to close the
 * quotation and go on with prose. *Verification after Q20–Q22*: so did one with U+05F4, U+05F2,
 * U+3003, U+02F6 or U+1CD3, the rest of that group. *M2 verification of the Q20–Q22 fixes*: so did
 * one with U+2034, which reads as three apostrophes, and two apostrophes a hair or thin space apart.)
 */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180d\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}\u201c\u201d"\u02ba\u02dd\u02ee\u02f6\u05f2\u05f4\u1cd3\u201e\u201f\u2033\u2034\u2036\u2037\u2057\u275d\u275e\u2760\u2e42\u3003\u301d-\u301f\uff02\u{1f676}-\u{1f678}]/u;

/**
 * Characters drawn like an apostrophe: U+0027 and the group `confusables.txt` maps to it [src:
 * 18.0.0, as above], and U+275B and U+275C, the single forms of U+275D and U+275E, which it does not
 * list. Two or more in a row — also with combining marks on them (`\p{M}`) — read like a double
 * quote (the file maps U+0022 itself to two apostrophes), so `shownPath` writes out such a run, its
 * marks included (*verification after Q20–Q22*: `’’` and `‘‘` in a name are drawn much like the
 * quotes around it; *M2 verification of the Q20–Q22 fixes*: `❜❜`, and `’́’` with a mark between);
 * one alone, as in `Bob's`, is kept.
 */
const APOSTROPHE_LIKE =
  /['\u0060\u00b4\u02b9\u02bb\u02bc\u02bd\u02be\u02c8\u02ca\u02cb\u02f4\u0384\u055a\u055b\u055d\u05d9\u05f3\u07f4\u07f5\u144a\u16cc\u1fbd\u1fbf\u1ffe\u2018\u2019\u201b\u2032\u2035\u275b\u275c\u2cff\ua78b\ua78c\uff07\uff40\u{16f51}\u{16f52}\u{1e94b}]/u;

/** A combining mark, drawn on the character before it: it does not break a run of `APOSTROPHE_LIKE`. */
const MARK = /\p{M}/u;

/**
 * A path (a folder name anybody can choose, M2 verification of the third review) as a message shows
 * it: between “ and ”, with each character of `HIDDEN`, and of a run of two or more of
 * `APOSTROPHE_LIKE` (with the combining marks on them), written as `\u{…}`, so that a name cannot end the quotation, break the line
 * or reorder the text around it, and with its middle replaced by
 * `…` when it takes more than `MAX_SHOWN_PATH` UTF-16 code units, so that it cannot push the rest
 * of a message past VS Code's cut at 1,000 (`parseNotificationMessage`, module comment). The cut
 * falls between characters (and between written-out ones), never inside one. (*M2 second
 * verification of the third review*: the bound counted code points, so a path of letters outside
 * the Basic Multilingual Plane took twice as much, and VS Code cut the consent question inside
 * the folder's name, splitting a surrogate pair.) Callers log the whole path where it matters.
 */
export function shownPath(p: string): string {
  const chars = Array.from(p);
  /** In a run of two or more characters drawn like an apostrophe (`APOSTROPHE_LIKE`), with the marks on them. */
  const inRun = chars.map(() => false);
  for (let i = 0; i < chars.length; ) {
    if (!APOSTROPHE_LIKE.test(chars[i])) {
      i++;
      continue;
    }
    let end = i;
    let apostrophes = 0;
    for (; end < chars.length && (APOSTROPHE_LIKE.test(chars[end]) || MARK.test(chars[end])); end++) {
      apostrophes += APOSTROPHE_LIKE.test(chars[end]) ? 1 : 0;
    }
    if (apostrophes >= 2) {
      inRun.fill(true, i, end);
    }
    i = end;
  }
  const parts = chars.map((c, i) => (HIDDEN.test(c) || inRun[i] ? `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}` : c));
  const units = (list: readonly string[]): number => list.reduce((n, part) => n + part.length, 0);
  if (units(parts) <= MAX_SHOWN_PATH) {
    return `“${parts.join('')}”`;
  }
  /** The longest run of `list`'s parts, from its start, within `budget` units. */
  const within = (list: readonly string[], budget: number): string[] => {
    const taken: string[] = [];
    let used = 0;
    for (const part of list) {
      if (used + part.length > budget) {
        break;
      }
      taken.push(part);
      used += part.length;
    }
    return taken;
  };
  const headBudget = Math.floor((MAX_SHOWN_PATH - 1) * 0.4);
  const head = within(parts, headBudget);
  const tail = within([...parts].reverse(), MAX_SHOWN_PATH - 1 - units(head)).reverse();
  return `“${head.join('')}…${tail.join('')}”`;
}

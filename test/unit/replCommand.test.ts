// backend/ide/replCommand.ts: the refusal of Evaluate Selection (ROADMAP §9, 2026-09-28) against
// what idris2 0.8.0 did with the same texts (transcripts eval-command-forms and eval-values), and
// against an oracle of the compiler's lexer — a port of the rules the module comment cites — over
// many generated texts: every text the oracle reads as a command must be refused.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ideCodec } from '../../src/backend/ide/protocol';
import { queryRefusal, replCommandRefusal } from '../../src/backend/ide/replCommand';
import { parseSexp } from '../../src/backend/ide/sexp';
import { repoRoot } from '../fake-tools/paths';

/** Each `(:interpret "TEXT")` of a transcript with whether the compiler ran `:t id` for it (its answer is id's type). */
function interpreted(scenario: string): { text: string; ranTheCommand: boolean; answer: string }[] {
  const file = path.join(repoRoot(), 'test', 'fixtures', 'transcripts', '0.8.0', `${scenario}.jsonl`);
  const events = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { kind: string; text?: string });
  const out: { text: string; ranTheCommand: boolean; answer: string }[] = [];
  let pending: string | undefined;
  for (const event of events) {
    if (event.kind === 'send') {
      const request = parseSexp(event.text ?? '');
      const command = request.kind === 'list' ? request.items[0] : undefined;
      const head = command?.kind === 'list' ? command.items[0] : undefined;
      const arg = command?.kind === 'list' ? command.items[1] : undefined;
      pending = head?.kind === 'symbol' && head.name === 'interpret' && arg?.kind === 'string' ? arg.value : undefined;
    } else if (event.kind === 'recv' && pending !== undefined) {
      const decoded = ideCodec.decodeMessage(event.text ?? '');
      if (decoded.kind === 'message' && decoded.message.kind === 'return') {
        const payload = decoded.message.payload;
        const answer = payload.kind === 'ok' && payload.result.kind === 'string' ? payload.result.value : payload.kind === 'error' ? payload.message : '';
        out.push({ text: pending, ranTheCommand: answer === 'Prelude.id : a -> a', answer });
        pending = undefined;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// The oracle: the first token the compiler's parser sees, after the Space and Comment tokens that
// `lexTo` drops (src/Parser/Lexer/Source.idr, Common.idr, Prelude isSpace, Core/Name.idr isOpChar
// on v0.8.0).
// -------------------------------------------------------------------------------------------

const IDRIS_SPACE = new Set([' ', '\t', '\r', '\n', '\f', '\v', ' ']);
const OP_CHARS = new Set(':!#$%&*+./<=>?@\\^|-~');

/** The end of a string literal starting at `i` (`"`), escapes skipped; the end of the text if unterminated. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === '\\' ? 2 : 1;
  }
  return Math.min(j + 1, text.length);
}

/** The end of the block comment `{-` at `i` (nested, strings inside skipped), or the end of the text (`blockComment`, `eof` allowed). */
function blockCommentEnd(text: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < text.length && depth > 0) {
    if (text.startsWith('{-', j)) {
      depth++;
      j += 2;
    } else if (text.startsWith('-}', j)) {
      depth--;
      j += 2;
    } else if (text[j] === '"') {
      j = stringEnd(text, j);
    } else {
      j++;
    }
  }
  return j;
}

/** Whether the compiler's parser would read `text` as a REPL command: its first token (spaces and comments dropped) is the symbol `:` or `:?`. */
function compilerReadsCommand(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (IDRIS_SPACE.has(text[i])) {
      i++;
    } else if (text.startsWith('--', i)) {
      let j = i + 2;
      while (text[j] === '-') {
        j++;
      }
      if (text[j] === '}') {
        break; // not a comment (`--}`): an operator
      }
      const nl = text.indexOf('\n', j);
      i = nl < 0 ? text.length : nl;
    } else if (text.startsWith('{-', i)) {
      i = blockCommentEnd(text, i);
    } else {
      break;
    }
  }
  let j = i;
  while (j < text.length && OP_CHARS.has(text[j])) {
    j++;
  }
  const symbol = text.slice(i, j);
  return symbol === ':' || symbol === ':?';
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

suite('backend/ide/replCommand (the refusal of Evaluate Selection)', () => {
  test('eval-command-forms: every text the compiler ran as the command :t id is refused', () => {
    const forms = interpreted('eval-command-forms');
    assert.strictEqual(forms.length, 19);
    const ran = forms.filter((f) => f.ranTheCommand).map((f) => f.text);
    // Space, tab, CR, LF, VT, FF, U+00A0, `{- c -}`, `-- c` and a line break, `: t id`.
    assert.deepStrictEqual(ran, [' :t id', '\t:t id', '\r:t id', '\n:t id', '\v:t id', '\f:t id', ' :t id', '{- c -} :t id', '-- c\n:t id', ': t id']);
    for (const text of ran) {
      assert.ok(replCommandRefusal(text) !== undefined, JSON.stringify(text));
    }
  });

  test('eval-command-forms: what the compiler did not run as a command — refused where the rule is stricter, else sent', () => {
    const decided = new Map(interpreted('eval-command-forms').filter((f) => !f.ranTheCommand).map((f) => [f.text, replCommandRefusal(f.text) !== undefined]));
    assert.deepStrictEqual(Object.fromEntries(decided), {
      // Parse errors for the compiler; refused here, the three characters being skipped as white space or format characters.
      '　:t id': true,
      '​:t id': true,
      '﻿:t id': true,
      // A doc comment is a token: a parse error, not a command.
      '||| d\n:t id': false,
      // U+FF1A is no operator character: an undefined name `：t`.
      '：t id': false,
      // A parse error for the compiler; refused as it starts with ":".
      ':T id': true,
      // Nothing to evaluate: `(:ok "")`.
      '': false,
      '   ': false,
      '-- c': false,
    });
  });

  test('eval-values: the expressions are sent; the one command (:t id) is refused', () => {
    const values = interpreted('eval-values');
    assert.strictEqual(values.length, 11);
    assert.deepStrictEqual(values.filter((v) => replCommandRefusal(v.text) !== undefined).map((v) => v.text), [':t id']);
    assert.deepStrictEqual(values.filter((v) => v.ranTheCommand).map((v) => v.text), [':t id']);
  });

  test('the REPL commands that run programs or change the session are refused however they are preceded', () => {
    for (const command of [':exec putStrLn "hi"', ':set eval execute', ':sh ls', ':cd /', ':q', ':?', ':', ':load Other.idr', ':let x = 1', ':module Data.List']) {
      for (const before of ['', '  ', '\t\n', '\r\n', ' ', ' ', '​﻿', '{- a -}', '{- {- nested -} -}', '{- "-}" -}', '-- c\n', '--- c\r\n', '{- a -} -- b\n  ']) {
        assert.ok(replCommandRefusal(before + command) !== undefined, JSON.stringify(before + command));
      }
    }
  });

  test('the reason is one sentence of plain text that says why and what to do', () => {
    assert.strictEqual(
      replCommandRefusal(':exec main'),
      'Not evaluated: the text starts with ":", so the compiler would read it as a REPL command (such as :exec or :set), ' +
        'and Evaluate Selection evaluates expressions only. Programs are run from a terminal.',
    );
    assert.match(replCommandRefusal('{- c -} :exec main') ?? '', /^Not evaluated: the text starts with a comment and contains ":"/);
  });

  test('expressions are sent, also with colons inside (annotations, cons, strings) and after a comment without one', () => {
    for (const expr of ['the (Vect 2 Nat) [1, 2]', 'x :: xs', '\\x : Nat => x', '"a:b"', 'map (+1) [1,2]', '(:: [])', '：t id', '-- comment\nvlen [1, 2]', '{- c -} 1 + 1', '|||x']) {
      assert.strictEqual(replCommandRefusal(expr), undefined, JSON.stringify(expr));
    }
  });

  test('at least as strict as the compiler: 20,000 generated texts the lexer oracle reads as a command are all refused', () => {
    const alphabet = [' ', '\t', '\n', '\r', ' ', '　', '​', '-', '-', '{', '}', '{-', '-}', '--', ':', ':', '?', '"', '\\', 'x', 'e', '|', '(', '1', '.', '：'];
    const next = prng(20260929);
    let commands = 0;
    for (let n = 0; n < 20_000; n++) {
      const length = 1 + Math.floor(next() * 12);
      let text = '';
      for (let i = 0; i < length; i++) {
        text += alphabet[Math.floor(next() * alphabet.length)];
      }
      if (compilerReadsCommand(text)) {
        commands++;
        assert.ok(replCommandRefusal(text) !== undefined, JSON.stringify(text));
      }
    }
    assert.ok(commands > 1_000, `only ${commands} commands generated`);
  });

  test('the oracle agrees with the compiler on the recorded texts', () => {
    for (const { text, ranTheCommand } of [...interpreted('eval-command-forms'), ...interpreted('eval-values')]) {
      // U+3000, U+200B, U+FEFF and `:T` are parse errors for the compiler; the oracle, which reads
      // only the first token, calls the last one a command (so the check above is stricter).
      if (text === ':T id') {
        assert.strictEqual(compilerReadsCommand(text), true);
        continue;
      }
      assert.strictEqual(compilerReadsCommand(text), ranTheCommand, JSON.stringify(text));
    }
  });
});

suite('backend/ide/replCommand (what the Query box and the -- >>> lenses may send, ROADMAP §9, 2026-10-30)', () => {
  test('eval-query: what the compiler answered: expressions and the allow-listed commands are sent, a second line is refused', () => {
    const asked = interpreted('eval-query');
    assert.deepStrictEqual(asked.map((q) => [q.text, queryRefusal(q.text) === undefined]), [
      ['double 2', true],
      ['the (List Nat) [1, 2]', true],
      [':t double', true],
      [':type double', true],
      [':doc double', true],
      ['doesNotExist', true],
      [':t doesNotExist', true],
      [':doc doesNotExist', true],
      [':t double\n:exec main', false],
    ]);
    // A second line does not run anyway: the compiler reads one command, then expects the end.
    assert.match(asked[8].answer, /Expected end of input/);
    assert.strictEqual(asked[2].answer, 'DocEval.double : Nat -> Nat');
    assert.strictEqual(asked[3].answer, asked[2].answer);
  });

  test('every other command is refused, however it is spelled or preceded', () => {
    for (const command of [':exec putStrLn "hi"', ':set eval execute', ':sh ls', ':cd /', ':q', ':?', ':', ':load Other.idr', ':l Other.idr', ':r', ':let x = 1', ':module Data.Vect', ':e', ':ti id', ':printdef id', ':T id', ':tid', ':docs id', ': t id', ':t', ':t ', ':doc', ':doc\n']) {
      for (const before of ['', '  ', '\t\n', '\r\n', ' ', ' ', '\u200b﻿', '{- a -}', '{- "-}" -}', '-- c\n', '{- a -} -- b\n']) {
        assert.ok(queryRefusal(before + command) !== undefined, JSON.stringify(before + command));
      }
    }
  });

  test(':t and :doc are one line: a line break or a control or format character in the argument is refused', () => {
    for (const text of [':t id\n:exec main', ':t id\r:q', ':t id\u0000', ':doc id\u000b', ':t id\u202e', ':t id\u200b']) {
      assert.ok(queryRefusal(text) !== undefined, JSON.stringify(text));
    }
    for (const text of [':t id', ':t  id', ':t\tid', ':type id', ':doc id', ' :t id', ':t Data.Vect.length', ':t \\x => x', ':doc (::)']) {
      assert.strictEqual(queryRefusal(text), undefined, JSON.stringify(text));
    }
  });

  test('an expression is sent as for Evaluate; what Evaluate refuses after a comment is refused here too; the text says why', () => {
    for (const expr of ['the (Vect 2 Nat) [1, 2]', 'x :: xs', '\\x : Nat => x', '"a:b"', '-- comment\nvlen [1, 2]']) {
      assert.strictEqual(queryRefusal(expr), undefined, JSON.stringify(expr));
    }
    assert.match(queryRefusal('{- c -} x :: xs') ?? '', /^Not run: the text starts with a comment and contains ":"/);
    assert.match(queryRefusal(':exec main') ?? '', /^Not run: of the REPL commands only :t and :doc run here/);
  });

  test('the oracle of the compiler\'s lexer: over generated texts, a command the oracle reads is refused unless it is a plain :t or :doc', () => {
    const pieces = [' ', '\t', '\n', '\r', '-', '{-', '-}', '--', ':', ':t', ':t ', ':doc ', ':type ', ':exec ', ':sh ', ':set ', ':q', 'x', 'id', '"', '\u00a0', '\u200b'];
    const next = prng(20261030);
    let seen = 0;
    for (let n = 0; n < 20_000; n++) {
      const length = 1 + Math.floor(next() * 8);
      let text = '';
      for (let i = 0; i < length; i++) {
        text += pieces[Math.floor(next() * pieces.length)];
      }
      // Skipped characters before an allowed command, a plain :t or :doc, are all that may pass.
      if (compilerReadsCommand(text) && !/^[\p{White_Space}\p{Cc}\p{Cf}]*:(?:t|type|doc)[ \t]+\S(?:\t|[^\p{Cc}\p{Cf}])*$/u.test(text)) {
        seen++;
        assert.ok(queryRefusal(text) !== undefined, JSON.stringify(text));
      }
    }
    assert.ok(seen > 1_000, `only ${seen} commands generated`);
  });
});

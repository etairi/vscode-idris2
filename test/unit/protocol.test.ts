import * as assert from 'assert';
import { IdrisException } from '../../src/core/errors';
import { isKeyword } from '../../src/core/idrisSyntax';
import {
  addClause,
  answersWithPreviousId,
  caseSplit,
  decodeAmbiguity,
  decodeBuildingLine,
  decodeIntro,
  decodeLemma,
  decodeMetavariables,
  decodeMissingCases,
  decodeNameAt,
  decodeSourceHighlights,
  decodeText,
  decodeVersion,
  docsFor,
  generateDef,
  generateDefNext,
  ideCodec,
  interpret,
  intro,
  isEndOfInputLine,
  isHoleName,
  isIdentifierName,
  isOperatorInParentheses,
  loadFile,
  makeCase,
  makeLemma,
  makeWith,
  metavariables,
  missingCases,
  nameAt,
  proofSearch,
  proofSearchNext,
  refine,
  typeOf,
  version,
} from '../../src/backend/ide/protocol';
import { list, parseSexp, serializeSexp, str, sym } from '../../src/backend/ide/sexp';
import type { DecodedMessage, IdeMessage, ReplyPayload, Sexp } from '../../src/backend/ide/types';

function message(text: string): IdeMessage {
  const decoded = ideCodec.decodeMessage(text);
  assert.strictEqual(decoded.kind, 'message', JSON.stringify(decoded, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)));
  return (decoded as Extract<DecodedMessage, { kind: 'message' }>).message;
}

/** The payload of `(:return PAYLOAD 1)`. */
function payload(text: string): ReplyPayload {
  const decoded = message(`(:return ${text} 1)\n`);
  assert.strictEqual(decoded.kind, 'return');
  return (decoded as Extract<IdeMessage, { kind: 'return' }>).payload;
}

function assertProtocolError(f: () => unknown): void {
  assert.throws(f, (e: unknown) => e instanceof IdrisException && e.error.kind === 'ProtocolError');
}

const TYPE_SPAN = { start: 5, length: 4, properties: parseSexp('((:decor :type))') };

suite('backend/ide/protocol', () => {
  suite('ideCodec.encodeRequest', () => {
    test('(COMMAND ID) framed by bytes; :version stays a bare symbol (F4)', () => {
      assert.strictEqual(ideCodec.encodeRequest(version(), 1n).text, '00000d(:version 1)\n');
      assert.strictEqual(ideCodec.encodeRequest(loadFile('/w/Bad.idr'), 2n).text, '00001e((:load-file "/w/Bad.idr") 2)\n');
    });

    test('non-ASCII text is sent as escapes, so the frame is ASCII and its bytes are its characters', () => {
      const frame = ideCodec.encodeRequest(loadFile('/w/dé/Main.idr'), 3n);
      assert.strictEqual(frame.text, '000025((:load-file "/w/d\\233/Main.idr") 3)\n');
      assert.strictEqual(frame.bytes.length, frame.text.length);
    });

    test('a RawCommand is put in verbatim; its non-ASCII text goes as UTF-8 and is counted in bytes', () => {
      assert.strictEqual(ideCodec.encodeRequest({ kind: 'raw', text: '(:version)' }, 2n).text, '00000f((:version) 2)\n');
      const frame = ideCodec.encodeRequest({ kind: 'raw', text: '(:bogus "é")' }, 6n);
      assert.strictEqual(frame.text, '000012((:bogus "é") 6)\n');
      assert.strictEqual(frame.bytes.length, 6 + 0x12);
    });

    test('ids are arbitrary-precision and never negative', () => {
      assert.strictEqual(ideCodec.encodeRequest(version(), 99999999999999999999n).text, '000020(:version 99999999999999999999)\n');
      assert.throws(() => ideCodec.encodeRequest(version(), -1n), RangeError);
      assert.throws(() => ideCodec.encodeRequest({ kind: 'raw', text: '(:version)' }, -1n), RangeError);
    });

    test('a command the compiler could not read back is refused before anything is sent', () => {
      assert.throws(() => ideCodec.encodeRequest(typeOf('a\0b'), 1n), RangeError);
      assert.throws(() => ideCodec.encodeRequest(addClause(-1, 'f'), 1n), RangeError);
    });
  });

  suite('ideCodec.decodeMessage', () => {
    test('text that is not one s-expression is invalid, with the reader\'s reason', () => {
      const decoded = ideCodec.decodeMessage('(:return (:ok "x") 1\n');
      assert.strictEqual(decoded.kind, 'invalid');
      assert.match((decoded as Extract<DecodedMessage, { kind: 'invalid' }>).reason, /offset/);
    });

    for (const text of [
      '()', '"x"', ':return', '(:return)', '(:bogus 1 2)', '(:return (:ok "x") "1")', '(:output (:maybe "x") 1)',
      '(:write-string 1 1)', '(:set-prompt "x")',
      '(:warning ("f" (1 2) (3 4)) 1)', '(:warning ("f" (1 2) (3) "m") 1)', '(:warning (1 (1 2) (3 4) "m") 1)',
      '(:warning ("f" (1 2) (3 4) "m" ((1))) 1)',
    ]) {
      test(`${text} is unknown`, () => {
        assert.deepStrictEqual(ideCodec.decodeMessage(text), { kind: 'unknown', sexp: parseSexp(text) });
      });
    }

    // A handshake of another shape is marked, so that the session can fail at once (session.ts).
    for (const text of ['(:protocol-version 2)', '(:protocol-version 2 "1")', '(:protocol-version 3 0 1)', '(:protocol-version 99999999999999999999 1)']) {
      test(`${text} is unknown, a handshake`, () => {
        assert.deepStrictEqual(ideCodec.decodeMessage(text), { kind: 'unknown', sexp: parseSexp(text), handshake: true });
      });
    }

    // A :return whose payload cannot be read still ends the request with its trailing id.
    for (const [text, id] of [
      ['(:return (:ok "x") 1 2)', 2n], ['(:return (:maybe "x") 1)', 1n], ['(:return (:ok) 1)', 1n],
      ['(:return (:ok "x" ((1 2))) 1)', 1n], ['(:return (:ok "x" (("1" 2 ()))) 1)', 1n], ['(:return (:error 5) 1)', 1n],
      ['(:return (:ok "x" () ()) 1)', 1n], ['(:return (:ok "x" ((99999999999999999999 1 ()))) 1)', 1n],
      ['(:return (:ok "x" () :extra) 7)', 7n],
    ] as const) {
      test(`${text} is unknown, a :return for id ${id}`, () => {
        assert.deepStrictEqual(ideCodec.decodeMessage(text), { kind: 'unknown', sexp: parseSexp(text), returnId: id });
      });
    }

    test('(:protocol-version 2 1)', () => {
      assert.deepStrictEqual(message('(:protocol-version 2 1)\n'), { kind: 'protocol-version', major: 2, minor: 1 });
    });

    test('(:return (:ok RESULT HL) ID) and without HL; ids are bigint', () => {
      assert.deepStrictEqual(message('(:return (:ok "xs : Vect ?_ ?_" ((5 4 ((:decor :type))))) 3)'), {
        kind: 'return', id: 3n, payload: { kind: 'ok', result: str('xs : Vect ?_ ?_'), highlighting: [TYPE_SPAN] },
      });
      assert.deepStrictEqual(message('(:return (:ok ()) 99999999999999999999)'), {
        kind: 'return', id: 99999999999999999999n, payload: { kind: 'ok', result: list(), highlighting: [] },
      });
    });

    test('(:return (:error MESSAGE [HL]) ID)', () => {
      assert.deepStrictEqual(payload('(:error "No clause to split here")'),
        { kind: 'error', message: 'No clause to split here', highlighting: [] });
      assert.deepStrictEqual(payload('(:error "E" ((5 4 ((:decor :type)))))'),
        { kind: 'error', message: 'E', highlighting: [TYPE_SPAN] });
    });

    test('(:output (:ok (:highlight-source HLS)) ID)', () => {
      const text = '(:output (:ok (:highlight-source ((((:filename "/w/C.idr") (:start 0 0) (:end 0 6)) ((:decor :keyword)))))) 1)';
      assert.deepStrictEqual(message(text), {
        kind: 'output',
        id: 1n,
        payload: {
          kind: 'highlight-source',
          highlights: parseSexp('((((:filename "/w/C.idr") (:start 0 0) (:end 0 6)) ((:decor :keyword))))'),
        },
      });
    });

    test('(:write-string TEXT ID) and (:set-prompt TEXT ID)', () => {
      assert.deepStrictEqual(message('(:write-string "1/1: Building Bad (Bad.idr)" 1)'),
        { kind: 'write-string', id: 1n, text: '1/1: Building Bad (Bad.idr)' });
      assert.deepStrictEqual(message('(:set-prompt "*Main> " 4)'), { kind: 'set-prompt', id: 4n, text: '*Main> ' });
    });

    test('(:warning (FILE (L C) (L C) MESSAGE [HL]) ID): positions as sent, 0-based (F6)', () => {
      assert.deepStrictEqual(message('(:warning ("Bad.idr" (3 6) (3 11) "M" ((36 1 ((:decor :bound))))) 1)'), {
        kind: 'warning',
        id: 1n,
        warning: {
          file: 'Bad.idr',
          span: { start: { line: 3, column: 6 }, end: { line: 3, column: 11 } },
          message: 'M',
          highlighting: [{ start: 36, length: 1, properties: parseSexp('((:decor :bound))') }],
        },
      });
      assert.deepStrictEqual(message('(:warning ("old.ipkg" (1 0) (2 0) "Deprecation warning") 2)'), {
        kind: 'warning',
        id: 2n,
        warning: {
          file: 'old.ipkg',
          span: { start: { line: 1, column: 0 }, end: { line: 2, column: 0 } },
          message: 'Deprecation warning',
          highlighting: [],
        },
      });
    });
  });

  suite('F4 and F5 helpers', () => {
    test('only "Parse error:" and "Unrecognised command:" errors carry the previous id', () => {
      assert.strictEqual(answersWithPreviousId(payload('(:error "Parse error: Couldn\'t parse any alternatives")')), true);
      assert.strictEqual(answersWithPreviousId(payload('(:error "Unrecognised command: ((:version) 2)")')), true);
      assert.strictEqual(answersWithPreviousId(payload('(:error "Undefined name xs. ")')), false);
      assert.strictEqual(answersWithPreviousId(payload('(:ok "Parse error: not an error")')), false);
    });

    test('the end-of-input line is recognised only whole', () => {
      assert.strictEqual(isEndOfInputLine('Alas the file is done, aborting\n'), true);
      assert.strictEqual(isEndOfInputLine('Alas the file is done, aborting\r\n'), true, 'a Windows text-mode stdout (E13)');
      assert.strictEqual(isEndOfInputLine('Alas the file is done, aborting'), false);
      assert.strictEqual(isEndOfInputLine('hi\n'), false);
    });
  });

  suite('request builders (positions are passed through: core/positions.ts owns the ±1)', () => {
    const cases: [Sexp, string][] = [
      [loadFile('/w/a b/é.idr'), '(:load-file "/w/a b/\\233.idr")'],
      [typeOf('xs'), '(:type-of "xs")'],
      [typeOf('xs', { line: 8, column: 5 }), '(:type-of "xs" 8 5)'],
      [docsFor('id'), '(:docs-for "id")'],
      [nameAt('vlen_rhs'), '(:name-at "vlen_rhs")'],
      [metavariables(), '(:metavariables 80)'],
      [caseSplit({ line: 8, column: 0 }, 'xs'), '(:case-split 8 0 "xs")'],
      [addClause(5, 'append'), '(:add-clause 5 "append")'],
      [makeLemma(8, 'vlen_rhs'), '(:make-lemma 8 "vlen_rhs")'],
      [makeCase(8, 'vlen_rhs'), '(:make-case 8 "vlen_rhs")'],
      [makeWith(8, 'vlen_rhs'), '(:make-with 8 "vlen_rhs")'],
      [proofSearch(8, 'vlen_rhs'), '(:proof-search 8 "vlen_rhs" ())'],
      [proofSearch(8, 'h', ['plus', 'Z']), '(:proof-search 8 "h" ("plus" "Z"))'],
      [proofSearchNext(), ':proof-search-next'],
      [generateDef(5, 'append'), '(:generate-def 5 "append")'],
      [generateDefNext(), ':generate-def-next'],
      [intro(8, 'vlen_rhs'), '(:intro 8 "vlen_rhs")'],
      [refine(14, 'g_rhs', 'foo'), '(:refine 14 "g_rhs" "foo")'],
      [interpret(':exec putStrLn "hi"'), '(:interpret ":exec putStrLn \\"hi\\"")'],
      // live 2026-09-27: this request answered "\8594", i.e. the compiler read U+2192.
      [interpret('"→"'), '(:interpret "\\"\\8594\\"")'],
      [missingCases('g'), '(:interpret ":missing g")'],
      [version(), ':version'],
    ];
    for (const [command, text] of cases) {
      test(text, () => {
        assert.strictEqual(serializeSexp(command), text);
      });
    }

    test(':missing takes an identifier or an operator in parentheses only: nothing else reaches the REPL parser (M4 hard requirement)', () => {
      assert.strictEqual(serializeSexp(missingCases('(<&&>)')), '(:interpret ":missing (<&&>)")');
      assert.strictEqual(serializeSexp(missingCases('δ')), '(:interpret ":missing \\948")');
      for (const name of ['both :t id', 'both\n:t id', 'both -- c', 'Edits.both', '<&&>', '(a b)', '()', 'where', '_', '', 'x"', 'x\u2028y', '(<&&>) :exec main', '(<&&>', '(<&&>x', '(<&&>\n']) {
        assert.throws(() => missingCases(name), RangeError, JSON.stringify(name));
      }
    });

    test('the names of the lexer: identifiers above U+00A0 but no invisible characters or spaces; keywords are not names; operator characters', () => {
      for (const name of ["x'", 'x₁', 'α', 'ℕ', '_x', 'vlen_rhs', 'case']) {
        assert.ok(isHoleName(name), name);
      }
      for (const name of ['', '_', '1x', "'x", 'x y', 'x\u00a0y', 'x\u200by', 'x\u202ey', 'x\u3000y', 'x.y', '?x', 'x\ud800']) {
        assert.ok(!isHoleName(name), JSON.stringify(name));
      }
      assert.ok(!isIdentifierName('case') && !isIdentifierName('where') && isIdentifierName('cases'));
      assert.ok(isKeyword('covering') && !isKeyword('Nat'));
      assert.ok(isOperatorInParentheses('(<&&>)') && isOperatorInParentheses('(.)') && isOperatorInParentheses('(::)'));
      assert.ok(!isOperatorInParentheses('<&&>') && !isOperatorInParentheses('()') && !isOperatorInParentheses('(a)') && !isOperatorInParentheses('(< >)'));
      for (const text of ['(<&&>', '(<&&>x', '(<&&>\n', '<&&>)']) {
        assert.ok(!isOperatorInParentheses(text), JSON.stringify(text));
      }
    });
  });

  suite('reply decoders', () => {
    test('decodeText: the string and its highlighting (F30), or the error as an answer', () => {
      assert.deepStrictEqual(decodeText(payload('(:ok "xs : Vect ?_ ?_" ((5 4 ((:decor :type)))))')),
        { kind: 'ok', value: { text: 'xs : Vect ?_ ?_', highlighting: [TYPE_SPAN] } });
      assert.deepStrictEqual(decodeText(payload('(:ok "0")')), { kind: 'ok', value: { text: '0', highlighting: [] } });
      assert.deepStrictEqual(decodeText(payload('(:error "No more results")')),
        { kind: 'error', message: 'No more results', highlighting: [] });
    });

    test('a result of another shape is a ProtocolError that quotes it', () => {
      assertProtocolError(() => decodeText(payload('(:ok ())')));
      assertProtocolError(() => decodeText({ kind: 'highlight-source', highlights: list() }));
      assert.throws(() => decodeText(payload(`(:ok (${'"x" '.repeat(200)}))`)), (e: unknown) => {
        assert.ok(e instanceof IdrisException);
        assert.match(e.message, /^expected \(:ok "TEXT"\), got \("x" "x" .*…$/);
        assert.ok(e.message.length < 300);
        return true;
      });
    });

    test('decodeIntro: one or more candidates (F29)', () => {
      assert.deepStrictEqual(decodeIntro(payload('(:ok ("0" "S ?f_rhs_0"))')), { kind: 'ok', value: ['0', 'S ?f_rhs_0'] });
      assertProtocolError(() => decodeIntro(payload('(:ok ())')));
      assertProtocolError(() => decodeIntro(payload('(:ok "0")')));
      assertProtocolError(() => decodeIntro(payload('(:ok ("0" 1))')));
    });

    test('decodeLemma', () => {
      assert.deepStrictEqual(
        decodeLemma(payload('(:ok (:metavariable-lemma (:replace-metavariable "f_rhs n") (:definition-type "f_rhs : Nat -> Nat")))')),
        { kind: 'ok', value: { application: 'f_rhs n', lemma: 'f_rhs : Nat -> Nat' } });
      assertProtocolError(() => decodeLemma(payload('(:ok (:metavariable-lemma (:definition-type "t") (:replace-metavariable "a")))')));
    });

    test('decodeNameAt: none, or name, file and 0-based span', () => {
      assert.deepStrictEqual(decodeNameAt(payload('(:ok ())')), { kind: 'ok', value: [] });
      const reply = '(:ok (("C.f" (:filename "/w/C.idr") (:start 7 10) (:end 7 19)) '
        + '("D.f" (:filename "(Interactive)") (:start 0 0) (:end 0 1))))';
      assert.deepStrictEqual(decodeNameAt(payload(reply)), {
        kind: 'ok',
        value: [
          { name: 'C.f', file: '/w/C.idr', span: { start: { line: 7, column: 10 }, end: { line: 7, column: 19 } } },
          { name: 'D.f', file: '(Interactive)', span: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } },
        ],
      });
      assertProtocolError(() => decodeNameAt(payload('(:ok (("C.f" (:filename "/w/C.idr") (:end 7 19) (:start 7 10))))')));
    });

    test('decodeMetavariables: names read back from their show, multiplicity and braces from the premise names', () => {
      const reply = '(:ok (("\\"Main.\\\\945\\"" ((" 0  {a}" "Type" ()) (" 1  x" "Nat" ()) ("  xs" "Vect n a" ())) ("Nat" ()))))';
      assert.deepStrictEqual(decodeMetavariables(payload(reply)), {
        kind: 'ok',
        value: [{
          name: 'Main.α',
          type: 'Nat',
          premises: [
            { name: 'a', type: 'Type', multiplicity: 0, implicit: true },
            { name: 'x', type: 'Nat', multiplicity: 1, implicit: false },
            { name: 'xs', type: 'Vect n a', multiplicity: 'unrestricted', implicit: false },
          ],
        }],
      });
      assert.deepStrictEqual(decodeMetavariables(payload('(:ok ())')), { kind: 'ok', value: [] });
    });

    for (const [reply, why] of [
      ['(:ok (("Main.h" () ("Nat" ()))))', 'a name that is not a shown string'],
      ['(:ok (("\\"Main.h\\"" (("x" "Nat" ())) ("Nat" ()))))', 'a premise name without the leading space'],
      ['(:ok (("\\"Main.h\\"" ((" 0  x" "Nat")) ("Nat" ()))))', 'a premise without its metadata slot'],
      ['(:ok (("\\"Main.h\\"" () "Nat")))', 'a conclusion that is not (TYPE HL)'],
    ] as const) {
      test(`decodeMetavariables refuses ${why}`, () => {
        assertProtocolError(() => decodeMetavariables(payload(reply)));
      });
    }

    test('decodeVersion: a release has no tag', () => {
      assert.deepStrictEqual(decodeVersion(payload('(:ok ((0 8 0) ("")))')), { kind: 'ok', value: { major: 0, minor: 8, patch: 0 } });
      assert.deepStrictEqual(decodeVersion(payload('(:ok ((0 8 0) ("1c630e67c")))')),
        { kind: 'ok', value: { major: 0, minor: 8, patch: 0, tag: '1c630e67c' } });
      assertProtocolError(() => decodeVersion(payload('(:ok ((0 8) ("")))')));
    });

    test('decodeMissingCases: the three reports of handleMissing\', several functions joined by newlines', () => {
      const text = 'Part.g:\ng (S _)\ng (S (S _))\nPart.main: Calls non covering function Part.g\n'
        + 'Part.h: Calls non covering functions: Part.g, Part.k\nPart.k: All cases covered\nPart.e:';
      assert.deepStrictEqual(decodeMissingCases(payload(`(:ok ${serializeSexp(str(text))})`)), {
        kind: 'ok',
        value: [
          { kind: 'missing', name: 'Part.g', clauses: ['g (S _)', 'g (S (S _))'] },
          { kind: 'callsNonCovering', name: 'Part.main', functions: ['Part.g'] },
          { kind: 'callsNonCovering', name: 'Part.h', functions: ['Part.g', 'Part.k'] },
          { kind: 'covered', name: 'Part.k' },
          { kind: 'missing', name: 'Part.e', clauses: [] },
        ],
      });
      assertProtocolError(() => decodeMissingCases(payload('(:ok "g (S _)")')));
      // A generated function's name holds spaces [live, idris2 0.8.0: `partial` functions with an incomplete case or with].
      for (const [answer, name, called] of [
        ['CB.f: Calls non covering function CB.case block in f', 'CB.f', 'CB.case block in f'],
        ['MW.f: Calls non covering function MW.with block in f', 'MW.f', 'MW.with block in f'],
      ]) {
        assert.deepStrictEqual(decodeMissingCases(payload(`(:ok ${serializeSexp(str(answer))})`)), {
          kind: 'ok',
          value: [{ kind: 'callsNonCovering', name, functions: [called] }],
        });
      }
      assert.deepStrictEqual(decodeMissingCases(payload('(:error "Undefined name nope.")')),
        { kind: 'error', message: 'Undefined name nope.', highlighting: [] });
    });

    test('decodeMissingCases: linear in the number of clauses (50,000, as a type of that many constructors gives)', () => {
      const clauses = Array.from({ length: 50_000 }, (_, i) => `f C${i + 1}`);
      const reply = payload(`(:ok ${serializeSexp(str(`W.f:\n${clauses.join('\n')}`))})`);
      const started = process.hrtime.bigint();
      const decoded = decodeMissingCases(reply);
      assert.ok(process.hrtime.bigint() - started < 200_000_000n, 'more than 200 ms');
      assert.deepStrictEqual(decoded, { kind: 'ok', value: [{ kind: 'missing', name: 'W.f', clauses }] });
    });

    test('decodeAmbiguity: the indented lines between the header and the blank line (F29)', () => {
      const message = 'Ambiguous elaboration. Possible results:\n    Q.A.foo ?g_rhs_0\n    Q.B.foo ?g_rhs_0\n\n'
        + '(Interactive):1:1--1:4\n 1 | module Q\n     ^^^\n';
      assert.deepStrictEqual(decodeAmbiguity(message), ['Q.A.foo ?g_rhs_0', 'Q.B.foo ?g_rhs_0']);
      assert.strictEqual(decodeAmbiguity('Undefined name foo.'), undefined);
      assert.strictEqual(decodeAmbiguity('Ambiguous elaboration. Possible results:\n\n(Interactive):1:1--1:4'), undefined);
      assert.strictEqual(decodeAmbiguity('Ambiguous elaboration. Possible results:\n  Q.A.foo\n\n'), undefined);
    });

    test('decodeBuildingLine: N/M: Building MODULE (FILE), N padded to the width of M', () => {
      assert.deepStrictEqual(decodeBuildingLine('1/2: Building Foo.A (src/Foo/A.idr)'),
        { index: 1, total: 2, module: 'Foo.A', file: 'src/Foo/A.idr' });
      assert.deepStrictEqual(decodeBuildingLine(' 3/12: Building Foo.Bar (/w/a (b)/Foo/Bar.idr)'),
        { index: 3, total: 12, module: 'Foo.Bar', file: '/w/a (b)/Foo/Bar.idr' });
      assert.strictEqual(decodeBuildingLine('name-at <name> <line> <column>: command not yet implemented. Hopefully soon!'), undefined);
      assert.strictEqual(decodeBuildingLine('1/2: Building Foo.A'), undefined);
    });

    test('decodeSourceHighlights: names carry name, namespace, implicit, key, doc-overview and type', () => {
      const highlights = parseSexp('((((:filename "/w/C.idr") (:start 7 5) (:end 7 7)) ((:name "xs") (:namespace "") '
        + '(:decor :bound) (:implicit :False) (:key "") (:doc-overview "") (:type ""))) '
        + '(((:filename "/w/C.idr") (:start 0 0) (:end 0 6)) ((:decor :keyword))))');
      assert.deepStrictEqual(decodeSourceHighlights(highlights), [
        {
          file: '/w/C.idr', span: { start: { line: 7, column: 5 }, end: { line: 7, column: 7 } }, decor: 'bound',
          name: 'xs', namespace: '', implicit: false, key: '', docOverview: '', type: '',
        },
        { file: '/w/C.idr', span: { start: { line: 0, column: 0 }, end: { line: 0, column: 6 } }, decor: 'keyword' },
      ]);
      assertProtocolError(() => decodeSourceHighlights(parseSexp('((((:filename "/w/C.idr") (:start 0 0) (:end 0 6)) ((:name "x"))))')));
      assertProtocolError(() => decodeSourceHighlights(sym('x')));
    });
  });
});

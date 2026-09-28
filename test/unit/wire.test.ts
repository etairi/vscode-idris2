import * as assert from 'assert';
import type { IncomingFrame } from '../../src/backend/ide/types';
import { createFrameDecoder, encodeFrame, MAX_REQUEST_BYTES } from '../../src/backend/ide/wire';

const utf8 = new TextEncoder();

/** mulberry32: reproducible pseudo-random numbers for the property tests. */
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

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The number of code points of well-formed `text` (without building an array of them). */
function codePoints(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff) {
      n++;
    }
  }
  return n;
}

/** A reply frame as the compiler writes it: the code-point count in lower-case hex, then UTF-8. */
function reply(text: string): Uint8Array {
  return concat(utf8.encode(codePoints(text).toString(16).padStart(6, '0')), utf8.encode(text));
}

function framed(text: string): IncomingFrame {
  return { kind: 'framed', text, byteLength: reply(text).length };
}

function unframed(text: string): IncomingFrame {
  return { kind: 'unframed', text, byteLength: utf8.encode(text).length };
}

/** Feeds `stream` cut at `cuts` (sorted offsets) and ends it; `framesOnly`: as the socket reads it. */
function decode(stream: Uint8Array, cuts: readonly number[] = [], framesOnly = false): IncomingFrame[] {
  const decoder = framesOnly ? createFrameDecoder({ framesOnly: true }) : createFrameDecoder();
  const items: IncomingFrame[] = [];
  let from = 0;
  for (const cut of [...cuts, stream.length]) {
    items.push(...decoder.push(stream.subarray(from, cut)));
    from = cut;
  }
  items.push(...decoder.end());
  return items;
}

suite('backend/ide/wire', () => {
  suite('request frames (F1: the prefix counts UTF-8 bytes including the newline)', () => {
    test('(:version 1) is 00000d', () => {
      const frame = encodeFrame('(:version 1)');
      assert.strictEqual(frame.text, '00000d(:version 1)\n');
      assert.deepStrictEqual(frame.bytes, utf8.encode('00000d(:version 1)\n'));
    });

    test('non-ASCII text counts its bytes: the recorded F1 probe is 00001b, not 25 code points', () => {
      const frame = encodeFrame('((:interpret "\\"→\\"") 5)');
      assert.strictEqual(frame.text, '00001b((:interpret "\\"→\\"") 5)\n');
      assert.strictEqual(frame.bytes.length, 6 + 0x1b);
      assert.deepStrictEqual(frame.bytes.subarray(6), utf8.encode('((:interpret "\\"→\\"") 5)\n'));
    });

    test('the prefix is lower-case hex', () => {
      assert.strictEqual(encodeFrame('x'.repeat(0x2a - 1)).text.slice(0, 6), '00002a');
    });

    test(`the largest request is ${MAX_REQUEST_BYTES} bytes; one more is refused (six digits)`, () => {
      assert.strictEqual(encodeFrame('a'.repeat(MAX_REQUEST_BYTES - 1)).text.slice(0, 6), 'ffffff');
      assert.throws(() => encodeFrame('a'.repeat(MAX_REQUEST_BYTES)), RangeError);
      // A third as many code points, but three bytes each: the limit is on bytes.
      assert.throws(() => encodeFrame('→'.repeat(MAX_REQUEST_BYTES / 3)), RangeError);
    });
  });

  suite('reply frames (F1 addendum: the prefix counts code points)', () => {
    test('one frame', () => {
      assert.deepStrictEqual(decode(reply('(:protocol-version 2 1)\n')), [framed('(:protocol-version 2 1)\n')]);
    });

    test('a reply with → and 𝕟 is cut by code points, not by bytes or UTF-16 units', () => {
      const text = '(:return (:ok "→ 𝕟") 1)\n';
      assert.notStrictEqual(codePoints(text), utf8.encode(text).length);
      assert.notStrictEqual(codePoints(text), text.length);
      const next = '(:return (:ok ()) 2)\n';
      assert.deepStrictEqual(decode(concat(reply(text), reply(next))), [framed(text), framed(next)]);
    });

    test('U+FEFF inside a frame\'s text is kept', () => {
      const text = '(:write-string "﻿" 1)\n';
      assert.deepStrictEqual(decode(reply(text)), [framed(text)]);
    });

    test('a prefix of 7 digits (≥ 0x1000000 code points; leftPad does not truncate) is read whole', function () {
      this.timeout(20000);
      // 0x1000030 code points: the six-digit reading `000030` (output `1`, then a frame of 0x30
      // code points) ends inside the string, not at a \n, so the seven-digit reading is taken.
      const head = '(:return (:ok "';
      const tail = '") 1)\n';
      const big = `${head}${'a'.repeat(0x1000030 - head.length - tail.length)}${tail}`;
      const stream = concat(reply(big), reply('(:return (:ok ()) 2)\n'));
      assert.strictEqual(new TextDecoder().decode(stream.subarray(0, 7)), '1000030');
      const items = decode(stream, [3, 70000, 5000000]);
      assert.strictEqual(items.length, 2);
      assert.strictEqual(items[0].kind, 'framed');
      assert.strictEqual(items[0].byteLength, 7 + 0x1000030);
      assert.ok(items[0].text === big);
      assert.deepStrictEqual(items[1], framed('(:return (:ok ()) 2)\n'));
    });
  });

  suite('unframed bytes (F5, noise)', () => {
    test('program output before a frame (stdio) is unframed up to its newline', () => {
      const frame = '(:return (:ok "") 1)\n';
      assert.deepStrictEqual(decode(concat(utf8.encode('hi\n'), reply(frame))), [unframed('hi\n'), framed(frame)]);
    });

    test('the end-of-input line is unframed', () => {
      assert.deepStrictEqual(decode(utf8.encode('Alas the file is done, aborting\n')),
        [unframed('Alas the file is done, aborting\n')]);
    });

    test('six hex digits not followed by "(" are not a header (output "abcdef" would swallow the stream)', () => {
      const frame = '(:return (:ok "") 1)\n';
      assert.deepStrictEqual(decode(concat(utf8.encode('abcdef\n'), reply(frame))), [unframed('abcdef\n'), framed(frame)]);
      assert.deepStrictEqual(decode(utf8.encode('abcdef12\n')), [unframed('abcdef12\n')]);
    });

    for (const [noise, why] of [
      ['abc\n', 'fewer than six hex digits'],
      ['00001A(x)\n', 'upper-case digits (the compiler writes lower case)'],
      ['000000(:return (:ok ()) 1)\n', 'a length of zero'],
      ['00000a(hello)\n', 'a header without a reply head after its "(" (it would swallow the next reply\'s bytes)'],
      ['000015(:returned 1)\n', 'a head that is not one of the six'],
      ['123456789(x)\n', 'nine digits'],
      ['0000 5(x)\n', 'a space in the header'],
      ['\n', 'an empty line'],
      ['é→\n', 'non-ASCII output'],
    ] as const) {
      test(`${JSON.stringify(noise)} is unframed (${why})`, () => {
        const frame = '(:return (:ok ()) 1)\n';
        assert.deepStrictEqual(decode(concat(utf8.encode(noise), reply(frame))), [unframed(noise), framed(frame)]);
      });
    }
  });

  suite('the end of the stream', () => {
    for (const [tail, kind, why] of [
      ['0000', 'unframed', 'a partial header (it may be output: not known to be a frame)'],
      ['000018', 'unframed', 'a header without its "(" (not known to be a frame)'],
      ['000018(:protocol', 'truncated', 'a header whose reply head is incomplete'],
      ['000018(:protocol-version 2', 'truncated', 'a partial frame'],
      ['000018(:pro\n', 'unframed', 'a line that cannot become a reply head'],
      ['Alas the file is done', 'unframed', 'a line without its newline'],
      ['000014(:write-string "→', 'truncated', 'a partial frame ending in a complete multi-byte character'],
    ] as const) {
      test(`an incomplete tail is one ${kind} item: ${why}`, () => {
        const bytes = utf8.encode(tail);
        assert.deepStrictEqual(decode(bytes), [{ kind, text: tail, byteLength: bytes.length }]);
      });
    }

    test('a tail that ends inside a UTF-8 sequence is decoded with U+FFFD', () => {
      const bytes = concat(utf8.encode('000014(:write-string "a'), utf8.encode('→').subarray(0, 2));
      assert.deepStrictEqual(decode(bytes), [{ kind: 'truncated', text: '000014(:write-string "a�', byteLength: bytes.length }]);
    });

    test('nothing is left after a complete stream, and the decoder starts afresh after end()', () => {
      const decoder = createFrameDecoder();
      assert.deepStrictEqual(decoder.end(), []);
      assert.deepStrictEqual(decoder.push(utf8.encode('0000')), []);
      assert.strictEqual(decoder.end().length, 1);
      assert.deepStrictEqual(decoder.push(reply('(:return (:ok ()) 1)\n')), [framed('(:return (:ok ()) 1)\n')]);
      assert.deepStrictEqual(decoder.end(), []);
    });
  });

  suite('a stream of frames only (the socket, F5)', () => {
    // M2 verification of the third review: with the reply heads required there too, a well-formed
    // reply of a newer compiler became unframed, a protocol error on the socket.
    const HANDSHAKE_TEXT = '(:protocol-version 2 1)\n';
    const PROGRESS = '(:progress "x" 1)\n';
    const RETURN = '(:return (:ok "v1") 1)\n';

    test('a reply with a head this extension does not know is a frame, at every cut', () => {
      const stream = concat(reply(HANDSHAKE_TEXT), reply(PROGRESS), reply(RETURN));
      const expected = [framed(HANDSHAKE_TEXT), framed(PROGRESS), framed(RETURN)];
      for (let cut = 0; cut <= stream.length; cut++) {
        assert.deepStrictEqual(decode(stream, [cut], true), expected, `cut at ${cut}`);
      }
      // Over stdio, where program output can look like anything, it stays output.
      assert.deepStrictEqual(decode(stream), [framed(HANDSHAKE_TEXT), unframed(PROGRESS.replace(/^/, '000012')), framed(RETURN)]);
    });

    test('a seven-digit header is read whole: no output can precede it', () => {
      const text = `(:return (:ok "${'x'.repeat(0x10)}") 1)\n`;
      const seven = concat(utf8.encode(codePoints(text).toString(16).padStart(7, '0')), utf8.encode(text));
      assert.deepStrictEqual(decode(seven, [], true), [{ kind: 'framed', text, byteLength: seven.length }]);
    });

    for (const tail of ['0', '00004', '000040', '000040(', '000040(:wri', 'garbage', '0000000000']) {
      test(`whatever is left at the end is truncated: ${JSON.stringify(tail)}`, () => {
        const bytes = concat(reply(HANDSHAKE_TEXT), utf8.encode(tail));
        assert.deepStrictEqual(decode(bytes, [], true), [framed(HANDSHAKE_TEXT), { kind: 'truncated', text: tail, byteLength: tail.length }]);
      });
    }

    test('what is not a header is still unframed (a protocol error on the socket), up to its newline', () => {
      for (const noise of ['abcdef\n', '000000(x)\n', '123456789(:return x)\n', 'hello\n']) {
        assert.deepStrictEqual(decode(concat(utf8.encode(noise), reply(RETURN)), [], true), [unframed(noise), framed(RETURN)], noise);
      }
    });
  });

  suite('line ends written as \\r\\n (a Windows stdout in text mode, E13 [open])', () => {
    // A text-mode C runtime writes every \n as \r\n, also inside strings, under the same prefix.
    const textMode = (bytes: Uint8Array): Uint8Array => utf8.encode(Buffer.from(bytes).toString('utf8').replace(/\n/g, '\r\n'));
    const texts = [
      '(:protocol-version 2 1)\n',
      '(:warning ("Bad.idr" (3 6) (3 11) "While processing\nMismatch:\n    Nat\n\nBad:4:7--4:12\n" ()) 1)\n',
      '(:write-string "é → 𝕟" 1)\n',
      '(:return (:error "line1\nline2") 1)\n',
    ];
    const lf = concat(reply(texts[0]), utf8.encode('LOG x:1: y\n'), reply(texts[1]), reply(texts[2]), reply(texts[3]));
    const stream = textMode(lf);
    const lines = (text: string): number => text.split('\n').length - 1;
    const expected: IncomingFrame[] = [
      { kind: 'framed', text: texts[0], byteLength: reply(texts[0]).length + 1 },
      { kind: 'unframed', text: 'LOG x:1: y\r\n', byteLength: 12 },
      ...texts.slice(1).map((text): IncomingFrame => ({ kind: 'framed', text, byteLength: reply(text).length + lines(text) })),
    ];

    test('every frame, with the line breaks inside its strings, decodes to the text the compiler wrote', () => {
      assert.deepStrictEqual(decode(stream), expected);
      assert.deepStrictEqual(decode(lf).map((i) => i.text), [texts[0], 'LOG x:1: y\n', ...texts.slice(1)]);
    });

    test('every single cut, including between each \\r and its \\n', () => {
      for (let cut = 0; cut <= stream.length; cut++) {
        assert.deepStrictEqual(decode(stream, [cut]), expected, `cut at ${cut}`);
      }
    });

    test('one byte at a time', () => {
      assert.deepStrictEqual(decode(stream, Array.from({ length: stream.length }, (_, i) => i)), expected);
    });

    test('an original \\r\\n arrives as \\r\\r\\n and counts as two code points; in an LF stream a \\r\\n counts as two', () => {
      const frame = '(:return (:ok "a\r\nb") 2)\n';
      // CRLF: the handshake decides; the frame's own \r stays, the inserted one goes.
      assert.deepStrictEqual(decode(textMode(concat(reply(texts[0]), reply(frame)))).map((i) => i.text), [texts[0], frame]);
      // LF: nothing is dropped, also not a \r\n inside a frame.
      assert.deepStrictEqual(decode(concat(reply(texts[0]), reply(frame))), [framed(texts[0]), framed(frame)]);
    });

    test('the first frame decides: an LF stream is not reread when a later frame ends in \\r', () => {
      const frame = '(:return (:ok ()) 1)\n';
      const endsInCr = concat(reply(frame).subarray(0, -1), utf8.encode('\r\n'));
      assert.deepStrictEqual(decode(concat(reply(texts[0]), endsInCr)), [
        framed(texts[0]),
        { kind: 'framed', text: '(:return (:ok ()) 1)\r', byteLength: reply(frame).length },
        unframed('\n'),
      ]);
    });

    test('a first frame whose last code point is a \\r not followed by \\n keeps it; the stream is LF', () => {
      const cr = '(:protocol-version 2 1)\r';
      assert.deepStrictEqual(decode(concat(reply(cr), reply('(:return "a\r\nb")\n'))), [
        { kind: 'framed', text: cr, byteLength: reply(cr).length },
        framed('(:return "a\r\nb")\n'),
      ]);
      // The stream ends between the \r and the \n of a CRLF handshake: the frame is incomplete.
      const cut = textMode(reply(texts[0])).subarray(0, -1);
      assert.deepStrictEqual(decode(cut), [{ kind: 'truncated', text: Buffer.from(cut).toString('utf8'), byteLength: cut.length }]);
    });
  });

  suite('a reply glued to output without a newline (stdio, F5)', () => {
    const ret = '(:return (:ok "") 1)\n';

    test('the recorded case: `hi` then the :return, as `:exec putStr "hi"` wrote them [live, 0.8.0]', () => {
      const stream = concat(reply('(:protocol-version 2 1)\n'), utf8.encode('hi'), reply(ret));
      assert.strictEqual(Buffer.from(stream).toString('utf8'), '000018(:protocol-version 2 1)\nhi000015(:return (:ok "") 1)\n');
      const expected = [framed('(:protocol-version 2 1)\n'), unframed('hi'), framed(ret)];
      for (let cut = 0; cut <= stream.length; cut++) {
        assert.deepStrictEqual(decode(stream, [cut]), expected, `cut at ${cut}`);
      }
    });

    test('each reply head; output ending in hex digits; output that is itself a partial header', () => {
      for (const text of ['(:output (:ok ()) 1)\n', '(:write-string "x" 1)\n', '(:warning ("A" (0 0) (0 1) "w" ()) 1)\n',
        '(:set-prompt "*A" 1)\n', '(:protocol-version 2 1)\n', ret]) {
        assert.deepStrictEqual(decode(concat(utf8.encode('cafe'), reply(text))), [unframed('cafe'), framed(text)], text);
      }
      assert.deepStrictEqual(decode(concat(utf8.encode('00001'), reply(ret))), [unframed('00001'), framed(ret)]);
    });

    test('protocol text in a log line is not a reply: a request with its header, a reply without one, an unknown head', () => {
      for (const line of [
        'LOG ide-mode.recv:50: Received: 00000d(:version 1)\n',
        'LOG ide-mode.send:20: (:return (:ok ()) 1)\n',
        'x000015(:returned 1)\n',
        'x000000(:return (:ok ()) 1)\n',
        'x00015(:return (:ok ()) 1)\n',
      ]) {
        assert.deepStrictEqual(decode(utf8.encode(line)), [unframed(line)], line);
      }
    });

    test('a head that is still arriving is waited for; a line that cannot be one is not held back', () => {
      const decoder = createFrameDecoder();
      assert.deepStrictEqual(decoder.push(utf8.encode('hi000015(:ret')), []);
      assert.deepStrictEqual(decoder.push(utf8.encode('urn (:ok "") 1)\n')), [unframed('hi'), framed(ret)]);
      assert.deepStrictEqual(decoder.push(utf8.encode('hi000015(:rex\n')), [unframed('hi000015(:rex\n')]);
    });
  });

  suite('output of one or two hex digits runs into the header (stdio, F5)', () => {
    const handshake = '(:protocol-version 2 1)\n';
    const ret = '(:return (:ok "") 1)\n';

    /** Each line of `output` (with its `\n`), then the rest, as unframed items. */
    const outputItems = (output: string): IncomingFrame[] => output.split(/(?<=\n)/).filter((part) => part !== '').map(unframed);

    test('the recorded case: `7` then the :return, as `:exec putStr "7"` wrote them [live, 0.8.0, transcript exec-stdio-putstr-digit]', () => {
      const stream = utf8.encode('000018(:protocol-version 2 1)\n7000015(:return (:ok "") 1)\n');
      assert.deepStrictEqual(stream, concat(reply(handshake), utf8.encode('7'), reply(ret)));
      const expected = [framed(handshake), unframed('7'), framed(ret)];
      for (let cut = 0; cut <= stream.length; cut++) {
        assert.deepStrictEqual(decode(stream, [cut]), expected, `cut at ${cut}`);
      }
      assert.deepStrictEqual(decode(stream, Array.from({ length: stream.length }, (_, i) => i)), expected, 'one byte at a time');
    });

    for (const output of ['0', '7', '00', '42', 'ab', 'a0', '10', 'a\n7', '7\n0', 'x7', 'abc', '0000', '00000a(hello)\n']) {
      test(`output ${JSON.stringify(output)} before a reply keeps both, at every cut`, () => {
        const stream = concat(reply(handshake), utf8.encode(output), reply(ret));
        const expected = [framed(handshake), ...outputItems(output), framed(ret)];
        for (let cut = 0; cut <= stream.length; cut++) {
          assert.deepStrictEqual(decode(stream, [cut]), expected, `cut at ${cut}`);
        }
      });
    }

    test('a stream that ends after output run into a partial frame is one truncated item', () => {
      const tail = '7000015(:return (:ok';
      assert.deepStrictEqual(decode(utf8.encode(tail)), [{ kind: 'truncated', text: tail, byteLength: tail.length }]);
    });

    test('property: 500 streams of short hex output, each followed by a reply, randomly chunked (seed 5)', () => {
      const next = prng(5);
      const digits = '0123456789abcdef';
      const heads = ['(:return (:ok "") ', '(:output (:ok ()) ', '(:write-string "é" ', '(:set-prompt "*A" '];
      for (let run = 0; run < 500; run++) {
        const parts: Uint8Array[] = [reply(handshake)];
        const items: IncomingFrame[] = [framed(handshake)];
        for (let k = 0; k < 1 + Math.floor(next() * 6); k++) {
          let output = '';
          for (let i = Math.floor(next() * 5); i > 0; i--) {
            output += next() < 0.1 ? '\n' : digits[Math.floor(next() * digits.length)];
          }
          const text = `${heads[Math.floor(next() * heads.length)]}${1 + Math.floor(next() * 99)})\n`;
          parts.push(utf8.encode(output), reply(text));
          items.push(...outputItems(output), framed(text));
        }
        const bytes = concat(...parts);
        const cuts: number[] = [];
        for (let at = 0; at < bytes.length; at += 1 + Math.floor(next() * 12)) {
          cuts.push(at);
        }
        assert.deepStrictEqual(decode(bytes, cuts), items, `run ${run}`);
      }
    });
  });

  suite('chunking (chunks may split anywhere)', () => {
    const texts = ['(:protocol-version 2 1)\n', '(:write-string "é → 𝕟" 1)\n', '(:return (:ok ()) 1)\n'];
    const stream = concat(reply(texts[0]), utf8.encode('hi\n'), reply(texts[1]), utf8.encode('abcdef\n'),
      reply(texts[2]), utf8.encode('Alas the file is done, aborting\n'));
    const expected = [framed(texts[0]), unframed('hi\n'), framed(texts[1]), unframed('abcdef\n'), framed(texts[2]),
      unframed('Alas the file is done, aborting\n')];

    test('every single cut, including inside headers and UTF-8 sequences', () => {
      for (let cut = 0; cut <= stream.length; cut++) {
        assert.deepStrictEqual(decode(stream, [cut]), expected, `cut at ${cut}`);
      }
    });

    test('every pair of cuts', () => {
      for (let a = 0; a <= stream.length; a++) {
        for (let b = a; b <= stream.length; b++) {
          assert.deepStrictEqual(decode(stream, [a, b]), expected, `cuts at ${a}, ${b}`);
        }
      }
    });

    test('one byte at a time', () => {
      assert.deepStrictEqual(decode(stream, Array.from({ length: stream.length }, (_, i) => i)), expected);
    });

    test('property: 300 random streams of frames and noise, randomly chunked, decode to their items (seed 7)', () => {
      const next = prng(7);
      const alphabet = ['a', ' ', '"', '\\', '\n', 'é', '→', '𝕟', '(', ')', '0', 'f'];
      for (let run = 0; run < 300; run++) {
        const parts: Uint8Array[] = [];
        const items: IncomingFrame[] = [];
        const count = 1 + Math.floor(next() * 12);
        for (let k = 0; k < count; k++) {
          let body = '';
          const length = Math.floor(next() * (next() < 0.1 ? 5000 : 60));
          for (let i = 0; i < length; i++) {
            body += alphabet[Math.floor(next() * alphabet.length)];
          }
          if (next() < 0.8) {
            const text = `(:write-string ${body})\n`;
            parts.push(reply(text));
            items.push(framed(text));
          } else {
            // No line can be a header: the alphabet has no ":", which every reply head starts with.
            const line = `${body.replace(/\n/g, '')}\n`;
            parts.push(utf8.encode(line));
            items.push(unframed(line));
          }
        }
        const bytes = concat(...parts);
        const cuts: number[] = [];
        for (let at = 0; at < bytes.length; at += 1 + Math.floor(next() * (next() < 0.5 ? 8 : 3000))) {
          cuts.push(at);
        }
        assert.deepStrictEqual(decode(bytes, cuts), items, `run ${run}`);
        assert.strictEqual(items.reduce((n, item) => n + item.byteLength, 0), bytes.length);
      }
    });

    test('a 1 MiB frame arriving in 1 KiB chunks', () => {
      const text = `(:return (:ok "${'→'.repeat(1 << 18)}${'x'.repeat(1 << 18)}") 1)\n`;
      const bytes = reply(text);
      const cuts = Array.from({ length: Math.floor(bytes.length / 1024) }, (_, i) => (i + 1) * 1024);
      assert.deepStrictEqual(decode(bytes, cuts), [framed(text)]);
    });
  });

  suite('malformed UTF-8 is counted as the WHATWG decoder decodes it', () => {
    test('property: a frame of random bytes keeps its boundary, and its text is TextDecoder\'s (seed 11)', () => {
      const next = prng(11);
      const reference = new TextDecoder('utf-8', { ignoreBOM: true });
      const special = [0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff, 0x9f, 0xa0, 0x8f, 0x90];
      const sentinel = '(:return (:ok ()) 9)\n';
      const head = utf8.encode('(:write-string ');
      for (let run = 0; run < 3000; run++) {
        const payload = new Uint8Array(head.length + Math.floor(next() * 12));
        payload.set(head);
        for (let i = head.length; i < payload.length; i++) {
          payload[i] = next() < 0.6 ? special[Math.floor(next() * special.length)] : Math.floor(next() * 256);
        }
        const text = reference.decode(payload);
        const header = utf8.encode(Array.from(text).length.toString(16).padStart(6, '0'));
        const stream = concat(header, payload, reply(sentinel));
        const expected = [{ kind: 'framed', text, byteLength: header.length + payload.length }, framed(sentinel)];
        assert.deepStrictEqual(decode(stream), expected, `run ${run}: ${Array.from(payload).join(' ')}`);
        assert.deepStrictEqual(decode(stream, [7, 9]), expected, `run ${run}, chunked`);
      }
    });
  });
});

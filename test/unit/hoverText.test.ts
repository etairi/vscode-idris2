// features/intelligence/text.ts: the reading of compiler text — the parts of a name, the
// declaration each block of a `:docs-for` reply documents, its overview — on replies recorded from
// idris2 0.8.0. How the text is shown is test/unit/untrustedText.test.ts.
import * as assert from 'assert';
import {
  declaredName,
  declaredNames,
  docBlocks,
  docOverview,
  nameRoot,
  sliceRichText,
  splitName,
} from '../../src/features/intelligence/text';
import { recordedReply } from './support/intelligence';

suite('features/intelligence/text', () => {
  suite('names', () => {
    test('declaredName reads the name of a declaration line, with multiplicity and kind', () => {
      assert.strictEqual(declaredName('Foo.Shapes.area : Shape -> Double'), 'Foo.Shapes.area');
      assert.strictEqual(declaredName('data Foo.Shapes.Shape : Type'), 'Foo.Shapes.Shape');
      assert.strictEqual(declaredName('interface Foo.Shapes.Measured : Type -> Type'), 'Foo.Shapes.Measured');
      assert.strictEqual(declaredName('1 vlen_rhs : (0 a : Type) -> Nat'), 'vlen_rhs');
      assert.strictEqual(declaredName('Prelude.(::) : a -> List a -> List a'), 'Prelude.(::)');
      assert.strictEqual(declaredName('x₁ : ℕ'), 'x₁');
      for (const line of [' 0 a : Type', '   xs : Vect n a', '------------------------------', '  Visibility: export', 'Undefined name nope. ']) {
        assert.strictEqual(declaredName(line), undefined, line);
      }
    });

    test("declaredNames of a hole's goal is the goal's name only (premises are indented) [live]", () => {
      const goal = recordedReply('clean-queries', '(:type-of "vlen_rhs" 8 11)').text;
      assert.deepStrictEqual(declaredNames(goal), ['vlen_rhs']);
      const overloaded = recordedReply('clean-queries', '(:type-of "index")').text;
      assert.deepStrictEqual(declaredNames(overloaded), ['Data.List.index', 'Data.Vect.index']);
    });

    test('splitName separates a namespace of identifiers from the root; an operator keeps its dots', () => {
      assert.deepStrictEqual(splitName('Foo.Shapes.area'), { namespace: 'Foo.Shapes', root: 'area' });
      assert.deepStrictEqual(splitName('Prelude.(::)'), { namespace: 'Prelude', root: '::' });
      assert.deepStrictEqual(splitName('Prelude.Types.Stream.(::)'), { namespace: 'Prelude.Types.Stream', root: '::' });
      assert.deepStrictEqual(splitName('(|+|)'), { namespace: undefined, root: '|+|' });
      assert.deepStrictEqual(splitName('<.>'), { namespace: undefined, root: '<.>' });
      assert.deepStrictEqual(splitName('Prelude.(.)'), { namespace: 'Prelude', root: '.' });
      assert.deepStrictEqual(splitName('x₁'), { namespace: undefined, root: 'x₁' });
      assert.strictEqual(nameRoot('Unicode.α'), 'α');
    });
  });

  suite(':docs-for replies [live, transcripts shapes-lookups, clean-queries]', () => {
    test('one block per definition of an overloaded name', () => {
      const docs = recordedReply('clean-queries', '(:docs-for "::")').text;
      const blocks = docBlocks(docs);
      assert.deepStrictEqual(
        blocks.map((b) => b.name),
        ['Prelude.(::)', 'Prelude.Stream.(::)', 'Data.Vect.(::)'],
      );
      assert.ok(docs.slice(blocks[1].start, blocks[1].end).startsWith('Prelude.Stream.(::) :'));
      assert.ok(!docs.slice(blocks[0].start, blocks[0].end).endsWith('\n'));
      assert.strictEqual(blocks[2].end, docs.length);
    });

    test('the overview is the first paragraph of the docstring, without the sections below it', () => {
      const overview = (request: string): string | undefined => {
        const docs = recordedReply(request.startsWith('(:docs-for "V') ? 'clean-queries' : 'shapes-lookups', request).text;
        return docOverview(docs, docBlocks(docs)[0]);
      };
      assert.strictEqual(overview('(:docs-for "area")'), 'The area of a shape.');
      assert.strictEqual(overview('(:docs-for "Shape")'), 'A plane figure.');
      assert.strictEqual(overview('(:docs-for "Measured")'), 'Things whose boundary has a length.');
      assert.strictEqual(overview('(:docs-for "Circle")'), 'A circle, by its radius.');
      assert.strictEqual(overview('(:docs-for "|+|")'), 'The areas of two shapes, added.');
      assert.strictEqual(overview('(:docs-for "scale")'), undefined, 'no docstring: only Visibility follows');
      assert.strictEqual(overview('(:docs-for "pi")'), undefined, 'only Totality and Visibility follow');
      assert.strictEqual(overview('(:docs-for "Vect")'), undefined, 'a data type without docstring: Totality first');
    });

    test('a paragraph over several lines is joined; a blank line ends it; a deprecated block keeps its mark', () => {
      const docs = [
        '=DEPRECATED=',
        'M.f : Nat',
        '  First line',
        '  continues here.',
        '',
        '  Second paragraph.',
        '  Visibility: export',
        'M.g : Nat',
        '  Totality: total',
      ].join('\n');
      const blocks = docBlocks(docs);
      assert.deepStrictEqual(
        blocks.map((b) => [b.name, b.start]),
        [
          ['M.f', 0],
          ['M.g', docs.indexOf('M.g')],
        ],
      );
      assert.strictEqual(docOverview(docs, blocks[0]), 'First line continues here.');
      assert.strictEqual(docOverview(docs, blocks[1]), undefined);
    });
  });

  test('sliceRichText cuts and moves the spans', () => {
    const rich = { text: 'abcdefgh', spans: [{ start: 1, length: 3, decor: 'type' as const }, { start: 6, length: 2 }] };
    assert.deepStrictEqual(sliceRichText(rich, 2, 7), {
      text: 'cdefg',
      spans: [
        { start: 0, length: 2, decor: 'type' },
        { start: 4, length: 1 },
      ],
    });
    assert.deepStrictEqual(sliceRichText(rich, 4, 6).spans, []);
  });
});

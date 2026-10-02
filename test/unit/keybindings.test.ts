// The keybindings of package.json against the code (ARCHITECTURE §10: "each milestone contributes
// only the bindings of commands it registers" — a binding to an unregistered command shows
// "command … not found"). test/unit/manifest.test.ts pins the bindings themselves (M3's letters t, d,
// e and M4's c a l w m s n g i r [ ] under the schemes auto, chords and prefix, none under `none`),
// test/unit/showKeybindings.test.ts the document that lists them; this test reads the syntax tree of
// src/ and resolves, with the type checker, the command id of every `registerCommand(…)` call, so
// that a binding whose command no code registers fails here, before an integration run.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { repoRoot } from '../fake-tools/paths';

interface Manifest {
  contributes: {
    commands: { command: string }[];
    keybindings: { command: string; key: string; when?: string }[];
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as Manifest;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/**
 * The command ids src/ registers: the first argument of every call of a method named
 * `registerCommand`, when its type is a string literal (a literal, or a `const` initialised with
 * one), or a union of string literals — each member counted — for a call in a loop over the keys
 * of a constant whose type lists them all (`unions` names the files of such calls, which the test
 * pins, so that a new one is looked at); `unresolved` lists the calls whose id is neither.
 */
function registeredCommands(): { ids: Set<string>; unions: string[]; unresolved: string[] } {
  const files = sourceFiles(path.join(repoRoot(), 'src'));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const ids = new Set<string>();
  const unions: string[] = [];
  const unresolved: string[] = [];
  for (const file of files) {
    const source = program.getSourceFile(file) ?? assert.fail(`${file} is not in the program`);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'registerCommand' &&
        node.arguments.length > 0
      ) {
        const type = checker.getTypeAtLocation(node.arguments[0]);
        if (type.isStringLiteral()) {
          ids.add(type.value);
        } else if (type.isUnion() && type.types.every((t) => t.isStringLiteral())) {
          for (const member of type.types) {
            ids.add((member as ts.StringLiteralType).value);
          }
          unions.push(path.relative(repoRoot(), file));
        } else {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          unresolved.push(`${path.relative(repoRoot(), file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { ids, unions, unresolved };
}

suite('keybindings against the code (ARCHITECTURE §10)', () => {
  const registered = registeredCommands();

  test('every registerCommand call of src/ names its command by a literal id, so that this test can read it', () => {
    assert.deepStrictEqual(registered.unresolved, []);
    assert.ok(registered.ids.size >= 10, [...registered.ids].join(', '));
    // The one loop: the editing commands, over the keys of `EDITING_COMMAND_KINDS`, whose type
    // `EditingCommandKinds` makes every command id a key (features/editing/messages.ts).
    assert.deepStrictEqual(registered.unions, [path.join('src', 'features', 'editing', 'register.ts')]);
  });

  test('every command a keybinding binds is registered by src/', () => {
    const bound = [...new Set(manifest.contributes.keybindings.map((k) => k.command))].sort();
    assert.deepStrictEqual(bound, [
      // M3
      'idris2.docsAtCursor',
      'idris2.evaluateSelection',
      'idris2.typeAtCursor',
      // M4
      'idris2.addClause',
      'idris2.caseSplit',
      'idris2.generateDefinition',
      'idris2.intro',
      'idris2.makeCase',
      'idris2.makeLemma',
      'idris2.makeWith',
      'idris2.nextHole',
      'idris2.nextResult',
      'idris2.previousHole',
      'idris2.proofSearch',
      'idris2.refineHole',
    ].sort());
    assert.deepStrictEqual(
      bound.filter((command) => !registered.ids.has(command)),
      [],
    );
  });

  test('every command package.json contributes is registered by src/ (some registered ones are internal: the Allow… of a notice)', () => {
    const contributed = manifest.contributes.commands.map((c) => c.command);
    assert.deepStrictEqual(
      contributed.filter((command) => !registered.ids.has(command)),
      [],
    );
  });
});

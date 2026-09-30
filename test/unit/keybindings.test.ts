// The keybindings of package.json against the code (ARCHITECTURE §10: "each milestone contributes
// only the bindings of commands it registers" — a binding to an unregistered command shows
// "command … not found"). test/unit/manifest.test.ts pins the bindings themselves (the letters t, d,
// e of M3 under the schemes auto, chords and prefix, none under `none`); this test reads the syntax
// tree of src/ and resolves, with the type checker, the command id of every `registerCommand(…)`
// call, so that a binding whose command no code registers fails here, before an integration run.
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
 * one); `unresolved` lists the calls whose id is not a literal type.
 */
function registeredCommands(): { ids: Set<string>; unresolved: string[] } {
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
        } else {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          unresolved.push(`${path.relative(repoRoot(), file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { ids, unresolved };
}

suite('keybindings against the code (ARCHITECTURE §10)', () => {
  const registered = registeredCommands();

  test('every registerCommand call of src/ names its command by a literal id, so that this test can read it', () => {
    assert.deepStrictEqual(registered.unresolved, []);
    assert.ok(registered.ids.size >= 10, [...registered.ids].join(', '));
  });

  test('every command a keybinding binds is registered by src/', () => {
    const bound = [...new Set(manifest.contributes.keybindings.map((k) => k.command))].sort();
    assert.deepStrictEqual(bound, ['idris2.docsAtCursor', 'idris2.evaluateSelection', 'idris2.typeAtCursor']);
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

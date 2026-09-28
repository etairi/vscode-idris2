// core/notificationText.ts: no text in this extension's notifications can become a VS Code link.
// Found by the M2 third review: a folder named `[Don't Allow](command:…)` put a working command link,
// labelled like a button, into the consent question.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { MAX_SHOWN_PATH, plainText, shownPath } from '../../src/core/notificationText';
import { consentQuestion } from '../../src/features/consent/register';
import { repoRoot } from '../fake-tools/paths';

/**
 * The links VS Code 1.139.1 makes of a notification's message: `parseNotificationMessage` cuts it
 * at 1,000 characters and turns each line break into a space, then `parseLinkedText` applies this
 * pattern, copied from its workbench bundle (`out/vs/workbench/workbench.desktop.main.js`).
 */
function links(message: string): string[] {
  const pattern = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^\)\s]+)(?: (["'])(.+?)(\3))?\)/gi;
  return [...shown(message).matchAll(pattern)].map((m) => m[2]);
}

/** The text VS Code 1.139.1 shows of a notification's message (`parseNotificationMessage`, as above). */
function shown(message: string): string {
  const cut = message.length > 1000 ? `${message.substring(0, 1000)}...` : message;
  return cut.replace(/(\r\n|\n|\r)/gm, ' ').trim();
}

const WARNING = 'Starting the compiler in a folder can run code placed in it';

/**
 * Real paths that hold a link: a POSIX folder name may hold anything but `/` and NUL, and a real
 * path has no `//`, so an `https://` link cannot come this way (it can in compiler output).
 */
const HOSTILE = [
  "/tmp/dl/[Don't Allow](command:workbench.action.terminal.sendSequence?%7B%22text%22%3A%22echo%20pwned%5Cr%22%7D)",
  '/tmp/[Allow](file:/etc)',
  '/tmp/[Always Allow for This Folder](command:x)',
  "/tmp/[x](command:y 'a title')",
];

/**
 * The texts VS Code 1.139.1 parses for `[label](command:…)` links, found in a syntax tree, that are
 * neither a literal nor wholly a `plainText(…)` call: the first argument of
 * `show{Information,Warning,Error}Message`; `prompt`, `validationMessage` and what `validateInput`
 * returns (an input box's, and a QuickPick's `prompt`, also `showQuickPick`'s option: the QuickPick
 * shows it in place of a validation message, `set prompt(e){this.noValidationMessage=e…}`, rendered
 * with links [src: the 1.139.1 workbench bundle]); `title` and `message` of a progress
 * (`withProgress`, `report`); and the language status item's `detail`. Identifiers are resolved
 * with the type checker, by symbol: one counts when it names a `const` (not a `let`, a parameter or
 * an import) initialised with such a text, and `plainText` must be the one of
 * `core/notificationText.ts`. So that no text reaches VS Code another way, these are problems too:
 * a use of `show…Message`, `showInputBox`, `createInputBox`, `showQuickPick`, `createQuickPick`
 * or `withProgress` other than a direct call `x.name(…)` (element access, a destructured name,
 * `.call`, passed as a value), and of `report` other than a direct call `x.report(…)` (read as a
 * property, destructured or by element access; a variable of that name is another thing); options
 * of `showInputBox`, `showQuickPick` (its second argument), `withProgress` and `report` that are
 * not an object literal, or hold a spread or a method; `detail`, `prompt` or `validationMessage`
 * set by anything but `=`, `??=`, `||=` or `&&=` on a property (`+=` appends to what is there; an
 * element access `x['detail']` counts as the property), in an object literal given to
 * `Object.assign`, through `Object.assign` from anything but object literals without a spread, or
 * with `Object.defineProperty`, `Object.defineProperties`, `Reflect.set` or
 * `Reflect.defineProperty` (a key that is not a literal counts as one of them). (*M2 second
 * verification of the third review*: the scan resolved names file-wide without scope or
 * reassignment, and looked only at literal options and `x.name(…)` calls. *Verification after
 * Q20–Q22*: it missed `showQuickPick`'s prompt, compound and element-access assignments,
 * `Object.assign` from a variable or a spread, `Object.defineProperty`, and `report` destructured
 * or called through `.call`.) Type positions are skipped. `counts` is told how many texts it saw.
 */
function unsafeTexts(source: ts.SourceFile, checker: ts.TypeChecker, counts: { messages: number; texts: number }): string[] {
  const problems: string[] = [];
  const where = (node: ts.Node): string => `line ${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const declarationOf = (identifier: ts.Identifier): ts.Declaration | undefined => checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  /** Whether `call` calls the `plainText` of `core/notificationText.ts` (unresolved only in a test's snippet). */
  const isPlainTextCall = (call: ts.Expression): boolean => {
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'plainText') {
      return false;
    }
    const declaration = declarationOf(call.expression);
    if (declaration === undefined) {
      return true;
    }
    if (ts.isImportSpecifier(declaration)) {
      const from = declaration.parent.parent.parent.moduleSpecifier;
      return (declaration.propertyName ?? declaration.name).text === 'plainText' && ts.isStringLiteral(from) && /(^|\/)core\/notificationText$/.test(from.text);
    }
    return ts.isFunctionDeclaration(declaration) && /core[\\/]notificationText\.ts$/.test(declaration.getSourceFile().fileName);
  };
  const plain = (expression: ts.Expression | undefined, seen = new Set<ts.Node>()): boolean => {
    if (expression === undefined) {
      return true;
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      return plain(expression.expression, seen);
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || expression.kind === ts.SyntaxKind.NullKeyword) {
      return true;
    }
    if (ts.isIdentifier(expression)) {
      if (expression.text === 'undefined') {
        return true;
      }
      const declaration = declarationOf(expression);
      if (
        declaration === undefined ||
        seen.has(declaration) ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        (declaration.parent.flags & ts.NodeFlags.Const) === 0
      ) {
        return false;
      }
      return plain(declaration.initializer, new Set([...seen, declaration]));
    }
    if (ts.isConditionalExpression(expression)) {
      return plain(expression.whenTrue, seen) && plain(expression.whenFalse, seen);
    }
    return isPlainTextCall(expression);
  };
  /** What a function returns, every `return` of a block body included. */
  const returned = (fn: ts.Expression): (ts.Expression | undefined)[] => {
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
      return [fn];
    }
    if (!ts.isBlock(fn.body)) {
      return [fn.body];
    }
    const results: (ts.Expression | undefined)[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) {
        results.push(node.expression);
      } else if (!ts.isFunctionLike(node)) {
        ts.forEachChild(node, visit);
      }
    };
    visit(fn.body);
    return results;
  };
  const check = (what: string, node: ts.Node, expression: ts.Expression | undefined): void => {
    counts.texts++;
    if (!plain(expression)) {
      problems.push(`${where(node)}: ${what} is not a literal or plainText(…)`);
    }
  };
  const SINKS = /^(show(Information|Warning|Error)Message|showInputBox|createInputBox|showQuickPick|createQuickPick|withProgress)$/;
  const TEXT_KEYS = ['prompt', 'validationMessage', 'detail'];
  /** Which argument holds the options of each call whose options are checked, and whether it may be left out. */
  const OPTIONS: Record<string, { readonly index: number; readonly optional: boolean }> = {
    showInputBox: { index: 0, optional: true },
    showQuickPick: { index: 1, optional: true },
    withProgress: { index: 0, optional: false },
    report: { index: 0, optional: false },
  };
  /** The text of the options each such call parses for links. */
  const OPTION_TEXTS: Record<string, readonly string[]> = {
    showInputBox: ['prompt', 'validateInput'],
    showQuickPick: ['prompt'],
    withProgress: ['title'],
    report: ['message'],
  };
  /** The name of a property: an identifier, a string literal, or a computed string literal; else `undefined`. */
  const keyOf = (name: ts.PropertyName | undefined): string | undefined => {
    if (name === undefined) {
      return undefined;
    }
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
  };
  /** `x.name(…)`: `node` (a property access) is the callee of a call. */
  const directlyCalled = (node: ts.PropertyAccessExpression): boolean => ts.isCallExpression(node.parent) && node.parent.expression === node;
  /** `Object.name` or `Reflect.name`, as the callee of `call`. */
  const calls = (call: ts.CallExpression, object: string, name: string): boolean =>
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === name &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === object;
  /** `x.key` or `x['key']` with `key` one of `TEXT_KEYS`: that key; else `undefined`. */
  const textTarget = (target: ts.Expression): string | undefined => {
    const key = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)
        ? target.argumentExpression.text
        : undefined;
    return key !== undefined && TEXT_KEYS.includes(key) ? key : undefined;
  };
  /**
   * The text keys a destructuring pattern (`[a.detail] = …`, `({ d: a.detail } = …)`, a `for … of`
   * or `for … in` target) assigns to, nested patterns and defaults included (M2 verification of the
   * Q20–Q22 fixes: the scan looked only at `x.key = …`).
   */
  const patternTargets = (target: ts.Expression): string[] => {
    if (ts.isParenthesizedExpression(target)) {
      return patternTargets(target.expression);
    }
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return patternTargets(target.left); // a default
    }
    if (ts.isSpreadElement(target)) {
      return patternTargets(target.expression);
    }
    if (ts.isArrayLiteralExpression(target)) {
      return target.elements.flatMap(patternTargets);
    }
    if (ts.isObjectLiteralExpression(target)) {
      return target.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) ? patternTargets(property.initializer) : ts.isSpreadAssignment(property) ? patternTargets(property.expression) : [],
      );
    }
    const key = textTarget(target);
    return key === undefined ? [] : [key];
  };
  /** A property key argument that is one of `TEXT_KEYS`, or not a literal (it could be one). */
  const textKey = (key: ts.Expression | undefined): boolean => key === undefined || !ts.isStringLiteralLike(key) || TEXT_KEYS.includes(key.text);
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node)) {
      return;
    }
    if (ts.isPropertyAccessExpression(node) && (SINKS.test(node.name.text) || node.name.text === 'report') && !directlyCalled(node)) {
      problems.push(`${where(node)}: ${node.name.text} is used other than in a direct call`);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && keyOf(node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined)) === 'report') {
      problems.push(`${where(node)}: report is used other than in a direct call`);
    }
    if (ts.isIdentifier(node) && SINKS.test(node.text)) {
      const parent = node.parent;
      const named =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node);
      if (!named) {
        problems.push(`${where(node)}: ${node.text} is used other than in a direct call`);
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      (SINKS.test(node.argumentExpression.text) || node.argumentExpression.text === 'report')
    ) {
      problems.push(`${where(node)}: ${node.argumentExpression.text} is used other than in a direct call`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (/^show(Information|Warning|Error)Message$/.test(name)) {
        counts.messages++;
        const [first] = node.arguments;
        if (first === undefined || !isPlainTextCall(first)) {
          problems.push(`${where(node)}: the message of ${name} is not wholly plainText(…)`);
        }
      }
      const shape = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined;
      const options = shape === undefined ? undefined : node.arguments[shape.index];
      if (shape !== undefined && (options === undefined || !ts.isObjectLiteralExpression(options))) {
        if (options !== undefined || !shape.optional) {
          problems.push(`${where(node)}: the options of ${name} are not an object literal`);
        }
      } else if (shape !== undefined && options !== undefined && ts.isObjectLiteralExpression(options)) {
        const texts = OPTION_TEXTS[name];
        for (const property of options.properties) {
          const key = ts.isPropertyAssignment(property) ? keyOf(property.name) : undefined;
          if (!ts.isPropertyAssignment(property) || key === undefined) {
            if (!ts.isShorthandPropertyAssignment(property)) {
              problems.push(`${where(property)}: ${name}'s options hold a spread, a method or a computed key`);
            } else if (texts.includes(property.name.text)) {
              check(`${name}'s ${property.name.text}`, property, property.name);
            }
            continue;
          }
          if (key === 'validateInput' && texts.includes(key)) {
            for (const result of returned(property.initializer)) {
              check('what validateInput returns', property, result);
            }
          } else if (texts.includes(key)) {
            check(`${name}'s ${key}`, property, property.initializer);
          }
        }
      }
      if (calls(node, 'Object', 'assign')) {
        node.arguments.forEach((argument, index) => {
          if (!ts.isObjectLiteralExpression(argument)) {
            if (index > 0) {
              problems.push(`${where(argument)}: Object.assign copies from something other than an object literal`);
            }
            return;
          }
          for (const property of argument.properties) {
            if (ts.isSpreadAssignment(property)) {
              problems.push(`${where(property)}: Object.assign copies a spread`);
            } else if (TEXT_KEYS.includes(keyOf(property.name) ?? '') || (property.name !== undefined && ts.isComputedPropertyName(property.name) && keyOf(property.name) === undefined)) {
              problems.push(`${where(property)}: a text key is set through Object.assign, not by a direct assignment`);
            }
          }
        });
      }
      if (calls(node, 'Object', 'defineProperty') || calls(node, 'Reflect', 'defineProperty') || calls(node, 'Reflect', 'set')) {
        if (textKey(node.arguments[1])) {
          problems.push(`${where(node)}: a text key (or a key that is not a literal) is set through ${node.expression.getText()}`);
        }
      }
      if (calls(node, 'Object', 'defineProperties')) {
        const map = node.arguments[1];
        if (
          map === undefined ||
          !ts.isObjectLiteralExpression(map) ||
          map.properties.some((property) => ts.isSpreadAssignment(property) || keyOf(property.name) === undefined || TEXT_KEYS.includes(keyOf(property.name) ?? ''))
        ) {
          problems.push(`${where(node)}: a text key (or one that is not a literal) is set through Object.defineProperties`);
        }
      }
    }
    const destructured =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))
        ? node.left
        : (ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer)
          ? node.initializer
          : undefined;
    if (destructured !== undefined) {
      for (const key of patternTargets(destructured)) {
        problems.push(`${where(destructured)}: .${key} is set by destructuring or as a loop's target, not by a direct assignment`);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const key = textTarget(node.left);
      if (key !== undefined) {
        const operator = node.operatorToken.kind;
        if (
          operator === ts.SyntaxKind.EqualsToken ||
          operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          operator === ts.SyntaxKind.BarBarEqualsToken ||
          operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        ) {
          check(`the assignment to .${key}`, node, node.right);
        } else {
          problems.push(`${where(node)}: .${key} is set with ${node.operatorToken.getText()}, which keeps what was there`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/**
 * A program of `files` (path → text) for the scan: no library and no module resolution (the scan
 * needs only the declarations within the files, `unsafeTexts`), so that it is quick.
 */
function scanProgram(files: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (name, languageVersion) => {
    const text = files.get(name);
    return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true);
  };
  host.fileExists = (name) => files.has(name);
  host.readFile = (name) => files.get(name);
  return ts.createProgram([...files.keys()], options, host);
}

/** The problems `unsafeTexts` finds in the one file `text`. */
function scanText(text: string): string[] {
  const program = scanProgram(new Map([['/x.ts', text]]));
  return unsafeTexts(program.getSourceFile('/x.ts') ?? assert.fail('no source'), program.getTypeChecker(), { messages: 0, texts: 0 });
}

suite('core/notificationText', () => {
  test('the copied pattern finds the links in the hostile names (the test would notice a link)', () => {
    for (const dir of HOSTILE) {
      assert.strictEqual(links(consentQuestion(dir, undefined)).length, 1, dir);
    }
  });

  test('the consent question about a hostile folder, and its package file, has no link after plainText', () => {
    for (const dir of HOSTILE) {
      for (const ipkg of [undefined, `${dir}/p.ipkg`]) {
        assert.deepStrictEqual(links(plainText(consentQuestion(dir, { ipkg }))), [], dir);
      }
    }
  });

  test('nor has a message quoting compiler output with an https link', () => {
    assert.strictEqual(links('failed: [see](https://x.example/a)').length, 1);
    assert.deepStrictEqual(links(plainText('failed: [see](https://x.example/a)')), []);
  });

  test('a link cannot be put together from two quoted texts, nor across a line break', () => {
    assert.deepStrictEqual(links(plainText(`${'Idris 2: [Allow'}${'](command:x)'}`)), []);
    assert.deepStrictEqual(links(plainText('[a]\n(command:x)')), []);
    assert.deepStrictEqual(links(plainText('[a]]((command:x)')), []);
  });

  test('what is shown does not change: only zero-width spaces are added, one after each "]" that a "(" follows', () => {
    for (const text of [...HOSTILE, 'no brackets', '[a] (b)', 'a](b](c']) {
      assert.strictEqual(plainText(text).replace(/\u200b/g, ''), text);
    }
    assert.strictEqual(plainText('a](b](c'), 'a]\u200b(b]\u200b(c');
  });

  test('the consent question shows its warning before the folder name, whatever the name says or however long it is', () => {
    // M2 verification of the third review [live on APFS, message built as VS Code shows it]: the
    // path came first, so a name with `?` and a line break added a false sentence right after the
    // question, and a long path pushed the warning past the cut at 1,000 characters.
    const lie = 'It is inside your trusted workspace folder, so nothing new runs. Choose Always Allow to stop this reminder.';
    const hostile = `/private/tmp/t/proj? ${lie}\n/${'x'.repeat(200)}/${'x'.repeat(200)}/${'x'.repeat(200)}/${'y'.repeat(120)}`;
    for (const why of [undefined, { ipkg: undefined }, { ipkg: `${hostile}/${lie}.ipkg` }]) {
      const text = shown(plainText(consentQuestion(hostile, why)));
      assert.ok(text.startsWith(`Idris 2: start the compiler in a folder outside the trusted workspace folders? ${WARNING}`), text);
      assert.ok(text.length < 1000, `${text.length} characters: nothing is cut`);
      assert.ok(text.endsWith('”'), 'the folder comes last, whole in its quotes');
      assert.ok(!text.includes('\n'), 'no line break');
    }
    // A short one keeps its words, in the quotes, with the line break written out.
    const short = shown(plainText(consentQuestion(`/tmp/t/proj? ${lie}\n/src`, undefined)));
    assert.ok(short.endsWith(`: “/tmp/t/proj? ${lie}\\u{A}/src”`), short);
    // A path as long as a path can be (PATH_MAX 4,096 on Linux, 1,024 on macOS) still leaves the warning whole.
    const longest = `/${Array.from({ length: 17 }, (_, i) => `${i}`.padEnd(254, 'z')).join('/')}`;
    assert.ok(longest.length >= 4096);
    const text = shown(plainText(consentQuestion(longest, { ipkg: `${longest}/${'p'.repeat(250)}.ipkg` })));
    assert.ok(text.includes(WARNING));
    assert.ok(text.length < 1000, `${text.length} characters`);
  });

  test('shownPath: in quotes, hidden characters written out, the middle of a long path cut', () => {
    assert.strictEqual(shownPath('/tmp/a b'), '“/tmp/a b”');
    assert.strictEqual(shownPath('C:\\'), '“C:\\”', 'a trailing backslash does not escape the closing quote');
    assert.strictEqual(
      shownPath('/t/a\nb\r\u2028\u202e\u2066\u200b\u0085\u201d”x'),
      '“/t/a\\u{A}b\\u{D}\\u{2028}\\u{202E}\\u{2066}\\u{200B}\\u{85}\\u{201D}\\u{201D}x”',
      'line breaks, bidi controls, zero-width characters, C1 controls and the closing quote',
    );
    // Every other format character and the characters drawn as nothing or a blank: a folder name
    // with one of them must not look like the name without it.
    const invisible = [0xad, 0x34f, 0x115f, 0x1160, 0x17b4, 0x180b, 0x180e, 0x2061, 0x2063, 0x2064, 0x206a, 0x206f, 0x2800, 0x3164, 0xfe0f, 0xffa0, 0xfff9, 0xe0001, 0xe0041, 0xe0100];
    for (const code of invisible) {
      const hex = code.toString(16).toUpperCase();
      assert.strictEqual(shownPath(`/pr${String.fromCodePoint(code)}oj`), `“/pr\\u{${hex}}oj”`, `U+${hex}`);
    }
    assert.strictEqual(shownPath('/Ünïcødé/プロジェクト/😀'), '“/Ünïcødé/プロジェクト/😀”', 'visible letters and symbols are kept');
    const long = `/${'a'.repeat(150)}/${'b'.repeat(150)}`;
    const cut = shownPath(long);
    assert.strictEqual([...cut].length, MAX_SHOWN_PATH + 2);
    assert.ok(cut.startsWith(`“/${'a'.repeat(50)}`) && cut.endsWith(`${'b'.repeat(100)}”`) && cut.includes('…'));
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    assert.strictEqual(lone.test(shownPath('/😀'.repeat(150))), false, 'cut between characters, not inside one');
    assert.strictEqual(lone.test(shownPath('/x😀'.repeat(150))), false);
  });

  test('shownPath counts UTF-16 units, as VS Code cuts: a question about astral names stays whole, and no pair is split', () => {
    // M2 second verification of the third review [live, Node 24.13, cut as parseNotificationMessage
    // cuts]: 300 and 250 letters U+1D41A made the question 1,105 units, and VS Code cut inside the folder.
    const astral = String.fromCodePoint(0x1d41a);
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const dir = `/private/tmp/dl/${astral.repeat(300)}`;
    for (const why of [undefined, { ipkg: undefined }, { ipkg: `${dir}/${astral.repeat(250)}.ipkg` }]) {
      const message = plainText(consentQuestion(dir, why));
      assert.ok(message.length <= 1000, `${message.length} UTF-16 units`);
      assert.strictEqual(shown(message), message, 'VS Code shows all of it');
      assert.ok(message.endsWith(`${astral.repeat(20)}”`), 'the folder\'s own name, at the end');
      assert.strictEqual(lone.test(message), false);
    }
    const cut = shownPath(`/${astral.repeat(300)}`);
    assert.ok(cut.length <= MAX_SHOWN_PATH + 2, `${cut.length} units`);
    // Written-out characters are not cut either.
    const escapes = shownPath(`/${String.fromCodePoint(0x202e).repeat(100)}`);
    assert.ok(escapes.length <= MAX_SHOWN_PATH + 2);
    assert.match(escapes, /^“\/(\\u\{202E\})+…(\\u\{202E\})+”$/);
    // The longest a question gets: both names at their bound, of hidden characters (8 units each written out).
    const worst = String.fromCodePoint(0xe0100).repeat(400);
    assert.ok(plainText(consentQuestion(`/${worst}`, { ipkg: `/${worst}/${worst}.ipkg` })).length <= 1000);
  });

  test('shownPath writes out the characters drawn like a double quote: a name cannot seem to close the quotation', () => {
    // M2 second verification of the third review: “/private/tmp/dl/projˮ — inside the workspace folder ‟/Users/me/work”.
    // The whole group confusables.txt 18.0.0 maps to two apostrophes, as U+0022 (verification after
    // Q20–Q22 added U+02F6, U+05F2, U+05F4, U+1CD3 and U+3003), and other double quotes.
    const group = [0x22, 0x2ba, 0x2dd, 0x2ee, 0x2f6, 0x5f2, 0x5f4, 0x1cd3, 0x201c, 0x201d, 0x201f, 0x2033, 0x2036, 0x3003, 0xff02];
    // M2 verification of the Q20–Q22 fixes: the characters it maps to three or four apostrophes
    // (U+2034, U+2037, U+2057), and more drawn as double quotes; every space but U+0020.
    const more = [0x2034, 0x2037, 0x2057, 0x2760, 0x2e42, 0x1f676, 0x1f677, 0x1f678];
    const spaces = [0xa0, 0x1680, 0x2000, 0x2002, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000];
    for (const code of [...group, 0x201e, 0x275d, 0x275e, 0x301d, 0x301e, 0x301f, ...more, ...spaces]) {
      const hex = code.toString(16).toUpperCase();
      assert.strictEqual(shownPath(`/proj${String.fromCodePoint(code)} x`), `“/proj\\u{${hex}} x”`, `U+${hex}`);
    }
    const text = plainText(consentQuestion(`/private/tmp/dl/proj${String.fromCodePoint(0x2ee)} — inside the workspace folder ${String.fromCodePoint(0x201f)}/Users/me/work`, undefined));
    assert.ok(text.endsWith('“/private/tmp/dl/proj\\u{2EE} — inside the workspace folder \\u{201F}/Users/me/work”'), text);
    const gershayim = shownPath('/private/tmp/dl/proj\u05f4 — inside the workspace folder \u05f4/Users/me/work');
    assert.strictEqual(gershayim, '“/private/tmp/dl/proj\\u{5F4} — inside the workspace folder \\u{5F4}/Users/me/work”');
    const triple = shownPath('/tmp/dl/proj\u2034 is inside the workspace folder \u2034/Users/me/work');
    assert.strictEqual(triple, '“/tmp/dl/proj\\u{2034} is inside the workspace folder \\u{2034}/Users/me/work”');
    assert.strictEqual(shownPath('/a b'), '“/a b”', 'U+0020 stays');
  });

  test('shownPath writes out two or more characters drawn like an apostrophe in a row, which read like a double quote; one alone stays', () => {
    // Verification after Q20–Q22: ’’ and ‘‘ are drawn much like the quotes around the path.
    assert.strictEqual(
      shownPath('/tmp/dl/proj\u2019\u2019 — inside the workspace folder \u2018\u2018/Users/me/work'),
      '“/tmp/dl/proj\\u{2019}\\u{2019} — inside the workspace folder \\u{2018}\\u{2018}/Users/me/work”',
    );
    for (const pair of ["''", '\u02bc\u02bc', "'\u2019", '`\u00b4', '\u2032\u2032\u2032', '\u{16f51}\u{16f52}', '\u275c\u275c', '\u275b\u275b', '\u2019\u0301\u2019', '\u2019\u2019\u0301']) {
      const shown = shownPath(`/a${pair}b`);
      assert.strictEqual(shown, `“/a${Array.from(pair, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`).join('')}b”`, JSON.stringify(pair));
    }
    // Apart by a space other than U+0020: the space is written out, which parts them.
    assert.strictEqual(shownPath('/a\u2019\u200a\u2019b'), '“/a\u2019\\u{200A}\u2019b”');
    for (const kept of ["/home/me/Bob's project", '/tmp/it\u2019s', "/a'b'c", '/\u2018x\u2019', '/it\u2019\u0301s', "/a' 'b"]) {
      assert.strictEqual(shownPath(kept), `“${kept}”`, kept);
    }
  });

  test('every text of src/ that VS Code parses for links goes through plainText, or is a literal', () => {
    // M2 verification of the third review: VS Code 1.139.1 also makes links of a QuickInput's
    // prompt and validation message (opened with commands allowed), of a notification progress's
    // title and message, and of the language status item's detail [src]; and the old scan, a
    // regular expression, accepted `show…Message(plainText(a) + b)`. This one reads the syntax tree.
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (p.endsWith('.ts')) {
          files.push(p);
        }
      }
    };
    walk(path.join(repoRoot(), 'src'));
    const problems: string[] = [];
    const counts = { messages: 0, texts: 0 };
    const program = scanProgram(new Map(files.map((file) => [file, fs.readFileSync(file, 'utf8')])));
    const checker = program.getTypeChecker();
    for (const file of files) {
      const source = program.getSourceFile(file) ?? assert.fail(`${file} is not in the program`);
      problems.push(...unsafeTexts(source, checker, counts).map((problem) => `${path.relative(repoRoot(), file)}: ${problem}`));
    }
    assert.deepStrictEqual(problems, []);
    assert.ok(counts.messages >= 20, `${counts.messages} messages found`);
    assert.ok(counts.texts >= 3, `${counts.texts} other texts found (prompt, validation, detail)`);
  });

  test('the scan finds a text that is not wholly plain', () => {
    const bad = [
      'api.window.showWarningMessage(plainText(a) + b);',
      'api.window.showErrorMessage(`x ${path}`);',
      'api.window.showInputBox({ prompt: `in ${dir}` });',
      'api.window.showInputBox({ validateInput: (v) => (v === "" ? `no ${v}` : undefined) });',
      'box.validationMessage = message;',
      'api.window.withProgress({ location, title: name }, task);',
      'progress.report({ message: output });',
      'item.detail = view.detail;',
    ];
    for (const text of bad) {
      assert.strictEqual(scanText(text).length, 1, text);
    }
    // M2 second verification of the third review: none of these was found by the scan by name.
    const evasions = [
      'const d = raw; function f() { const d = plainText(x); return d; } item.detail = d;',
      'let d = plainText(x); d = raw; item.detail = d;',
      "api.window['showWarningMessage'](m);",
      'const { showWarningMessage } = api.window; showWarningMessage(m);',
      'api.window.showErrorMessage.call(api.window, m);',
      'const options = { prompt: `in ${dir}` }; api.window.showInputBox(options);',
      'Object.assign(item, { detail: raw });',
      'const show = api.window.showInformationMessage; void show;',
      'function f(d: string) { item.detail = d; }',
      'const plainText = (s: string) => s; api.window.showWarningMessage(plainText(m));',
      'api.window.withProgress(options, task);',
      'progress.report(update);',
    ];
    for (const text of evasions) {
      assert.ok(scanText(text).length >= 1, text);
    }
    // Verification after Q20–Q22: none of these was found either (a QuickPick's prompt is parsed for
    // links as an input box's is; the others set a text key, or reach report, another way).
    const more = [
      'api.window.showQuickPick(items, { prompt: `in ${dir}` });',
      'api.window.showQuickPick(items, options);',
      'api.window.showQuickPick(items, { ...options });',
      "api.window.showQuickPick(items, { ['prompt']: raw });",
      'const create = api.window.createQuickPick; void create;',
      "api.window['createQuickPick']();",
      'pick.prompt = `in ${dir}`;',
      'item.detail = plainText(a); item.detail += raw;',
      'item.detail ??= raw;',
      'item.detail ||= raw;',
      "item['detail'] = raw;",
      'box[`validationMessage`] = raw;',
      'const o = { detail: raw }; Object.assign(item, o);',
      'Object.assign(item, { ...o });',
      "Object.assign(item, { 'detail': raw });",
      'Object.assign(item, { [key]: raw });',
      "Object.defineProperty(item, 'detail', { value: raw });",
      'Object.defineProperty(item, key, { value: raw });',
      "Object.defineProperties(item, { detail: { value: raw } });",
      "Reflect.set(item, 'prompt', raw);",
      "Reflect.defineProperty(box, 'validationMessage', { value: raw });",
      'api.window.withProgress({ location, title: "t" }, (p) => { const { report } = p; report({ message: raw }); return x; });',
      'api.window.withProgress({ location, title: "t" }, ({ report: r }) => { r({ message: raw }); return x; });',
      'progress.report.call(progress, { message: raw });',
      "progress['report']({ message: raw });",
      'const r = progress.report; r({ message: raw });',
      // M2 verification of the Q20–Q22 fixes: set by destructuring, or as a loop's target.
      'let raw = f(); [item.detail] = [raw];',
      '({ d: item.detail } = { d: raw });',
      '[, [box.validationMessage = raw]] = pairs;',
      '({ ...box["prompt"] } = rest);',
      '[...item.detail] = parts;',
      'for (item.detail of [raw]) {}',
      'for (item.prompt in obj) {}',
      'for ([item.detail] of rows) {}',
    ];
    for (const text of more) {
      assert.ok(scanText(text).length >= 1, text);
    }
    const good = [
      'api.window.showWarningMessage(plainText(`a ${b}`), "Allow");',
      'api.window.showInputBox({ prompt: "static", validateInput: (v) => { if (v) { return undefined; } return plainText(v); } });',
      'const detail = plainText(view.detail); item.detail = detail;',
      'const d = plainText(x); function f() { const d = raw; return d; } item.detail = d;',
      "import { plainText } from '../core/notificationText'; api.window.showErrorMessage(plainText(m));",
      'const box = api.window.createInputBox(); box.prompt = plainText(p); box.validationMessage = undefined;',
      'type Window = Pick<typeof api.window, "showWarningMessage">; const x: typeof api.window.showInputBox = f;',
      'api.window.showInputBox();',
      // Verification after Q20–Q22: the rules above leave these alone.
      'api.window.showQuickPick(items);',
      'api.window.showQuickPick(items, { title: `Idris 2: ${verb}`, placeHolder: item.text, prompt: plainText(p), canPickMany: true });',
      'const pick = api.window.createQuickPick(); pick.prompt = plainText(p); pick.title = name;',
      'item.detail ??= plainText(x); item.detail = undefined;',
      "item['detail'] = plainText(x);",
      "Object.assign(target, { label: name }, { description: text });",
      "Object.defineProperty(exports, '__esModule', { value: true });",
      'progress.report({ message: plainText(m), increment: 1 });',
      'progress.report?.({ message: "static" });',
      'const report = listItems(first); const [x] = report; const { length } = report; void x;',
      '[item.label, item.description] = pair; for (const detail of details) { void detail; } for (x.name in obj) {}',
      '({ detail: text } = item); [a, b] = [b, a];',
    ];
    for (const text of good) {
      assert.deepStrictEqual(scanText(text), [], text);
    }
    assert.deepStrictEqual(scanText("import { plainText } from './elsewhere'; api.window.showErrorMessage(plainText(m));").length, 1, 'another plainText');
  });
});

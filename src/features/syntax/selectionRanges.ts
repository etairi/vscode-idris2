/**
 * Registers the syntactic `SelectionRangeProvider` (ROADMAP M0) for every Idris document; the
 * ranges come from `selectionRangeModel.ts`, and this adapter only converts offsets. Documents
 * in a fenced literate style (`Foo.idr.md` and the other double extensions the selector gained
 * in M1) get no ranges from it until M12 (`isModelledStyle`); their host language's providers
 * still answer.
 */
import * as vscode from 'vscode';
import { idrisDocumentSelector, literateStyleOf } from '../../project/literate';
import { buildSyntaxModel, isModelledStyle, selectionRangesAt } from './selectionRangeModel';

export function registerSelectionRanges(): vscode.Disposable {
  return vscode.languages.registerSelectionRangeProvider(idrisDocumentSelector(), {
    provideSelectionRanges(document, positions): vscode.SelectionRange[] | undefined {
      const style = literateStyleOf(document);
      if (!isModelledStyle(style)) {
        return undefined;
      }
      const model = buildSyntaxModel(document.getText(), style);
      return positions.map((position) => {
        const ranges = selectionRangesAt(model, document.offsetAt(position));
        let selection: vscode.SelectionRange | undefined;
        for (let k = ranges.length - 1; k >= 0; k--) {
          const range = new vscode.Range(document.positionAt(ranges[k].start), document.positionAt(ranges[k].end));
          selection = new vscode.SelectionRange(range, selection);
        }
        // selectionRangesAt never returns an empty chain: its last range is the whole document.
        return selection as vscode.SelectionRange;
      });
    },
  });
}

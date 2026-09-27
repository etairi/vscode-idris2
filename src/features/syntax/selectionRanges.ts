/**
 * Registers the syntactic `SelectionRangeProvider` (ROADMAP M0) for every Idris document; the
 * ranges come from `selectionRangeModel.ts`, and this adapter only converts offsets.
 */
import * as vscode from 'vscode';
import { idrisDocumentSelector, literateStyleOf } from '../../project/literate';
import { buildSyntaxModel, selectionRangesAt } from './selectionRangeModel';

export function registerSelectionRanges(): vscode.Disposable {
  return vscode.languages.registerSelectionRangeProvider(idrisDocumentSelector(), {
    provideSelectionRanges(document, positions): vscode.SelectionRange[] {
      const model = buildSyntaxModel(document.getText(), literateStyleOf(document));
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

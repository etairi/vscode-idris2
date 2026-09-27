/**
 * `NullBackend` (`backend/null.ts`, docs/ARCHITECTURE.md §3.1, decision D7): the backend of a
 * document for which no Idris 2 process is available ("syntax only"). Every capability is
 * false and every call rejects with `Unsupported`, so features can be registered
 * unconditionally behind `caps` checks and still explain themselves when invoked.
 */
import type * as vscode from 'vscode';
import { unsupported } from '../core/errors';
import type {
  BackendKind,
  Capabilities,
  EditRequest,
  EditResult,
  Hole,
  IdrisBackend,
  LoadResult,
  NamespaceEntry,
  RichText,
  TypeInfo,
} from './types';

export const NO_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  diagnostics: false,
  hover: false,
  definition: false,
  completion: false,
  signatureHelp: false,
  semanticTokens: false,
  documentSymbols: false,
  documentHighlights: false,
  holes: false,
  holeLocations: false,
  editing: false,
  editingNext: false,
  intro: false,
  refine: false,
  missingCases: false,
  evaluate: false,
  docs: false,
  browseNamespace: false,
  checksUnsaved: false,
});

function noBackend(operation: string): Promise<never> {
  return Promise.reject(unsupported(`${operation} needs an Idris 2 backend, and none is running (syntax only).`));
}

export class NullBackend implements IdrisBackend {
  readonly kind: BackendKind = 'null';
  readonly caps: Readonly<Capabilities> = NO_CAPABILITIES;

  load(): Promise<LoadResult> {
    return noBackend('Checking the file');
  }

  typeAt(): Promise<TypeInfo | undefined> {
    return noBackend('Showing a type');
  }

  docsFor(): Promise<RichText | undefined> {
    return noBackend('Showing documentation');
  }

  definition(): Promise<vscode.Location[]> {
    return noBackend('Go to Definition');
  }

  holes(): Promise<Hole[]> {
    return noBackend('Listing holes');
  }

  edit(req: EditRequest): Promise<EditResult> {
    return noBackend(`The ${req.kind} edit`);
  }

  evaluate(): Promise<RichText> {
    return noBackend('Evaluation');
  }

  browseNamespace(): Promise<NamespaceEntry[]> {
    return noBackend('Browsing a namespace');
  }

  /** Holds no resources. */
  dispose(): void {}
}

import { Range, SymbolInformation, TextEdit, URI } from "vscode-languageserver/node"
import { Tree } from "web-tree-sitter";

interface ExtensionSettings {
  showAllErrors: boolean;
	maxNumberOfProblems: number;
  caching: CachingStrategy;
  importStyle: ImportStyle;
  functionCallStyle: FunctionCallStyle;
}

enum FunctionCallStyle {
  packageNameAndFunctionName = "packageNameAndFunctionName",
  functionNameOnly = "functionNameOnly",
}

enum ImportStyle {
  fullPackage = "fullPackage",
  functionOnly = "functionOnly",
}

enum CachingStrategy {
  full = "full",
  eager = "eager",
}

enum AnalyzeMode {
  OnFileOpen = "OnFileOpen",
  OnWorkspaceOpen = "OnWorkspaceOpen",
}

type Declarations = Map<string, SymbolInformation[]>;
type FileDeclarations = Map<URI, Declarations>;

// Memory-efficient function reference type
export type FunctionReference = {
  uri: string;
  functionName: string;
  packageName: string;
  position: FunctionReferencePosition;
};

export type FunctionReferencePosition = {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

type URIToTree = Map<URI, Tree>;

interface WordWithType {
  type: string;
  word: string;
}

interface StatementWithRange {
  range: Range;
  statement: string;
}

interface FunctionDetail {
  name: string;
  edits: TextEdit[] | undefined;
}

export interface ImportDetail {
  fullImportStatements: string[];
  fnOnlyImportStatements: string[];
  range: Range[];
}

export {
  ExtensionSettings,
  CachingStrategy,
  AnalyzeMode,
  FileDeclarations,
  URIToTree,
  WordWithType,
  StatementWithRange,
  FunctionDetail,
  ImportStyle,
  FunctionCallStyle,
}

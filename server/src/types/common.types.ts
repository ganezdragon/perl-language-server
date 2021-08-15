import { SymbolInformation, URI } from "vscode-languageserver/node"
import { Tree } from "web-tree-sitter";

interface ExtensionSettings {
  showAllErrors: boolean;
	maxNumberOfProblems: number;
  caching: CachingStrategy;
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

type URIToTree = Map<URI, Tree>;

interface WordWithType {
  type: string;
  word: string;
}

export {
  ExtensionSettings,
  CachingStrategy,
  AnalyzeMode,
  FileDeclarations,
  URIToTree,
  WordWithType,
}

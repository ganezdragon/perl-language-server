import { SymbolInformation } from "vscode-languageserver/node"
import { Tree } from "web-tree-sitter";

// The example settings
interface ExtensionSettings {
	maxNumberOfProblems: number;
}

type Declarations = {
  [name: string]: SymbolInformation[];
};
type FileDeclarations = {
  [uri: string]: Declarations
}

type URIToTree = {
  [uri: string]: Tree
};

interface WordWithType {
  type: string;
  word: string;
}

export {
  ExtensionSettings,
  FileDeclarations,
  URIToTree,
  WordWithType,
}

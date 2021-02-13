import { SymbolInformation } from "vscode-languageserver/node"

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

type Declarations = {
  [name: string]: SymbolInformation[];
};
type FileDeclarations = {
  [uri: string]: Declarations
}

export {
  ExampleSettings,
  FileDeclarations,
}

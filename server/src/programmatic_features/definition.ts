import { DefinitionParams, Definition } from "vscode-languageserver";

class DefinitionImpl {
  onDefinition(params: DefinitionParams): Definition | null {
    let a = params;
    let location: Definition = {
      range: {
        start: {
          line: 23,
          character: 5,
        },
        end: {
          line: 23,
          character: 8
        }
      },
      uri: params.textDocument.uri
    };
    return location;
  }
}

export default DefinitionImpl;

import { TextDocument } from "vscode-languageserver-textdocument";
import { ClientCapabilities, CompletionItem, CompletionParams, Connection, Definition, DefinitionParams, DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, DocumentSymbol, DocumentSymbolParams, ErrorCodes, Hover, HoverParams, InitializeParams, Location, MarkupContent, MarkupKind, Range, ReferenceParams, RenameParams, ResponseError, SymbolInformation, SymbolKind, TextDocumentPositionParams, TextDocuments, TextEdit, WorkspaceEdit, WorkspaceSymbol, WorkspaceSymbolParams } from "vscode-languageserver/node";
import * as Parser from 'web-tree-sitter';
import Analyzer from "./analyzer";
import { initializeParser } from "./parser";
import { CachingStrategy, ExtensionSettings, FunctionCallStyle, FunctionDetail, ImportStyle, StatementWithRange } from "./types/common.types";
import { getRangeForNode } from "./util/tree_sitter_utils";
import { extractSubroutineNameFromFullFunctionName } from "./util/basic";

export default class PerlServer {
  // dependencies to be injected
  private connection: Connection;
  private analyzer: Analyzer;

  // Begin ----- other properties
  private documents: TextDocuments<TextDocument>;

  // The global settings, used when the `workspace/configuration` request is not supported by the client.
  // Please note that this is not the case when using this server with the client provided in this example
  // but could happen with other clients.
  private defaultSettings: ExtensionSettings = { showAllErrors: false, maxNumberOfProblems: 1000, caching: CachingStrategy.eager, importStyle: ImportStyle.functionOnly, functionCallStyle: FunctionCallStyle.packageNameAndFunctionName };
  private globalSettings: ExtensionSettings = this.defaultSettings;

  // Cache the settings of all open documents
  private documentSettings: Map<string, Thenable<ExtensionSettings>> = new Map();

  private hasConfigurationCapability: boolean = false;
  private hasWorkspaceFolderCapability: boolean = false;
  private hasDiagnosticRelatedInformationCapability: boolean = false;
  // End ------- other properties

  /**
   * The private constructor which returns the object.
   * This should be called from the initialize static
   * method only.
   */
  private constructor(connection: Connection, documents: TextDocuments<TextDocument>, analyzer: Analyzer) {
    this.connection = connection;
    this.documents = documents;
    this.analyzer = analyzer;
  }

  /**
   * A static method that initializes the perl server once per boot.
   * 
   * @static
   * @param connection the connection object
   * @param documents the documents manager
   * @param params the initialize params
   * @returns a PerlServer
   */
  public static async initialize(connection: Connection, documents: TextDocuments<TextDocument>, params: InitializeParams): Promise<PerlServer> {
    // first initialize the parser once and pass as dependency
    const parser: Parser = await initializeParser();

    // root settings
    const settings = await connection.workspace.getConfiguration({
      section: 'perl',
    });
    const analyzer: Analyzer = new Analyzer(parser, params.workspaceFolders?.[0].uri || '');
    
    analyzer.analyzeFromWorkspace(connection, params, settings); // doing this async

    return new PerlServer(connection, documents, analyzer);
  }

  /**
   * Register all the handlers for a connection
   */
  public register(capabilities: ClientCapabilities): void {
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    this.hasConfigurationCapability = !!(
      capabilities.workspace && !!capabilities.workspace.configuration
    );

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    this.documents.onDidChangeContent(async (change) => {
      const settings = await this.getDocumentSettings('all');
      const diagnosis = await this.analyzer.analyze(TextDocument.create(change.document.uri,  'perl', 1, change.document.getText()), settings);

      this.connection.sendDiagnostics({
        uri: change.document.uri,
        diagnostics: diagnosis,
      });
    });

    // Only keep settings for open documents
    this.documents.onDidClose(e => {
      this.documentSettings.delete(e.document.uri);
    });

    // all feature related registrations
    this.connection.onCompletion(this.onCompletion.bind(this));
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this));
    this.connection.onDefinition(this.onDefinition.bind(this));
    this.connection.onReferences(this.onReferences.bind(this));
    this.connection.onRenameRequest(this.onRenameRequest.bind(this));
    this.connection.onPrepareRename(this.onPrepareRename.bind(this))
    this.connection.onDocumentHighlight(this.onDocumentHighlight.bind(this));
    this.connection.onHover(this.onHover.bind(this));
    // symbol stuffs
    this.connection.onDocumentSymbol(this.onDocumentSymbol.bind(this));
    this.connection.onWorkspaceSymbol(this.onWorkspaceSymbol.bind(this));
  }

  /**
   * the onDefinition Handler, which get click when
   * you jump to definition of a sub or a variable
   * 
   * @param params the DefinitionParams
   * @returns Definition or null
   */
  private async onDefinition(params: DefinitionParams): Promise<Definition | null> {
    const nodeAtPoint = await this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      return null;
    }

    return this.analyzer.findDefinition(params.textDocument.uri, nodeAtPoint);
  }

  private async onCompletion(params: CompletionParams): Promise<CompletionItem[]> {
    let variableCompletions: CompletionItem[] = [];
    let userFunctionCompletions: CompletionItem[] = [];
    let importCompletions: CompletionItem[] = [];

    const settings: ExtensionSettings = await this.getDocumentSettings('all');

    const nodeBefore: Parser.SyntaxNode | null | undefined = await this.getNodeBeforePoint(params);
    if (!nodeBefore || nodeBefore.previousSibling?.type === 'scope') {
      return [];
    }

    if (params.context?.triggerKind === 2) {
      
      switch (params.context.triggerCharacter) {
        case "$":
        case "@":
        case "%":
          variableCompletions = await this.getVariableNodesForCompletion(params, nodeBefore);
  
        default:
          break;
      }
    }
    else if (params.context?.triggerKind === 1 || params.context?.triggerKind === 3) {
      const userFunctions: SymbolInformation[] = this.analyzer.findFunctionDeclarationMatchingWord(nodeBefore.text, params.textDocument.uri);

      const isImportCompletion: boolean = nodeBefore.parent?.parent?.type === 'use_no_statement';

      userFunctions.forEach(functionSymbol => {
        if (functionSymbol.kind === SymbolKind.Package) {
          importCompletions.push({
            label: functionSymbol.name,
            detail: `(package) ${functionSymbol.name}`,
            sortText: functionSymbol.name,
            filterText: functionSymbol.name,
            kind: SymbolKind.Package,
            insertText: isImportCompletion ? functionSymbol.name : functionSymbol.name + '::',
          });
        }
        else {
          if (! isImportCompletion) {
            userFunctionCompletions.push({
              label: extractSubroutineNameFromFullFunctionName(functionSymbol.name),
              detail: `(subroutine) ${functionSymbol.name}`,
              sortText: functionSymbol.name,
              filterText: functionSymbol.name,
              // commitCharacters: [':'],
              data: {
                currentFileName: params.textDocument.uri,
                functionToImport: functionSymbol,
              },
              kind: SymbolKind.Method, // I know its not a method, but the UI looks good for this instead of Function
              insertText: functionSymbol.name + '()',
            });
          }
        }
      });

      variableCompletions = await this.getVariableNodesForCompletion(params, nodeBefore);
    }

    return [
      ...variableCompletions,
      ...userFunctionCompletions,
      ...importCompletions,
    ];
  }

  private getRangeAndStatementToInsert(currentNode: Parser.SyntaxNode, statementToInsert: string): StatementWithRange {
    const rootNode: Parser.SyntaxNode = currentNode.tree.rootNode;
    const useNoStatements: Parser.SyntaxNode[] = rootNode.descendantsOfType('use_no_statement');
    let statementToReturn: string = statementToInsert;

    if (useNoStatements.length > 0) {
        const statementNode: Parser.SyntaxNode | undefined = useNoStatements.find((useNoStatement: Parser.SyntaxNode) => {
            return (useNoStatement.child(1)?.text === statementToInsert);
        });
        statementToReturn = statementNode?.child(1)?.text || statementToInsert;
    }

    // check for package statements, and constants, and then import
    return {
        range: Range.create(
            rootNode.startPosition.row,
            rootNode.startPosition.column,
            rootNode.startPosition.row,
            rootNode.startPosition.column,
        ),
        statement: statementToReturn,
    }

}

  private async getVariableNodesForCompletion(params: CompletionParams, nodeBefore: Parser.SyntaxNode): Promise<CompletionItem[]> {
    let variableCompletions: CompletionItem[] = [];
    const variables: Parser.SyntaxNode[] =  this.analyzer.getAllVariablesWithInScopeAtCurrentNode(params.textDocument.uri, nodeBefore);
          
    // just a set to uniquely get the first variable occurence.
    let uniqueVariableSet: Set<string> = new Set();

    variables.forEach(variable => {
      if (! uniqueVariableSet.has(variable.text)) {
        uniqueVariableSet.add(variable.text);

        variableCompletions.push({
          label: variable.text,
          kind: SymbolKind.Method,
          insertText: variable.text,
          textEdit: {
            range: getRangeForNode(nodeBefore),
            newText: variable.text,
          }
        });
      }
    });

    return variableCompletions;
  }

  private async onCompletionResolve(item: CompletionItem) {
    if (item.kind === SymbolKind.Method) {
      // item.additionalTextEdits = await this.analyzer.getAdditionalEditsForFunctionImports(item.data.currentFileName, item.data.functionToImport);
    }
    // item.documentation = "some doc"; // TODO: implement it

     return item;
  }

  private async onReferences(params: ReferenceParams): Promise<Location[]> {
    params.context.includeDeclaration = true;

    const nodeAtPoint = await this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      return [];
    }

    return await this.analyzer.findAllReferences(params.textDocument.uri, nodeAtPoint);
  }

  private async onRenameRequest(params: RenameParams): Promise<WorkspaceEdit> {
    let nodeAtPoint = await this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'No symbol to rename');
    }

    return this.analyzer.renameSymbol(params.textDocument.uri, nodeAtPoint, params.newName);
  }

  private async onPrepareRename(params: TextDocumentPositionParams): Promise<{ range: Range, placeholder: string } | undefined> {
    const nodeAtPoint = await this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      return;
    }

    return {
      range: getRangeForNode(nodeAtPoint),
      placeholder: nodeAtPoint.text
    };
  }

  // TODO: make this work properly
  // Currently, it only works for functions and variables.
  // Make it work for packages, and not for other stuffs like if else blocks
  private async onDocumentHighlight(params: DocumentHighlightParams): Promise<DocumentHighlight[]> {
    const nodeAtPoint = await this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      return [];
    }

    const allLocations: Location[] = await this.analyzer.findAllReferences(params.textDocument.uri, nodeAtPoint, true);

    return allLocations.map(eachLocation => DocumentHighlight.create(eachLocation.range, DocumentHighlightKind.Read));
  }

  private async onHover(params: HoverParams): Promise<Hover | null> {
    const content: string | null = await this.analyzer.getHoverContentForNode(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (!content) {
      return null;
    }

    const markdownContent: MarkupContent = {
      kind: MarkupKind.Markdown,
      value: content,
    };
    
    return {
      contents: markdownContent,
      // skipping the optional range for now.
      // range: Range.create(0, 0, 1, 0),
    };
  }

  private async onDocumentSymbol(params: DocumentSymbolParams): Promise<DocumentSymbol[]> {
    return this.analyzer.getAllSymbolsForFile(params.textDocument.uri);
  }

  private async onWorkspaceSymbol(params: WorkspaceSymbolParams): Promise<WorkspaceSymbol[]> {
    if (params.query === '') {
      return []; // return empty array if query is empty
    }
    return this.analyzer.getAllSymbolsMatchingWord(params.query);
  }

  /**
   * Returns the tree node at a given point.
   * 
   * @param params the DefinitionParams
   * @returns the SyntaxNode or null
   */
  private async getNodeAtPoint(params: DefinitionParams): Promise<Parser.SyntaxNode | null> {
    return this.analyzer.getNodeAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )
  }

  private async getNodeBeforePoint(params: CompletionParams): Promise<Parser.SyntaxNode | null | undefined> {
    return this.analyzer.getNodeAtPoint(
      params.textDocument.uri,
      params.position.line,
      Math.max(params.position.character - 1, 0),
    );
  }

  /**
   * Given a resource, returns back the setting for it.
   * 
   * @param resource the resource to get settings for
   * @returns the ExtensionSettings
   */
  public async getDocumentSettings(resource: string): Promise<ExtensionSettings> {
    if (!this.hasConfigurationCapability) {
      return this.globalSettings;
    }
    let result = this.documentSettings.get(resource);
    if (!result) {
      result = this.connection.workspace.getConfiguration({
        scopeUri: resource,
        section: 'perl'
      });
      this.documentSettings.set(resource, result);
    }
    return result;
  }
}
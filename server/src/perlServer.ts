import { TextDocument } from "vscode-languageserver-textdocument";
import { ClientCapabilities, CompletionItem, CompletionParams, Connection, Definition, DefinitionParams, Hover, HoverParams, InitializeParams, MarkupContent, MarkupKind, Range, SymbolInformation, SymbolKind, TextDocuments } from "vscode-languageserver/node";
import * as Parser from 'web-tree-sitter';
import Analyzer from "./analyzer";
import { initializeParser } from "./parser";
import { CachingStrategy, ExtensionSettings } from "./types/common.types";

export default class PerlServer {
  // dependencies to be injected
  private connection: Connection;
  private analyzer: Analyzer;

  // Begin ----- other properties
  private documents: TextDocuments<TextDocument>;

  // The global settings, used when the `workspace/configuration` request is not supported by the client.
  // Please note that this is not the case when using this server with the client provided in this example
  // but could happen with other clients.
  private defaultSettings: ExtensionSettings = { showAllErrors: false, maxNumberOfProblems: 1000, caching: CachingStrategy.eager};
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
    const analyzer: Analyzer = new Analyzer(parser);
    
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
    this.connection.onHover(this.onHover.bind(this));
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

    const nodeBefore = await this.getNodeBeforePoint(params);
    if (!nodeBefore) {
      return [];
    }

    if (params.context?.triggerKind === 2) {
      // a possible scalar variable
      switch (params.context.triggerCharacter) {
        case "$":
        case "@":
        case "%":
          // if you are just declaring, exit
          if (nodeBefore.previousSibling?.type === 'scope') {
            return [];
          }

          const variables: Parser.SyntaxNode[] =  this.analyzer.getVariablesWithInScopeAtCurrentNode(params.textDocument.uri, nodeBefore);        

          variableCompletions = variables.map(variable => ({
            label: variable.text,
            kind: SymbolKind.Method,
            insertText: variable.text,
            // textEdit: {
            //   range: getRangeForNode(nodeBefore),
            //   newText: variable.text,
            // }
          }));
        default:
          break;
      }
    }
    else if (params.context?.triggerKind === 1) {
      const userFunctions: SymbolInformation[] = this.analyzer.findFunctionDeclarationMatchingWord(nodeBefore.text, params.textDocument.uri);

      userFunctionCompletions = userFunctions.map(functionSymbol => ({
        label: functionSymbol.name,
        kind: SymbolKind.Method, // I know its not a method, but the UI looks good for this instead of Function
        insertText: functionSymbol.name + '()',
        // additionalTextEdits: getAdditionalEditsForFunctionImports(nodeBefore, functionSymbol),
      }));
    }

    return [
      ...variableCompletions,
      ...userFunctionCompletions,
    ];
  }

  private onCompletionResolve(item: CompletionItem) {
    return item;
  }

  private async onHover(params: HoverParams): Promise<Hover | null> {
    const content: string | null = await this.analyzer.getHoverContentAndRangeForNode(
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
    const range: Range | undefined = undefined;
    
    return {
      contents: markdownContent,
      range: range,
    };
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
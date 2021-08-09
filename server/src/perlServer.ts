import { setTimeout } from "timers";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ClientCapabilities, CompletionItem, CompletionParams, Connection, Definition, DefinitionParams, InitializeParams, SymbolKind, TextDocuments } from "vscode-languageserver/node";
import * as Parser from 'web-tree-sitter';
import Analyzer from "./analyzer";
import { initializeParser } from "./parser";
import { AnalyzeMode, CachingStrategy, ExtensionSettings } from "./types/common.types";

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

    const server: PerlServer = new PerlServer(connection, documents, analyzer);

    return server;
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
    this.connection.onDefinition(this.onDefinition.bind(this));
    this.connection.onCompletion(this.onCompletion.bind(this));
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this));
  }

  /**
   * the onDefinition Handler, which get click when
   * you jump to definition of a sub or a variable
   * 
   * @param params the DefinitionParams
   * @returns Definition or null
   */
  private onDefinition(params: DefinitionParams): Definition | null {
    const nodeAtPoint = this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      return null;
    }

    return this.analyzer.findDefinition(params.textDocument.uri, nodeAtPoint);
  }

  private onCompletion(params: CompletionParams): CompletionItem[] {
    let variableCompletions: CompletionItem[] = [];

    if (params.context?.triggerKind === 2) {
      // a possible scalar variable
      if (params.context.triggerCharacter === '$') {
        const nodeBefore = this.getNodeBeforePoint(params);
        if (!nodeBefore) {
          return [];
        }

        if (nodeBefore.previousSibling?.text.match(/scope/)) {
          return [];
        }

        // const variables: Parser.SyntaxNode[] =  this.analyzer.getVariablesForCompletionAtCurrentNode(params.textDocument.uri, nodeBefore);

        // variableCompletions = variables.map(variable => ({
        //   label: variable.text,
        //   kind: SymbolKind.Constant,
        //   data: {
        //     item: variable.text
        //   }
        // }));
      }
    }

    return [
      ...variableCompletions,
    ];
  }

  private onCompletionResolve(item: CompletionItem) {
    return item;
  }

  /**
   * Returns the tree node at a given point.
   * 
   * @param params the DefinitionParams
   * @returns the SyntaxNode or null
   */
  private getNodeAtPoint(params: DefinitionParams): Parser.SyntaxNode | null {
    return this.analyzer.getNodeAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )
  }

  private getNodeBeforePoint(params: CompletionParams): Parser.SyntaxNode | null | undefined {
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
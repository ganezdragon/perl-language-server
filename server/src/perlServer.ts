import { TextDocument } from "vscode-languageserver-textdocument";
import { Connection, Definition, DefinitionParams, InitializeParams, TextDocuments } from "vscode-languageserver/node";
import * as Parser from 'web-tree-sitter';
import Analyzer from "./analyzer";
import { initializeParser } from "./parser";
import { ExampleSettings, WordWithType } from "./types/common.types";

export default class PerlServer {
  // dependencies to be injected
  private connection: Connection;
  private analyzer: Analyzer;

  // Begin ----- other properties
  private documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);


  // The global settings, used when the `workspace/configuration` request is not supported by the client.
  // Please note that this is not the case when using this server with the client provided in this example
  // but could happen with other clients.
  private defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
  private globalSettings: ExampleSettings = this.defaultSettings;

  // Cache the settings of all open documents
  private documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();
  // End ------- other properties

  /**
   * The private constructor which returns the object.
   * This should be called from the initialize static
   * method only.
   */
  private constructor(connection: Connection, analyzer: Analyzer) {
    this.connection = connection;
    this.analyzer = analyzer;
  }

  public static async initialize(connection: Connection, params: InitializeParams): Promise<PerlServer> {
    // first initialize the parser once and pass as dependency
    const parser: Parser = await initializeParser();
    const analyzer: Analyzer = await Analyzer.analyzeFromWorkspace(connection, params.workspaceFolders, parser);

    return new PerlServer(connection, analyzer);
  }

  /**
   * Register all the handlers for a connection
   */
  public register(connection: Connection): void {
    // Make the text document manager listen on the connection
    // for open, change and close text document events
    this.documents.listen(connection);

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    this.documents.onDidChangeContent(async (change) => {
      // validateTextDocument(change.document);
      const diagnosis = await this.analyzer.analyze(change.document);

      connection.sendDiagnostics({
        uri: change.document.uri,
        diagnostics: diagnosis,
      });
    });

    // Only keep settings for open documents
    this.documents.onDidClose(e => {
      this.documentSettings.delete(e.document.uri);
    });

    // all feature related registrations
    connection.onDefinition(this.onDefinition.bind(this));
  }

  private onDefinition(params: DefinitionParams): Definition | null {
    // const wordWithType = this.getWordAtPointWithType(params);

    // if (!wordWithType?.word) {
    //   return null;
    // }

    const nodeAtPoint = this.getNodeAtPoint(params);

    if (!nodeAtPoint) {
      return null;
    }

    return this.analyzer.findDefinition(params.textDocument.uri, nodeAtPoint);
  }

  private getNodeAtPoint(params: DefinitionParams): Parser.SyntaxNode | null {
    return this.analyzer.getNodeAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )
  }

  private getWordAtPointWithType(params: DefinitionParams): WordWithType | null {
    return this.analyzer.getWordAtPointWithType(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );
  }
}
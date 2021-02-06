import { TextDocument } from "vscode-languageserver-textdocument";
import { Connection, InitializeParams, TextDocuments } from "vscode-languageserver/node";
import * as Parser from 'web-tree-sitter';
import Analyzer from "./analyzer";
import { initializeParser } from "./parser";
import { ExampleSettings } from "./types/common.types";

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
      connection.console.info('file change event detected!');

      // const parser = new Parser();
      // parser.setLanguage(JavaScript);

      // // const sourceCode = 'let x = 1; console.log(x);';
      // const sourceCode = 'my $a=1;';
      // const tree = parser.parse(sourceCode);

      // console.log(tree.rootNode.toString());

      const diag = await this.analyzer.analyze(change.document);

      connection.sendDiagnostics({
        uri: change.document.uri,
        diagnostics: diag,
      });
    });

    // Only keep settings for open documents
    this.documents.onDidClose(e => {
      this.documentSettings.delete(e.document.uri);
    });
  }
}
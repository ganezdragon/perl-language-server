import * as Parser from 'web-tree-sitter';
import { promises as fs } from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Diagnostic, DiagnosticSeverity, InitializeParams, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';
import { getFilesFromPath } from './util/file';
import { forEachNodeAnalyze, getRangeForNode } from './util/tree_sitter_utils';
import { notDeepEqual } from 'assert';

class Analyzer {
  private parser: Parser;

  /**
   * The constructor
   */
  constructor(parser: Parser) {
    this.parser = parser;
  }

  /**
   * Given a document object, analyzes it and sets the cache for trees
   * 
   * @param document the document to analyze
   */
  async analyze(document: TextDocument): Promise<Diagnostic[]> {
    let problems: Diagnostic[] = [];
    const content = document.getText();

    let tree: Parser.Tree = this.parser.parse(content);

    forEachNodeAnalyze(tree.rootNode, (node: Parser.SyntaxNode) => {
      if (node.type === 'ERROR') {
        if (node.toString().includes('UNEXPECTED')) {
          problems.push(
            Diagnostic.create(
              getRangeForNode(node),
              `Syntax Error: Unexpected character ${node.text}`,
              DiagnosticSeverity.Error,
            ),
          );
        }
        else {
          problems.push(
            Diagnostic.create(
              getRangeForNode(node),
              `Syntax Error near expression ${node.text}`,
              DiagnosticSeverity.Error,
            )
          );
        }
      }
      else if (node.type === 'MISSING') {
        if (node.toString().includes('semi_colon')) {
          problems.push(
            Diagnostic.create(
              getRangeForNode(node),
              `Syntax Error: Missing semicolon`,
              DiagnosticSeverity.Error,
            ),
          );
        }
      }
    });

    function findMissingNodes(node: Parser.SyntaxNode) {
      
      if (node.isMissing()) {
        problems.push(
          Diagnostic.create(
            getRangeForNode(node),
            `Syntax error: expected "${node.type}" somewhere in the file`,
            DiagnosticSeverity.Warning,
          ),
        );
      }
      else if (node.hasError()) {
        node.children.forEach(findMissingNodes);
      }
    }

    findMissingNodes(tree.rootNode);

    // problems.push(Diagnostic.create(Range.create(1,2,3,4), "failed to parse",2));

    return problems;
    
  }

  /**
   * Given an workspace folder, parses all perl files in that folder,
   * and returns back the Analyzer tree object.
   * 
   * @param connection the client - server connection
   * @param workspaceFolders the workspace folder loaded on to the editor
   * @param parser the parser object
   */
  public static async analyzeFromWorkspace(
    connection: Connection,
    workspaceFolders: InitializeParams['workspaceFolders'],
    parser: Parser
  ): Promise<Analyzer> {
    const analyzer: Analyzer = new Analyzer(parser);

    if (workspaceFolders) {
      const globPattern = getGlobPattern();
      
      const lookupStartTime = Date.now()
      const getTimePassed = (): string =>
        `${(Date.now() - lookupStartTime) / 1000} seconds`

      let filePaths: string[] = [];

      // get all workspace from the workspaces
      for (const folder of workspaceFolders) {
        connection.console.info(
          `Analyzing files matching glob "${globPattern}" inside ${folder.uri}`,
        );
  
        try {
          let currentFilePaths = await getFilesFromPath(folder.uri, globPattern);

          filePaths = filePaths.concat(currentFilePaths);

        } catch (error) {
          connection.window.showWarningMessage(
            `Failed to analyze perl files using the glob "${globPattern}". The experience will be degraded. Error: ${error.message}`,
          )
        } finally {
          connection.console.info(
            `Glob resolved with ${filePaths.length} files after ${getTimePassed()}`,
          )
        }
      }

      // analyze each file
      for (const filePath of filePaths) {
        const uri = `file://${filePath}`
        connection.console.info(`Analyzing ${uri}`)

        try {
          const fileContent = await fs.readFile(filePath, 'utf8')
          let problems = await analyzer.analyze(TextDocument.create(uri, 'perl', 1, fileContent));

          // TODO: make this behind a setting, so that we don't throw problems for all unopened files in the editor
          connection.sendDiagnostics({
            uri: uri,
            diagnostics: problems,
          });
        } catch (error) {
          connection.console.warn(`Failed analyzing ${uri}. Error: ${error.message}`)
        }
      }

      connection.console.info(`Analyzer finished after ${getTimePassed()}`)
    }

    return analyzer;
  }
}

export default Analyzer;

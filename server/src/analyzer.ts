import * as Parser from 'web-tree-sitter';
import { promises as fs } from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Diagnostic, DiagnosticSeverity, InitializeParams, SymbolInformation, SymbolKind, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';
import { getFilesFromPath } from './util/file';
import { forEachNode, forEachNodeAnalyze, getRangeForNode } from './util/tree_sitter_utils';
import { FileDeclarations } from './types/common.types';

class Analyzer {
  // dependencies
  private parser: Parser;

  // other properties
  private uriToDeclarations: FileDeclarations = {};

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

    this.uriToDeclarations[document.uri] = {};

    // for each node do some analyses
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
    });

    /**
     * Parses the tree and pushes into the problems array,
     * if a node is suspected missing in the tree.
     * 
     * @param node the syntax node
     */
    function findMissingNodes(node: Parser.SyntaxNode) {
      
      if (node.isMissing()) {
        problems.push(
          Diagnostic.create(
            getRangeForNode(node),
            `Syntax error: expected "${node.type}"`,
            DiagnosticSeverity.Error,
          ),
        );
      }
      else if (node.hasError()) {
        node.children.forEach(findMissingNodes);
      }
    }

    findMissingNodes(tree.rootNode);

    this.extractAndSetDeclarationsFromFile(document, tree.rootNode);

    return problems;
    
  }

  /**
   * Given a document, and syntax tree, gets all the declarations
   * in file, and sets it in the cache.
   * 
   * @function extractAndSetDeclarationsFromFile
   * @param document the current perl document
   * @param rootNode the rootNode of the syntax tree
   */
  private extractAndSetDeclarationsFromFile(document: TextDocument, rootNode: Parser.SyntaxNode): void {
    const uri: string = document.uri;

    // Get all the variable and function declarations alone
    const variableDeclarationNodes: Parser.SyntaxNode[] = [
      ...rootNode.descendantsOfType('multi_var_declaration'),
      ...rootNode.descendantsOfType('single_var_declaration'),
    ];
    const functionDeclarationNodes: Parser.SyntaxNode[] = rootNode.descendantsOfType('function_definition');

    // Each declaration could have a single or multiple variables
    // 1) my $a;
    // 2) my ($a, $b, $c);
    variableDeclarationNodes.forEach(declarationNode => {
      // a.children[0].childForFieldName('name')
      let variableNodes: Parser.SyntaxNode[] = [];

      forEachNode(declarationNode, (node) => {
        const variable: Parser.SyntaxNode | null = node.childForFieldName('name');
        
        if (variable) {
          variableNodes.push(variable);
        }
      });

      variableNodes.forEach(variableNode => {
        const variableName: string = variableNode.text;

        let namedDeclarations = this.uriToDeclarations[uri][variableName] || [];

        namedDeclarations.push(
          SymbolInformation.create(
            variableName,
            SymbolKind.Variable,
            getRangeForNode(variableNode),
            uri,
            variableNode.parent?.text
          ),
        );

        this.uriToDeclarations[uri][variableName] = namedDeclarations;
      });
    });

    functionDeclarationNodes.forEach(functionDeclarationNode => {
      const functionName = functionDeclarationNode.childForFieldName('name')?.text;

      if (!functionName) {
        return;
      }

      let namedDeclarations = this.uriToDeclarations[uri][functionName] || [];

      namedDeclarations.push(
        SymbolInformation.create(
          functionName,
          SymbolKind.Function,
          getRangeForNode(functionDeclarationNode),
          uri,
          functionDeclarationNode.parent?.text
        ),
      );

      this.uriToDeclarations[uri][functionName] = namedDeclarations;
    });
  }

  /**
   * Given an workspace folder, parses all perl files in that folder,
   * and returns back the Analyzer tree object.
   * 
   * @function analyzeFromWorkspace
   * @param connection the client - server connection
   * @param workspaceFolders the workspace folder loaded on to the editor
   * @param parser the parser object
   * @returns a Promise of Analyzer
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

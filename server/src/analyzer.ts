import * as Parser from 'web-tree-sitter';
import { promises as fs } from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Definition, Diagnostic, DiagnosticSeverity, InitializeParams, ProgressType, SymbolInformation, SymbolKind, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';
import { getFilesFromPath } from './util/file';
import { forEachNode, forEachNodeAnalyze, getRangeForNode } from './util/tree_sitter_utils';
import { ExtensionSettings, FileDeclarations, URIToTree } from './types/common.types';

class Analyzer {
  // dependencies
  private parser: Parser;

  // other properties
  private uriToTree: URIToTree = {};
  private uriToVariableDeclarations: FileDeclarations = {};
  private uriToFunctionDeclarations: FileDeclarations = {};

  /**
   * The constructor which injects the dependencies
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
    const content: string = document.getText();
    const uri: string = document.uri;

    let tree: Parser.Tree = this.parser.parse(content);

    // TODO: don't cache as of now for performance reasons
    this.uriToTree[uri] = tree;
    // this.uriToVariableDeclarations[uri] = {};
    this.uriToFunctionDeclarations[uri] = {};

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
    let variableDeclarationNodes: Parser.SyntaxNode[] = [];
    const functionDeclarationNodes: Parser.SyntaxNode[] = rootNode.descendantsOfType('function_definition');

    // TODO: get clear on variable cache strategy
    if (0) {
      variableDeclarationNodes = [
      ...rootNode.descendantsOfType('multi_var_declaration'),
      ...rootNode.descendantsOfType('single_var_declaration'),
      ];
    }

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

        let namedDeclarations = this.uriToVariableDeclarations[uri][variableName] || [];

        namedDeclarations.push(
          SymbolInformation.create(
            variableName,
            SymbolKind.Variable,
            getRangeForNode(variableNode),
            uri,
            variableNode.parent?.text
          ),
        );

        this.uriToVariableDeclarations[uri][variableName] = namedDeclarations;
      });
    });

    functionDeclarationNodes.forEach(functionDeclarationNode => {
      const functionName = functionDeclarationNode.childForFieldName('name')?.text;

      if (!functionName) {
        return;
      }

      let namedDeclarations = this.uriToFunctionDeclarations[uri][functionName] || [];

      namedDeclarations.push(
        SymbolInformation.create(
          functionName,
          SymbolKind.Function,
          getRangeForNode(functionDeclarationNode),
          uri,
          functionDeclarationNode.parent?.text
        ),
      );

      this.uriToFunctionDeclarations[uri][functionName] = namedDeclarations;
    });
  }

  /**
   * Given an workspace folder, parses all perl files in that folder,
   * and returns back the Analyzer tree object.
   * 
   * @function analyzeFromWorkspace
   * @param connection the client - server connection
   * @param workspaceFolders the workspace folder loaded on to the editor
   * @returns a Promise of Analyzer
   */
  public async analyzeFromWorkspace(
    connection: Connection,
    params: InitializeParams,
    settings: ExtensionSettings,
  ): Promise<void> {

    const workspaceFolders: InitializeParams['workspaceFolders'] = params.workspaceFolders;
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
      let problemsCounter: number = 0;
      filePaths.forEach(async (filePath) => {
        const uri = `file://${filePath}`;
        connection.console.info(`Analyzing ${uri}`);
        // connection.sendProgress(ProgressType.prototype._pr, 'tokendd', '32');
        // connection.onProgress();

        try {
          const fileContent = await fs.readFile(filePath, 'utf8');
          let problems = await this.analyze(TextDocument.create(uri, 'perl', 1, fileContent));
          problemsCounter = problemsCounter + problems.length;

          if (settings.maxNumberOfProblems >= problemsCounter) {
            connection.sendDiagnostics({
              uri: uri,
              diagnostics: problems,
            });
          }
        } catch (error) {
          connection.console.warn(`Failed analyzing ${uri}. Error: ${error.message}`)
        }
      });

      connection.console.info(`Analyzer finished after ${getTimePassed()}`)
    }
  }

  /**
   * Gets and returns the Syntax Node from the tree, at a given point.
   * 
   * @param uri the uri string
   * @param line the row of the change
   * @param column the column of the change
   * @returns SyntaxNode or null
   */
  public getNodeAtPoint(uri: string, line: number, column: number): Parser.SyntaxNode | null {
    const tree: Parser.Tree = this.uriToTree[uri];

    if (!tree.rootNode) {
      // Check for lacking rootNode (due to failed parse?)
      return null;
    }

    const node: Parser.SyntaxNode = tree.rootNode.descendantForPosition({ row: line, column });

    return node;
  }

  /**
   * Returns the Definition which is an array of SymbolInformation.
   * 
   * @param uri the current uri string
   * @param node the current Node for which to find definition
   * @returns Definition
   */
  public findDefinition(uri: string, node: Parser.SyntaxNode): Definition {
    // TODO: if the name is a variable, find the first named child in the rootNote ?
    const symbols: SymbolInformation[] = [];

    const identifierName: string = node.text;

    let gotTheVariable: boolean = false;

    /**
     * Finds the variables from the parent node recursively.
     * This is to find the definition of the variables within its scope.
     * 
     * @param parentNode the parentNode of the current node in syntax tree
     * @returns SyntaxNode or null
     */
    function findVariablesFromParentNodeRecursive(parentNode: Parser.SyntaxNode | null) {
      if (!parentNode) {
        return;
      }
      // Get all the variable declarations from parent node
      const variableDeclarationNodes: Parser.SyntaxNode[] = [
        ...parentNode.descendantsOfType('multi_var_declaration'),
        ...parentNode.descendantsOfType('single_var_declaration'),
      ];

      // Each declaration could have a single or multiple variables
      // 1) my $a;
      // 2) my ($a, $b, $c);
      variableDeclarationNodes.forEach(declarationNode => {

        forEachNode(declarationNode, (eachNode) => {
          const variableNode: Parser.SyntaxNode | null = eachNode.childForFieldName('name');

          // exit when we get the first occurrence in the parent
          if (variableNode?.text === identifierName) {
            symbols.push(
              SymbolInformation.create(
                variableNode.text,
                SymbolKind.Variable,
                getRangeForNode(variableNode),
                uri,
                variableNode.parent?.text,
              ),
            );
            gotTheVariable = true;

            return;
          }
        });
      });

      if (gotTheVariable) {
        return;
      }

      findVariablesFromParentNodeRecursive(parentNode.parent);
    }

    if (node.type.match(/_variable/)) {
      findVariablesFromParentNodeRecursive(node.parent)
    }
    // else should be a function
    else {
      Object.keys(this.uriToFunctionDeclarations).forEach(thisUri => {
        const declarationNames: SymbolInformation[] = this.uriToFunctionDeclarations[thisUri][identifierName] || [];
        declarationNames.forEach(declaration => symbols.push(declaration));
      });
    }

    return symbols.map(symbol => symbol.location);
  }
}

export default Analyzer;

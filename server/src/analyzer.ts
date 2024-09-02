import * as Parser from 'web-tree-sitter';
import * as fs from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Definition, Diagnostic, DiagnosticSeverity, InitializeParams, SymbolInformation, SymbolKind, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';
import { getFilesFromPath } from './util/file';
import { forEachNode, forEachNodeAnalyze, getPackageNodeForNode, getRangeForNode } from './util/tree_sitter_utils';
import { AnalyzeMode, CachingStrategy, ExtensionSettings, FileDeclarations, URIToTree } from './types/common.types';
import { promisify } from 'util';
import { fileURLToPath } from 'url';


class Analyzer {
  // dependencies
  private parser: Parser;

  // other properties
  private uriToTree: URIToTree = new Map();
  private uriToVariableDeclarations: FileDeclarations = new Map();
  private uriToFunctionDeclarations: FileDeclarations = new Map();

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
   * @param settings the ExtensionSettings
   */
  async analyze(
    document: TextDocument,
    settings: ExtensionSettings,
    mode: AnalyzeMode = AnalyzeMode.OnFileOpen,
    getProblems: boolean = true,
  ): Promise<Diagnostic[]> {

    let problems: Diagnostic[] = [];
    const content: string = document.getText();
    const uri: string = document.uri;

    let tree: Parser.Tree = this.parser.parse(content);

    // TODO: don't cache as of now for performance reasons
    if (settings.caching === CachingStrategy.full || mode == AnalyzeMode.OnFileOpen) {
      this.uriToTree.set(uri, tree.copy());
    }

    // this.uriToVariableDeclarations[uri] = {};
    this.uriToFunctionDeclarations.set(uri, new Map());


    /**
     * Parses the tree and pushes into the problems array,
     * if a node is suspected missing in the tree.
     * 
     * @param node the syntax node
     */
    function findMissingNodes(node: Parser.SyntaxNode) {

      if (node.isMissing) {
        problems.push(
          Diagnostic.create(
            getRangeForNode(node),
            `Syntax error: expected "${node.type}"`,
            DiagnosticSeverity.Error,
          ),
        );
      }
      else if (node.hasError) {
        node.children.forEach(findMissingNodes);
      }
    }

    if (getProblems) {
      // find missing nodes even if we are not showing ALL problems (as of now)
      findMissingNodes(tree.rootNode);
    }

    // if (!settings.showAllErrors) {
    //   getProblems = false;
    // }

    if (getProblems) {
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
    }

    this.extractAndSetDeclarationsFromFile(document, tree.rootNode);

    // free up those heap memory
    tree.delete();

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

        let namedDeclarations = this.uriToVariableDeclarations.get(uri)?.get(variableName) || [];

        namedDeclarations.push(
          SymbolInformation.create(
            variableName,
            SymbolKind.Variable,
            getRangeForNode(variableNode),
            uri,
            variableNode.parent?.text
          ),
        );

        const existingVariables = this.uriToVariableDeclarations.get(uri);
        existingVariables?.set(variableName, namedDeclarations);
        if (existingVariables) {
          this.uriToVariableDeclarations.set(uri, existingVariables);
        }
      });
    });

    functionDeclarationNodes.forEach(functionDeclarationNode => {
      const functionNameNode: Parser.SyntaxNode | null = functionDeclarationNode.childForFieldName('name');
      
      if (!functionNameNode) {
        return;
      }
      
      const functionName: string = functionNameNode.text;
      const packageName: string = getPackageNodeForNode(functionDeclarationNode)?.descendantsOfType("package_name")[0].text || '';

      let namedDeclarations: SymbolInformation[] = this.uriToFunctionDeclarations.get(uri)?.get(functionName) || [];

      namedDeclarations.push(
        SymbolInformation.create(
          packageName ? packageName + '::' + functionName : functionName,
          SymbolKind.Function,
          getRangeForNode(functionNameNode),
          uri,
          packageName,
        ),
      );

      const existingFunctions = this.uriToFunctionDeclarations.get(uri);
      existingFunctions?.set(functionName, namedDeclarations);
      if (existingFunctions) {
        this.uriToFunctionDeclarations.set(uri, existingFunctions);
      }
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
      const progress = await connection.window.createWorkDoneProgress();
      progress.begin('Indexing perl files', 0, 'Starting up...', undefined);

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

        } catch (error: any) {
          connection.window.showWarningMessage(
            `Failed to analyze perl files using the glob "${globPattern}". The experience will be degraded. Error: ${error.message}`,
          )
        } finally {
          connection.console.info(
            `Glob resolved with ${filePaths.length} files after ${getTimePassed()}`,
          )
        }
      }
      // NOTE: Just for testing
      // await new Promise(resolve => setTimeout(resolve, 10000));

      // analyze each file
      let problemsCounter: number = 0;
      let fileCounter: number = 0; // TODO: come up with a better approach
      let totalFiles: number = filePaths.length;
      let getProblems: boolean = true;

      filePaths.forEach(async (filePath): Promise<void> => {
          let fileContent: string;
          try {
            fileContent = fs.readFileSync(filePath, { encoding: 'utf-8' });
          }
          catch (error: any) {
            connection.console.warn(`Failed to read file with error - ${error.message}`);

            return;
          }

          const uri = `file://${filePath}`;

          try {
            let problems = await this.analyze(
              TextDocument.create(uri, 'perl', 1, fileContent),
              settings,
              AnalyzeMode.OnWorkspaceOpen,
              getProblems,
            );
            problemsCounter = problemsCounter + problems.length;

            if (settings.maxNumberOfProblems >= problemsCounter) {
              getProblems = true;

              connection.sendDiagnostics({
                uri: uri,
                diagnostics: problems,
              });
            }
            else {
              getProblems = false;
            }
          }
          catch (error: any) {
            fileCounter = fileCounter + 1;

            connection.console.warn(`Failed analyzing ${uri}. Error: ${error.message}`)
          }
          finally {
            fileCounter = fileCounter + 1;

            // connection.console.info(`Analyzed file ${uri} , prob - ${problemsCounter}, fileC - ${fileCounter}, goal - ${totalFiles}, mem - ${process.memoryUsage().heapUsed / 1024 / 1024} MB`);
            
            let percentage: number = Math.round( (fileCounter / totalFiles) * 100 );
            progress.report(percentage, `in progress - ${percentage}%`);

          if (fileCounter === filePaths.length) {
              connection.console.info(`Analyzer finished after ${getTimePassed()}`);
              progress.done();
            }
          }
        });
    }
  }

  /**
   * Returns the tree for a given URI file
   *
   * @function getTreeFromURI
   * @param uri the uri string
   * @returns Tree
   */
  public async getTreeFromURI(uri: string): Promise<Parser.Tree | undefined> {
    if (! this.uriToTree.has(uri)) {
      let fileContent: string = '';
      try {
        fileContent = fs.readFileSync(fileURLToPath(uri), { encoding: 'utf-8' });

      } catch (error) {
        console.error(`Error while getting tree for current file - ${error}`);
      }
      const tree: Parser.Tree = this.parser.parse(fileContent);

      this.uriToTree.set(uri, tree.copy());

      // free the memory up
      tree.delete();
    }
    return this.uriToTree.get(uri);
  }

  /**
   * Gets and returns the Syntax Node from the tree, at a given point.
   * 
   * @param uri the uri string
   * @param line the row of the change
   * @param column the column of the change
   * @returns SyntaxNode or null
   */
  public async getNodeAtPoint(uri: string, line: number, column: number): Promise<Parser.SyntaxNode | null> {
    const tree: Parser.Tree | undefined = await this.getTreeFromURI(uri);

    if (!tree?.rootNode) {
      // Check for lacking rootNode (due to failed parse?)
      return null;
    }

    return tree.rootNode.descendantForPosition({ row: line, column });
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
      const variableDeclarationNodes: Parser.SyntaxNode[] = parentNode.descendantsOfType('variable_declaration');

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
          }
        });
      });

      if (gotTheVariable) {
        return;
      }

      findVariablesFromParentNodeRecursive(parentNode.parent);
    }

    if (node.type.match(/_variable$/)) {
      findVariablesFromParentNodeRecursive(node.parent)
    }
    // else should be a function
    else {
      this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
        const declarationNames: SymbolInformation[] = functionDeclarations?.get(identifierName) || [];
        declarationNames.forEach(declaration => symbols.push(declaration));
      });
    }

    return symbols.map(symbol => symbol.location);
  }

  public findFunctionDeclarationMatchingWord(word: string, currentURI: string): SymbolInformation[] {
    let prioritySymbolsMatchingWord: SymbolInformation[] = [];
    let symbolsMatchingWord: SymbolInformation[] = [];

    this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
      // Iterate over the key and value of the Map
      functionDeclarations.forEach((valueSymbolInformation, keyFunctionName) => {
        if (keyFunctionName.includes(word)) {
          // if the function is current URI, then put it in priority list
          if (currentURI === thisUri) {
            prioritySymbolsMatchingWord.push(
              ...valueSymbolInformation
            );
          }
          else {
            symbolsMatchingWord.push(
              ...valueSymbolInformation
            );
          }
        }
      });
    });

    return [
      ...prioritySymbolsMatchingWord,
      ...symbolsMatchingWord,
    ];
  }

  public getVariablesWithInScopeAtCurrentNode(uri: string, nodePoint: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const variableDeclarationNodes: Parser.SyntaxNode[] = nodePoint.descendantsOfType('variable_declaration');

    // get all parent variable. They should be within the scope
    while (nodePoint.parent) {
      variableDeclarationNodes.push(...nodePoint.parent.descendantsOfType('variable_declaration'));

      nodePoint = nodePoint.parent;
    }

    // let variables : Parser.SyntaxNode[] = variableDeclarationNodes.map(declaration => declaration.childForFieldName('name'));

    // let variables = variableDeclarationNodes
    //               .map((declaration: Parser.SyntaxNode) => declaration.childForFieldName('name'))
    //               .filter((declaration: Parser.SyntaxNode | null) => declaration !== null);


    return variableDeclarationNodes.flatMap(declaration => {
      return [
        ...declaration.descendantsOfType('scalar_variable'),
        ...declaration.descendantsOfType('array_variable'),
        ...declaration.descendantsOfType('hash_variable'),
      ];
    });
  }

  public async getHoverContentAndRangeForNode(uri: string, line: number, column: number): Promise<string | null> {
    const node: Parser.SyntaxNode | null = await this.getNodeAtPoint(uri, line, column);

    if (!node) {
      return null;
    }

    node?.parent

    return node?.toString() || "";
  }
}

export default Analyzer;

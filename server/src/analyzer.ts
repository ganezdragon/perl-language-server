import * as Parser from 'web-tree-sitter';
import * as fs from 'fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Definition, Diagnostic, DiagnosticSeverity, ErrorCodes, InitializeParams, Location, Position, Range, ResponseError, SymbolInformation, SymbolKind, TextEdit, WorkspaceEdit, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';
import { getFilesFromPath } from './util/file';
import { forEachNode, forEachNodeAnalyze, getContinuousRangeForNodes, getListOfRangeForPackageStatements, getPackageNodeForNode, getRangeForNode, getRangeForURI } from './util/tree_sitter_utils';
import { AnalyzeMode, CachingStrategy, ExtensionSettings, FileDeclarations, ImportDetail, URIToTree } from './types/common.types';
import { fileURLToPath } from 'url';
import { extractSubroutineNameFromFullFunctionName } from './util/basic';

class Analyzer {
  // dependencies
  private parser: Parser;

  // other properties
  private uriToTree: URIToTree = new Map();
  private uriToVariableDeclarations: FileDeclarations = new Map();
  private uriToFunctionDeclarations: FileDeclarations = new Map();
  private uriToFunctionReferences: FileDeclarations = new Map();

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

    // reset when the file is being analyzed again
    // this.uriToVariableDeclarations[uri] = {};
    this.uriToFunctionDeclarations.set(uri, new Map());
    this.uriToFunctionReferences.set(uri, new Map());


    /**
     * Parses the tree and pushes into the problems array,
     * if a node is suspected missing in the tree.
     * 
     * @param node the syntax node
     */
    // function findMissingNodes(node: Parser.SyntaxNode) {

    //   if (node.isMissing) {
    //     problems.push(
    //       Diagnostic.create(
    //         getRangeForNode(node),
    //         `Syntax error: expected "${node.type}"`,
    //         DiagnosticSeverity.Error,
    //       ),
    //     );
    //   }
    //   else if (node.hasError) {
    //     node.children.forEach(findMissingNodes);
    //   }
    // }

    // if (getProblems) {
    //   // find missing nodes even if we are not showing ALL problems (as of now)
    //   findMissingNodes(tree.rootNode);
    // }

    // if (!settings.showAllErrors) {
    //   getProblems = false;
    // }

    if (getProblems) {
      // for each node do some analyses
      forEachNodeAnalyze(true, tree.rootNode, (node: Parser.SyntaxNode) => {
        if (node.isError) {
          problems.push(
            Diagnostic.create(
              getRangeForNode(node),
              `Syntax Error near expression ${node.text}`,
              DiagnosticSeverity.Error,
            )
          );
        }
        else if (node.isMissing) {
          problems.push(
            Diagnostic.create(
              getRangeForNode(node),
              `Syntax error: expected "${node.type}"`,
              DiagnosticSeverity.Error,
            ),
          );
        }
      });
    }

    this.extractAndSetDeclarationsFromFile(document, tree.rootNode);

    this.extractAndSetFunctionReferencesFromFile(document, tree.rootNode);

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

        return true;
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

  private extractAndSetFunctionReferencesFromFile(document: TextDocument, rootNode: Parser.SyntaxNode): void {
    const functionNodes: Parser.SyntaxNode[] = [
      ...rootNode.descendantsOfType('call_expression_with_args_with_brackets'),
      ...rootNode.descendantsOfType('call_expression_with_args_without_brackets'),
      ...rootNode.descendantsOfType('call_expression_with_variable'),
      ...rootNode.descendantsOfType('call_expression_with_spaced_args'),
      ...rootNode.descendantsOfType('call_expression_recursive'),
      ...rootNode.descendantsOfType('method_invocation'),
    ];

    functionNodes.forEach(functionNode => {
      const functionNameNode: Parser.SyntaxNode | null = functionNode.childForFieldName('function_name')
                                                            || functionNode.children[0].childForFieldName('function_name');

      if (!functionNameNode) {
        return;
      }
      const functionName: string = functionNameNode.text;
      const packageName: string = functionNode.descendantsOfType("package_name")[0]?.text || '';

      let namedReferences = this.uriToFunctionReferences.get(document.uri)?.get(functionName) || [];

      namedReferences.push(
        SymbolInformation.create(
          functionName,
          SymbolKind.Function,
          getRangeForNode(functionNameNode),
          document.uri,
          packageName,
        ),
      );

      const existingReferences = this.uriToFunctionReferences.get(document.uri);
      existingReferences?.set(functionName, namedReferences);
      if (existingReferences) {
        this.uriToFunctionReferences.set(document.uri, existingReferences);
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

      await Promise.all(
        filePaths.map(async (filePath) => {
          let fileContent: string;
          try {
            fileContent = await fs.readFile(filePath, { encoding: 'utf-8' });
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

            // connection.console.debug(`Analyzed file ${uri} , prob - ${problemsCounter}, fileC - ${fileCounter}, goal - ${totalFiles}, mem - ${process.memoryUsage().heapUsed / 1024 / 1024} MB`);
            
            let percentage: number = Math.round( (fileCounter / totalFiles) * 100 );
            progress.report(percentage, `in progress - ${percentage}%`);

          if (fileCounter === filePaths.length) {
              connection.console.info(`Analyzer finished after ${getTimePassed()}`);
              progress.done();
            }
          }
        })
      );
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
        fileContent = await fs.readFile(fileURLToPath(uri), { encoding: 'utf-8' });

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

    if (node.type.match(/_variable$/)) {
      const allVariablesAvailableForCurrentScope: Parser.SyntaxNode[] = this.getAllVariablesWithInScopeAtCurrentNode(uri, node);

      // just a set to uniquely get the first variable occurence.
      let uniqueVariableSet: Set<string> = new Set();

      allVariablesAvailableForCurrentScope.forEach(variable => {
        if (variable.text === identifierName && ! uniqueVariableSet.has(variable.text)) {

          uniqueVariableSet.add(variable.text);

          symbols.push(
            SymbolInformation.create(
              variable.text,
              SymbolKind.Variable,
              getRangeForNode(variable),
              uri,
              variable.parent?.text,
            ),
          );
        }
      })
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

  public findAllReferences(fileName: string, nodeAtPoint: Parser.SyntaxNode): Location[] {
    const symbols: SymbolInformation[] = [];

    const identifierName: string = nodeAtPoint.text;

    // first push the current nodeAtPoint itself as a reference
    symbols.push(
      SymbolInformation.create(
        nodeAtPoint.text,
        SymbolKind.Variable, // can be anything.
        getRangeForNode(nodeAtPoint),
        fileName,
        nodeAtPoint.parent?.text,
      ),
    );

    if (nodeAtPoint.type.match(/_variable$/)) {
      const allVariablesAvailableForCurrentScope: Parser.SyntaxNode[] = this.getAllVariablesWithInScopeAtCurrentNode(fileName, nodeAtPoint, true);

      allVariablesAvailableForCurrentScope.forEach(variable => {
        if (variable.text === identifierName) {
          symbols.push(
            SymbolInformation.create(
              variable.text,
              SymbolKind.Variable,
              getRangeForNode(variable),
              fileName,
              variable.parent?.text,
            ),
          );
        }
      });
    }
    // else its a function
    else {
      let packageToRefer: string = nodeAtPoint.parent?.descendantsOfType("package_name")[0]?.text || '';
      let allFunctionSymbolsMatchingName: SymbolInformation[] = [];

      this.uriToFunctionReferences.forEach((functionReferences, thisUri) => {
        const referenceNames: SymbolInformation[] = functionReferences?.get(identifierName) || [];
        allFunctionSymbolsMatchingName.push(...referenceNames);
      });

      // TODO: have references pick based on the package name properly
      // symbols.push(
      //   ...allFunctionSymbolsMatchingName.filter(functionSymbol => (functionSymbol.containerName === packageToRefer))
      // );
      symbols.push(...allFunctionSymbolsMatchingName);

      // add the function declaration as well
      this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
        const declarationNames: SymbolInformation[] = functionDeclarations?.get(identifierName) || [];
        declarationNames.forEach((declaration: SymbolInformation) => {
          symbols.push(declaration);
          // if (declaration.containerName === packageToRefer) {
          //   symbols.push(declaration);
          // }
        });
      });
      
    }

    return symbols.map(symbol => symbol.location);

  }

  public renameSymbol(fileName: string, nodeAtPoint: Parser.SyntaxNode, newName: string): WorkspaceEdit {
    if (nodeAtPoint.type.match(/_variable$/)) {
      return this.renameVariable(fileName, nodeAtPoint, newName);
    }

    else if (nodeAtPoint.parent?.type.match(/call_expression/) || nodeAtPoint.parent?.type.match(/function_definition/)) {
      return this.renameFunction(fileName, nodeAtPoint, newName);
    }

    throw new ResponseError(ErrorCodes.InvalidParams, 'Not a symbol to be renamed');
  }


  public renameFunction(fileName: string, nodeAtPoint: Parser.SyntaxNode, newName: string): WorkspaceEdit {
    // validate function name
    if (newName.length === 0) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Function name cannot be empty');
    }

    let renameChanges : {
      [uri: string]: TextEdit[];
    } = {};
    const functionName: string = nodeAtPoint.text;

    let allFunctionSymbolsMatchingName: SymbolInformation[] = [];

    this.uriToFunctionReferences.forEach((functionReferences, thisUri) => {
      const referenceNames: SymbolInformation[] = functionReferences?.get(functionName) || [];
      allFunctionSymbolsMatchingName.push(...referenceNames);
    });

    allFunctionSymbolsMatchingName.forEach(functionRef => {
      let additionalEditsInFile: TextEdit[] = renameChanges[functionRef.location.uri] || [];
      additionalEditsInFile.push(
        {
          newText: newName,
          range: functionRef.location.range
        }
      );
      renameChanges[functionRef.location.uri] = additionalEditsInFile;
    });

    // get the function declaration as well
    this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
      const declarationNames: SymbolInformation[] = functionDeclarations?.get(functionName) || [];
      declarationNames.forEach((declaration: SymbolInformation) => {
        let additionalEditsInFile: TextEdit[] = renameChanges[declaration.location.uri] || [];
        additionalEditsInFile.push(
          {
            newText: newName,
            range: declaration.location.range
          }
        );

        renameChanges[declaration.location.uri] = additionalEditsInFile;
      });
    });

    return {
      changes: renameChanges,      
    }

  }

  public renameVariable(fileName: string, nodeAtPoint: Parser.SyntaxNode, newName: string): WorkspaceEdit {
    // validate variable name
    if (newName.length === 0) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Variable name cannot be empty');
    }
    const allVariablesAvailableForCurrentScope: Parser.SyntaxNode[] = this.getAllVariablesWithInScopeAtCurrentNode(fileName, nodeAtPoint, true);

    let newTextEdits: TextEdit[] = [];

    allVariablesAvailableForCurrentScope.forEach(variable => {
      if (variable.text === nodeAtPoint.text) {
        newTextEdits.push(
          TextEdit.replace(
            getRangeForNode(variable),
            newName,
          )
        );
      }
    });
    return {
      changes: {
        [fileName]: newTextEdits,
      }
    };
  }

  public findFunctionDeclarationMatchingWord(word: string, currentURI: string): SymbolInformation[] {
    let prioritySymbolsMatchingWord: SymbolInformation[] = [];
    let symbolsMatchingWord: SymbolInformation[] = [];

    this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
      let onlyValues: SymbolInformation[] | undefined = Array.from(functionDeclarations.values()).at(0);

      // get the package completions
      if (onlyValues && onlyValues[0].containerName?.includes(word)) {
        symbolsMatchingWord.push(
          SymbolInformation.create(
            onlyValues[0].containerName,
            SymbolKind.Package,
            getRangeForURI(thisUri),
            thisUri,
            '',
          ),
        );
      }

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

  /**
   * Given a node, returns the outer block for the current node.
   * or null if not found (if no blocks in source code)
   * 
   * @param nodeAtPosition the node at the current position
   * @returns the outer block for the current node, if present
   */
  public getOuterBlockForCurrentNode(nodeAtPosition: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let outerBlockNode: Parser.SyntaxNode | null = null;

    while (nodeAtPosition.parent) {
      if (nodeAtPosition.type === 'block') {
        outerBlockNode = nodeAtPosition;
      }
      nodeAtPosition = nodeAtPosition.parent;
    }

    return outerBlockNode;
  }

  /**
   * Given a currentNode, returns all the root variables for the current file.
   * If its a block, it would skip all internal variables to it.
   * 
   * @param currentNode the currentNode
   * @returns returns all the root variables for the current file
   */
  public getRootVariablesInFile(currentNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const rootVariables: Parser.SyntaxNode[] = [];

    forEachNode(currentNode.tree.rootNode, (nodeInLoop) => {
      if (nodeInLoop.type.match(/_variable$/)) {
        rootVariables.push(nodeInLoop);
      }
      else if(nodeInLoop.type === 'block') {
        return false;
      }
      return true;
    });

    return rootVariables;
  }

  /**
   * Given a currentNode, returns all the variables for the current scope
   * 
   * @param uri the uri of the file
   * @param currentNode the currentNode
   * @returns returns all the variables availalbe from the current scope
   */
  public getAllVariablesWithInScopeAtCurrentNode(uri: string, currentNode: Parser.SyntaxNode, includeSucceedingVariables: boolean = false): Parser.SyntaxNode[] {
    let variableNodes: Parser.SyntaxNode[] = [];

    const outerBlockNode: Parser.SyntaxNode | null = this.getOuterBlockForCurrentNode(currentNode);

    const rootVariables: Parser.SyntaxNode[] = this.getRootVariablesInFile(currentNode);

    if (rootVariables.length > 0) {
      variableNodes = rootVariables;
    }

    if (outerBlockNode) {
      variableNodes.push(
        ...outerBlockNode.descendantsOfType('scalar_variable'),
        ...outerBlockNode.descendantsOfType('array_variable'),
        ...outerBlockNode.descendantsOfType('hash_variable'),
        ...outerBlockNode.descendantsOfType('special_scalar_variable'),
        ...outerBlockNode.descendantsOfType('typeglob'),
      );
    }

    if (includeSucceedingVariables) {
      return variableNodes;
    }

    return variableNodes.filter(variable => {
      return (
        variable.endPosition.row < currentNode.startPosition.row // above current row
        || (
          variable.endPosition.row === currentNode.startPosition.row    // or in same row but before current Node
          && variable.endPosition.column < currentNode.startPosition.column
        )
      )
    });    
  }

  public async getAdditionalEditsForFunctionImports(currentFileName: string, functionToImport: SymbolInformation): Promise<TextEdit[] | undefined> {
    // if same file function or no package, no need to import
    if (currentFileName === functionToImport.location.uri || !(functionToImport.containerName)) {
      return [];
    }

    let getAllPackagesAndRangesInCurrentFile: ImportDetail = await this.getImportStatementStringAndRangeInCurrentFile(currentFileName);

    // Find if package already imported
    // if it is full package, leave it.
    // else if has functions, add your function
    // else, add new package with that fn
    // replace package block in first Range, and then nullify all the Ranges

    let functionNameToImport: string = extractSubroutineNameFromFullFunctionName(functionToImport.name);

    let functionImportAlreadyExists: boolean = false;
    getAllPackagesAndRangesInCurrentFile.fnOnlyImportStatements.forEach((statement, index) => {
      if (statement.match(new RegExp(`${functionToImport.containerName}`))) {
        if (statement.match(new RegExp(`\\b${functionNameToImport}\\b`))) {
          functionImportAlreadyExists = true;
          return;
        }
        else {
          // if given `use Data::Dumper qw( Dumper Something ); ---> extracts only "Dumper" and "Something"
          let functionsInCurrentLine: string[] = statement.split('qw')[1].split('(')[1].split(')')[0].split(' ').filter(value => value !== '');
          functionsInCurrentLine.push(functionNameToImport);

          functionsInCurrentLine.sort();
          getAllPackagesAndRangesInCurrentFile.fnOnlyImportStatements[index] = `use ${functionToImport.containerName} qw( ${functionsInCurrentLine.join(' ')} );`;
          functionImportAlreadyExists = true;
        }
      }
    });

    if (!functionImportAlreadyExists) {
      getAllPackagesAndRangesInCurrentFile.fnOnlyImportStatements.push(`use ${functionToImport.containerName} qw( ${functionNameToImport} );`);
    }

    let newImportStatements: string = this.sortPackageBlocksInCurrentFile(getAllPackagesAndRangesInCurrentFile.fullImportStatements, getAllPackagesAndRangesInCurrentFile.fnOnlyImportStatements);

    let additionDeleteTextEdits: TextEdit[] = [];
    getAllPackagesAndRangesInCurrentFile.range.forEach((range, index) => {
      if (index > 0) {
        additionDeleteTextEdits.push(TextEdit.del(range));
      }
    });

    return [
      // {
      //   range: getAllPackagesAndRangesInCurrentFile.range[0],
      //   newText: newImportStatements,
      // },
      TextEdit.replace(Range.create(getAllPackagesAndRangesInCurrentFile.range[0].start, getAllPackagesAndRangesInCurrentFile.range[5].end), newImportStatements),
      // TextEdit.insert(getAllPackagesAndRangesInCurrentFile.range[0].start, newImportStatements),
      // ...additionDeleteTextEdits,
    ];
  }

  public getUsualBlockForPackagesInCurrentFile(currentFileName: string): Range {
    const currentTree: Parser.Tree = this.uriToTree.get(currentFileName) as Parser.Tree;

    currentTree

    return Range.create(
     0,0,0,0
    )
  }

  public sortPackageBlocksInCurrentFile(fullImportPackages: string[], fnOnlyImportPackages: string[]): string {

    const packagesToBeAtTop: string[] = [
      'strict',
      'warnings',
    ];

    let fullPackagesAtTop: string[] = fullImportPackages.filter((importString, index) => {
      // if its `use strict;` ---> then gets only "strict"
      if (packagesToBeAtTop.includes(importString.split(' ')[1].split(';')[0])) {
        return true;
      }
    })

    fullImportPackages = fullImportPackages.filter(importString => !packagesToBeAtTop.includes(importString.split(' ')[1].split(';')[0]));

    let fnOnlyPackageAtTop = fnOnlyImportPackages.filter((importString, index) => {
      if (packagesToBeAtTop.includes(importString.split(' ')[1].split(';')[0])) {
        return true;
      }
    });

    fnOnlyImportPackages = fnOnlyImportPackages.filter(importString => !packagesToBeAtTop.includes(importString.split(' ')[1].split(';')[0]));
    
    return fullPackagesAtTop.sort().join('\n')
      + ((fullPackagesAtTop.length > 0) ? "\n\n" : '')
      + fnOnlyPackageAtTop.sort().join('\n')
      + ((fnOnlyPackageAtTop.length > 0) ? "\n\n" : '')
      + fullImportPackages.sort().join('\n')
      + ((fullImportPackages.length > 0) ? "\n\n" : '')
      + fnOnlyImportPackages.sort().join('\n');
  }

  /**
   * Given a fileName, returns the string and range for the import statement
   */
  public async getImportStatementStringAndRangeInCurrentFile(fileName: string): Promise<ImportDetail> {
    const allPackageImportsInCurrentFile: Parser.SyntaxNode[] = await this.getAllPackageNodesInCurrentFile(fileName);

    let fullImportStatements: string[] = [];
    let fnOnlyImportStatements: string[] = [];
    let ranges: Range [] = [];

    allPackageImportsInCurrentFile.forEach((statement: Parser.SyntaxNode, index: number) => {
      if (statement.child(2)?.type === 'word_list_qw') {
        fnOnlyImportStatements.push(statement.text);
      }
      else {
        fullImportStatements.push(statement.text);
      }

      ranges.push(getRangeForNode(statement));
      
    });

    return {
      fullImportStatements: fullImportStatements,
      fnOnlyImportStatements: fnOnlyImportStatements,
      range: ranges,
    };

  }

  public async getPackageNameImportedForCurrentNode(currentFileName: string, functionToImport: SymbolInformation): Promise<Parser.SyntaxNode | undefined> {
    const allPackageImportsInCurrentFile: Parser.SyntaxNode[] = await this.getAllPackageNodesInCurrentFile(currentFileName);

    return allPackageImportsInCurrentFile.find(importNode => {
      if (importNode.childForFieldName('package_name')?.text === functionToImport.containerName) {
        return importNode;
      }
    });
  }

  public async getAllPackageNodesInCurrentFile(fileName: string): Promise<Parser.SyntaxNode[]> {
    const currentTree: Parser.Tree | undefined = await this.getTreeFromURI(fileName);

    if (!currentTree) {
      return [];
    }
    return [
      ...currentTree.rootNode.descendantsOfType('use_no_statement'),
      ...currentTree.rootNode.descendantsOfType('use_no_if_statement'),
      ...currentTree.rootNode.descendantsOfType('bareword_import'),
      ...currentTree.rootNode.descendantsOfType('use_no_subs_statement'),
      ...currentTree.rootNode.descendantsOfType('use_no_feature_statement'),
      ...currentTree.rootNode.descendantsOfType('use_no_version'),
      // ...currentTree?.rootNode.descendantsOfType('require_statement'),
    ];
  }

  public async getHoverContentForNode(uri: string, line: number, column: number): Promise<string | null> {
    const nodeAtPoint: Parser.SyntaxNode | null = await this.getNodeAtPoint(uri, line, column);

    if (!nodeAtPoint) {
      return null;
    }

    if (nodeAtPoint.type.match(/_variable$/)) {
      // removing indentation, so that it renders that way
      return `
    my ${nodeAtPoint.text}; # ${nodeAtPoint.type}`;
    }

    else if (nodeAtPoint.parent?.type.match(/call_expression/)) {
      return `
    sub ${nodeAtPoint.parent.text}; # function`;
    }

    return null;
  }
}

export default Analyzer;

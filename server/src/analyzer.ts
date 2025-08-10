import * as fs from 'fs/promises';
import * as path from 'path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Definition, Diagnostic, DiagnosticSeverity, DocumentSymbol, ErrorCodes, InitializeParams, Location, Position, Range, ResponseError, SymbolInformation, SymbolKind, TextEdit, WorkspaceEdit, WorkspaceSymbol, } from 'vscode-languageserver/node';
import * as Parser from 'web-tree-sitter';
import { AnalyzeMode, CachingStrategy, ExtensionSettings, FileDeclarations, FunctionReference, ImportDetail, URIToTree } from './types/common.types';
import { getFilesFromPath } from './util/file';
import { getGlobPattern } from './util/perl_utils';
import { forEachNode, forEachNodeAnalyze, getFunctionNameRangeFromDeclarationRange, getIdentifierPositionWithinPosition, getPackageNodeForNode, getRangeForNode, getRangeForURI } from './util/tree_sitter_utils';

import { fileURLToPath } from 'url';
import { createFunctionRefKey, extractSubroutineNameFromFullFunctionName, parseFunctionRefKey } from './util/basic';

class Analyzer {
  // dependencies
  private parser: Parser;

  // other properties
  private uriToTree: URIToTree = new Map();
  private uriToVariableDeclarations: FileDeclarations = new Map();
  private uriToFunctionDeclarations: Map<string, FunctionReference[]> = new Map();;
  private uriToFunctionReferences: Map<string, Map<string, FunctionReference[]>> = new Map();

  private workspaceFolder: string = '';

  /**
   * The constructor which injects the dependencies
   */
  constructor(parser: Parser, workspaceFolder: string) {
    this.parser = parser;
    this.workspaceFolder = workspaceFolder;
  }

  private async saveFunctionMapToFile(): Promise<void> {
    try {
      const functionMapPath = path.join(fileURLToPath(this.workspaceFolder), '.vscode', 'function_map.zip');

      await fs.mkdir(path.dirname(functionMapPath), { recursive: true });
      
      // Convert Maps to plain objects for JSON serialization
      const dataToSave = {
        uriToFunctionDeclarations: Object.fromEntries(this.uriToFunctionDeclarations),
        functionReference: Object.fromEntries(this.uriToFunctionReferences),
      };
      
      // Convert to JSON string and compress using Brotli (better compression than gzip)
      const compressedData: Buffer = brotliCompressSync(JSON.stringify(dataToSave));
      
      // Write the compressed data to file
      await fs.writeFile(functionMapPath, compressedData);

      console.log('Function map saved successfully');
      
    } catch (error) {
      console.error('Error saving function map:', error);
    }
  }

  private async loadFunctionMapFromFile(): Promise<boolean> {
    try {
      const functionMapPath = path.join(fileURLToPath(this.workspaceFolder), '.vscode', 'function_map.zip');
      const compressedData: Buffer = await fs.readFile(functionMapPath);
      const decompressedBuffer: Buffer = brotliDecompressSync(compressedData);
      const data = JSON.parse(decompressedBuffer.toString('utf8'));

      this.uriToFunctionDeclarations = new Map(Object.entries(data.uriToFunctionDeclarations || {}));
      this.uriToFunctionReferences = new Map(Object.entries(data.functionReference || {}));

      return true;
    } catch (error) {
      console.info('Loading function map:', error);
      return false;
    }
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
    this.uriToVariableDeclarations.set(uri, new Map());

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

    this.extractAndSetDeclarationsAndReferencesFromFile(document, tree.rootNode);

    // free up those heap memory
    tree.delete();

    return problems;

  }

  /**
   * Extracts and sets both function declarations and references from the syntax tree in a single pass.
   * Replaces extractAndSetDeclarationsFromFile and extractAndSetFunctionReferencesFromFile.
   * @function extractAndSetDeclarationsAndReferencesFromFile
   * @param document the current perl document
   * @param rootNode the rootNode of the syntax tree
   */
  private extractAndSetDeclarationsAndReferencesFromFile(document: TextDocument, rootNode: Parser.SyntaxNode): void {
    const uri = document.uri;
    const functionDefs: FunctionReference[] = [];
    const functionRefs: Map<string, FunctionReference[]> = new Map();

    this.uriToFunctionDeclarations.set(uri, []);
    this.uriToFunctionReferences.set(uri, new Map());

    // Single pass through all relevant nodes
    const nodes = rootNode.descendantsOfType([
      'function_definition',
      'call_expression_with_args_with_brackets',
      'call_expression_with_args_without_brackets',
      'call_expression_with_variable',
      'call_expression_with_spaced_args',
      'call_expression_recursive',
      'method_invocation',
    ]);

    for (const node of nodes) {
      // Function definition
      if (node.type === 'function_definition') {
        const functionNameNode = node.childForFieldName('name');
        if (!functionNameNode) continue;

        functionDefs.push({
          uri,
          functionName: functionNameNode.text,
          packageName: getPackageNodeForNode(node)?.descendantsOfType("package_name")[0]?.text || '',
          position: {
            startRow: functionNameNode.startPosition.row,
            startColumn: functionNameNode.startPosition.column,
            endRow: functionNameNode.endPosition.row,
            endColumn: functionNameNode.endPosition.column,
          },
        });
      }
      // Function reference
      else {
        const functionNameNode = node.childForFieldName('function_name') ||
          node.children[0]?.childForFieldName('function_name');
        if (!functionNameNode) continue;

        const functionName = functionNameNode.text;
        const functionRef: FunctionReference = {
          uri,
          functionName,
          packageName: node.descendantsOfType("package_name")[0]?.text || '',
          position: {
            startRow: functionNameNode.startPosition.row,
            startColumn: functionNameNode.startPosition.column,
            endRow: functionNameNode.endPosition.row,
            endColumn: functionNameNode.endPosition.column,
          },
        };

        const existingRefsForSameFn: FunctionReference[] = functionRefs.get(functionName) || [];
        existingRefsForSameFn.push(functionRef);
        functionRefs.set(functionName, existingRefsForSameFn);
      }
    }

    // Update function declarations
    this.uriToFunctionDeclarations.set(uri, functionDefs);
    this.uriToFunctionReferences.set(uri, functionRefs);
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

    // time out for 5 seconds
    // setTimeout(() => {
    //   this.loadFunctionMapFromFile();
    //   console.log('Timeout reached');
    // }, 5000);

    // first load cached map if available
    const hasLoadedMap = await this.loadFunctionMapFromFile();

    const workspaceFolders: InitializeParams['workspaceFolders'] = params.workspaceFolders;
    if (workspaceFolders) {
      const progress = await connection.window.createWorkDoneProgress();
      if (hasLoadedMap) {
        progress.begin('Re-indexing perl files', 0, 'Starting up...', undefined);
      }
      else {
        progress.begin('(Please wait) Indexing perl files', 0, 'Starting up...', undefined);
      }

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

      for (const filePath of filePaths) {
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

            connection.console.debug(`Analyzed file ${uri} , prob - ${problemsCounter}, fileC - ${fileCounter}, goal - ${totalFiles}, mem - ${process.memoryUsage().heapUsed / 1024 / 1024} MB , time passed - ${getTimePassed()}`);

            let percentage: number = Math.round((fileCounter / totalFiles) * 100);
            progress.report(percentage, `in progress - ${percentage}%`);

            if (fileCounter === filePaths.length) {
              connection.console.info(`Analyzer finished after ${getTimePassed()}`);
              progress.done();
            }
          }
      }

      this.saveFunctionMapToFile();
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
    if (!this.uriToTree.has(uri)) {
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
        if (variable.text === identifierName && !uniqueVariableSet.has(variable.text)) {

          uniqueVariableSet.add(variable.text);

          symbols.push(
            SymbolInformation.create(
              variable.text,
              SymbolKind.Variable,
              getRangeForNode(variable),
              uri,
              variable.parent?.text
            ),
          );
        }
      })
    }
    // else should be a function
    else {
      this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
        functionDeclarations.forEach(declaration => {
          if (declaration.functionName === identifierName) {
            symbols.push(
              SymbolInformation.create(
                declaration.functionName,
                SymbolKind.Function,
                Range.create(
                  Position.create(declaration.position.startRow, declaration.position.startColumn),
                  Position.create(declaration.position.endRow, declaration.position.endColumn)
                ),
                thisUri,
                declaration.packageName,
              ),
            );
          }
        });
      });
    }

    return symbols.map(symbol => symbol.location);
  }

  public async findAllReferences(fileName: string, nodeAtPoint: Parser.SyntaxNode, onlyCurrentFile: boolean = false): Promise<Location[]> {
    const locations: Location[] = [];
    const identifierName: string = nodeAtPoint.text;

    // Add the current node as a reference
    // NOTE: this might be needed, so uncommented. Remove if true.
    // locations.push(Location.create(fileName, getRangeForNode(nodeAtPoint)));

    if (nodeAtPoint.type.match(/_variable$/)) {
      const allVariablesAvailableForCurrentScope: Parser.SyntaxNode[] = this.getAllVariablesWithInScopeAtCurrentNode(fileName, nodeAtPoint, true);
      allVariablesAvailableForCurrentScope.forEach(variable => {
        if (variable.text === identifierName) {
          locations.push(Location.create(fileName, getRangeForNode(variable)));
        }
      });
    }
    else if (
      nodeAtPoint.parent?.type.match(/call_expression/)
      || nodeAtPoint.parent?.type.match(/method_invocation/)
      || nodeAtPoint.parent?.type.match(/function_definition/)
    ) {
      if (onlyCurrentFile) {
        this.uriToFunctionReferences.get(fileName)?.forEach((functionRefs: FunctionReference[], functionName: string) => {
          if (functionName === identifierName) {
            functionRefs.forEach(ref => {
              locations.push(Location.create(fileName, Range.create(
                ref.position.startRow,
                ref.position.startColumn,
                ref.position.endRow,
                ref.position.endColumn
              )));
            });
          }
        });
      }
      else {
        // Function: get all FunctionReference for this function name
        this.uriToFunctionReferences.forEach((functionRefMap, uri) => {
          functionRefMap?.get(identifierName)?.forEach(ref => {
            locations.push(Location.create(ref.uri, Range.create(
              ref.position.startRow,
              ref.position.startColumn,
              ref.position.endRow,
              ref.position.endColumn
            )));
          });
        });
      }
      // add the function declaration as well
      if (onlyCurrentFile) {
        this.uriToFunctionDeclarations.get(fileName)?.forEach((declaration: FunctionReference) => {
          if (declaration.functionName === identifierName) {
            locations.push(Location.create(fileName, Range.create(
              declaration.position.startRow,
              declaration.position.startColumn,
              declaration.position.endRow,
              declaration.position.endColumn
            )));
          }
        });
      }
      else {
        this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
          functionDeclarations.forEach((declaration) => {
            if (declaration.functionName === identifierName) {
              locations.push(Location.create(thisUri, Range.create(
                declaration.position.startRow,
                declaration.position.startColumn,
                declaration.position.endRow,
                declaration.position.endColumn
              )));
            }
          });
        });
      }
    }
    return locations;
  }

  public async renameSymbol(fileName: string, nodeAtPoint: Parser.SyntaxNode, newName: string): Promise<WorkspaceEdit> {
    if (nodeAtPoint.type.match(/_variable$/)) {
      return this.renameVariable(fileName, nodeAtPoint, newName);
    }

    else if (nodeAtPoint.parent?.type.match(/call_expression/) || nodeAtPoint.parent?.type.match(/method_invocation/) || nodeAtPoint.parent?.type.match(/function_definition/)) {
      return this.renameFunction(fileName, nodeAtPoint, newName);
    }

    throw new ResponseError(ErrorCodes.InvalidParams, 'Not a symbol to be renamed');
  }


  public async renameFunction(fileName: string, nodeAtPoint: Parser.SyntaxNode, newName: string): Promise<WorkspaceEdit> {
    if (newName.length === 0) {
      throw new ResponseError(ErrorCodes.InvalidParams, 'Function name cannot be empty');
    }

    let renameChanges: {
      [uri: string]: TextEdit[];
    } = {};
    const functionName: string = nodeAtPoint.text;

    // Get all FunctionReferences for this function name
    this.uriToFunctionReferences.forEach(async (functionRefs, uri) => {
      functionRefs?.get(functionName)?.forEach(async ref => {
        let additionalEditsInFile: TextEdit[] = renameChanges[uri] || [];
        const tree = await this.getTreeFromURI(uri);
        additionalEditsInFile.push({
          newText: newName,
          range: getFunctionNameRangeFromDeclarationRange(tree!, ref.position.startRow, ref.position.startColumn, ref.position.endRow, ref.position.endColumn)
        });
        renameChanges[uri] = additionalEditsInFile;
      });
    });

    // get the function declaration as well
    this.uriToFunctionDeclarations.forEach((functionDeclarations, thisUri) => {
      functionDeclarations.forEach(async (declaration) => {
        if (declaration.functionName === functionName) {
          let additionalEditsInFile: TextEdit[] = renameChanges[thisUri] || [];
          const tree = await this.getTreeFromURI(thisUri);
          additionalEditsInFile.push({
            newText: newName,
            range: getFunctionNameRangeFromDeclarationRange(tree!, declaration.position.startRow, declaration.position.startColumn, declaration.position.endRow, declaration.position.endColumn)
          });
          renameChanges[thisUri] = additionalEditsInFile;
        }
      });
    });

    return {
      changes: renameChanges,
    }
  }

  public async renameVariable(fileName: string, nodeAtPoint: Parser.SyntaxNode, newName: string): Promise<WorkspaceEdit> {
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
      let onlyValues: FunctionReference | undefined = Array.from(functionDeclarations.values()).at(0);

      // get the package completions
      // we could get the first element, since packageName is unique per uri
      if (onlyValues?.packageName?.toLowerCase().includes(word.toLowerCase())) {
        symbolsMatchingWord.push(
          SymbolInformation.create(
            onlyValues.packageName,
            SymbolKind.Package,
            getRangeForURI(thisUri),
            thisUri,
            '',
          ),
        );
      }

      functionDeclarations.forEach(declaration => {
        if (declaration.functionName.toLowerCase().includes(word.toLowerCase())) {
          // if the function is current URI, then put it in priority list
          if (currentURI === thisUri) {
            prioritySymbolsMatchingWord.push(
              SymbolInformation.create(
                declaration.functionName,
                SymbolKind.Function,
                Range.create(
                  declaration.position.startRow,
                  declaration.position.startColumn,
                  declaration.position.endRow,
                  declaration.position.endColumn
                ),
                declaration.uri,
                declaration.packageName,
              ),
            );
          }
          else {
            symbolsMatchingWord.push(
              SymbolInformation.create(
                declaration.functionName,
                SymbolKind.Function,
                Range.create(
                  declaration.position.startRow,
                  declaration.position.startColumn,
                  declaration.position.endRow,
                  declaration.position.endColumn
                ),
                declaration.uri,
                declaration.packageName,
              ),
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
      else if (nodeInLoop.type === 'block') {
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
      0, 0, 0, 0
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
    let ranges: Range[] = [];

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

  public async getAllSymbolsForFile(fileName: string): Promise<DocumentSymbol[]> {
    const symbols: DocumentSymbol[] = [];

    this.uriToFunctionDeclarations.get(fileName)?.forEach((functionDeclarations: FunctionReference) => {
      symbols.push(
        DocumentSymbol.create(
          functionDeclarations.functionName,
          '',
          SymbolKind.Function,
          Range.create(
            Position.create(functionDeclarations.position.startRow, functionDeclarations.position.startColumn),
            Position.create(functionDeclarations.position.endRow, functionDeclarations.position.endColumn),
          ),
          Range.create(
            Position.create(functionDeclarations.position.startRow, functionDeclarations.position.startColumn),
            Position.create(functionDeclarations.position.endRow, functionDeclarations.position.endColumn),
          ),
          [],
        )
      );
    });
    
    return symbols;
  }

  public async getAllSymbolsMatchingWord(word: string): Promise<WorkspaceSymbol[]> {
    const symbols: WorkspaceSymbol[] = [];

    this.uriToFunctionDeclarations.forEach((functionDeclarations: FunctionReference[], uri: string) => {
      functionDeclarations.forEach(functionDeclaration => {
        if (functionDeclaration.functionName.toLowerCase().includes(word.toLowerCase())) {
          symbols.push(
            WorkspaceSymbol.create(
              functionDeclaration.functionName,
              SymbolKind.Function,
              uri,
              Range.create(
                Position.create(functionDeclaration.position.startRow, functionDeclaration.position.startColumn),
                Position.create(functionDeclaration.position.endRow, functionDeclaration.position.endColumn),
              ),
            )
          );
        }
      });
    });
    
    return symbols;
  }
  /**
   * Cleans up all cached data for a given URI. Call this when a document is closed to prevent memory leaks.
   * Usage: In your language server, call analyzer.cleanup(uri) from the onDidClose handler.
   */
  public cleanup(uri: string): void {
    this.uriToTree.delete(uri);
    this.uriToVariableDeclarations.delete(uri);
    this.uriToFunctionDeclarations.delete(uri);
    this.uriToFunctionReferences.delete(uri);
  }
}

export default Analyzer;

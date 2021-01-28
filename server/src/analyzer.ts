import * as Parser from 'web-tree-sitter';
import { promises as fs } from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, Diagnostic, InitializeParams, Range, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';
import { getFilesFromPath } from './util/file';

class Analyzer {
  private parser: Parser;

  /**
   * The constructor
   */
  constructor(parser: Parser) {
    this.parser = parser;
  }

  async analyze(document: TextDocument): Promise<Diagnostic[]> {
    let problems: Diagnostic[] = [];
    const content = document.getText();


    try {
      let tree = this.parser.parse(content);

      console.log(tree.rootNode);

      problems.push(Diagnostic.create(Range.create(1,2,3,4), "failed to parse",2));
    }
    catch (error) {
      console.log(error);
    }

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

      for (const folder of workspaceFolders) {
        connection.console.log(
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
          connection.console.log(
            `Glob resolved with ${filePaths.length} files after ${getTimePassed()}`,
          )
        }
      }

      for (const filePath of filePaths) {
        const uri = `file://${filePath}`
        connection.console.log(`Analyzing ${uri}`)

        try {
          const fileContent = await fs.readFile(filePath, 'utf8')
          analyzer.analyze(TextDocument.create(uri, 'perl', 1, fileContent));
        } catch (error) {
          connection.console.warn(`Failed analyzing ${uri}. Error: ${error.message}`)
        }
      }

      connection.console.log(`Analyzer finished after ${getTimePassed()}`)
    }

    return analyzer;
  }
}

export default Analyzer;

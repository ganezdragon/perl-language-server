import * as Parser from 'web-tree-sitter';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection, InitializeParams, } from 'vscode-languageserver/node';
import { getGlobPattern } from './util/perl_utils';


class Analyzer {
  private parser: Parser;

  /**
   * The constructor
   */
  constructor(parser: Parser) {
    this.parser = parser;
  }

  async analyze(document: TextDocument): Promise<any> {
    let content = document.getText();

    try {
      let tree = this.parser.parse(content);

      console.log(tree);
    }
    catch (error) {
      console.log(error);
    }
    
  }

  public static async analyzeFromWorkspace(connection: Connection, rootPath: InitializeParams['workspaceFolders'], parser: Parser): Promise<Analyzer> {
    const analyzer: Analyzer = new Analyzer(parser);

    // if (rootPath) {
    //   const globPattern = getGlobPattern()
    //   connection.console.log(
    //     `Analyzing files matching glob "${globPattern}" inside ${rootPath}`,
    //   )

    //   const lookupStartTime = Date.now()
    //   const getTimePassed = (): string =>
    //     `${(Date.now() - lookupStartTime) / 1000} seconds`

    //   let filePaths: string[] = []
    //   try {
    //     filePaths = await getFIlePaths({ globPattern, rootPath })
    //   } catch (error) {
    //     connection.window.showWarningMessage(
    //       `Failed to analyze bash files using the glob "${globPattern}". The experience will be degraded. Error: ${error.message}`,
    //     )
    //   }

    //   // TODO: we could load all files without extensions: globPattern: '**/[^.]'

    //   connection.console.log(
    //     `Glob resolved with ${filePaths.length} files after ${getTimePassed()}`,
    //   )

    //   for (const filePath of filePaths) {
    //     const uri = `file://${filePath}`
    //     connection.console.log(`Analyzing ${uri}`)

    //     try {
    //       const fileContent = await readFileAsync(filePath, 'utf8')
    //       const shebang = getShebang(fileContent)
    //       if (shebang && !isBashShebang(shebang)) {
    //         connection.console.log(`Skipping file ${uri} with shebang "${shebang}"`)
    //         continue
    //       }

    //       analyzer.analyze(uri, LSP.TextDocument.create(uri, 'shell', 1, fileContent))
    //     } catch (error) {
    //       connection.console.warn(`Failed analyzing ${uri}. Error: ${error.message}`)
    //     }
    //   }

    //   connection.console.log(`Analyzer finished after ${getTimePassed()}`)
    // }

    return analyzer;
  }
}

export default Analyzer;

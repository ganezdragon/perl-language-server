import Parser = require('web-tree-sitter');

async function initializeParser(): Promise<Parser> {
  await Parser.init();
  const parser: Parser = new Parser();

  // Keep the WebAssembly-based parser here instead of switching to the native
  // `tree-sitter` package. The WASM build is easier to ship inside the VS Code
  // extension and avoids platform-specific native module packaging issues.
  const lang = await Parser.Language.load(`${__dirname}/../tree-sitter-perl.wasm`);
  
  parser.setLanguage(lang);

  // const logger: Parser.Logger = (message, params, type) => {
  //   // fs.appendFile(`log.log`, `type - ${type}, message - ${message}`, (err) => {});
  // };
  // parser.setLogger(logger);
  return parser;
}

export {
  initializeParser
}

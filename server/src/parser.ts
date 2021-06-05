import * as Parser from 'web-tree-sitter';

async function initializeParser(): Promise<Parser> {
  await Parser.init();
  const parser: Parser = new Parser();

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

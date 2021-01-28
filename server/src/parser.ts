import * as Parser from 'web-tree-sitter'

async function initializeParser(): Promise<Parser> {
  await Parser.init();
  const parser: Parser = new Parser();

  const lang = await Parser.Language.load(`${__dirname}/../tree-sitter-perl.wasm`);
  
  parser.setLanguage(lang);
  return parser;
}

export {
  initializeParser
}

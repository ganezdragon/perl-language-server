import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient';

let client: LanguageClient;

function activate(context: ExtensionContext) {
  // The server path
  const serverModule = context.asAbsolutePath(
    path.join('server', 'out', 'server.js')
  );

  // The debug options for the server
	// --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

  // The server stuffs
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };

  // our client
  const clientOptions: LanguageClientOptions = {
    // Register the server for perl files
    documentSelector: [{ scheme: 'file', language: 'perl' }],
    synchronize: {
      // Notify the server about files changes to '.clientrc' files contained in the workspace
      fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
    }
  };

  // The languageClient object creation
  client = new LanguageClient(
    'perl lsp client',
    serverOptions,
    clientOptions,
  );

  // Start the client, which also starts the server.
  client.start();
}

export {
  activate
};


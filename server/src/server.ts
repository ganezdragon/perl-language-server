/**
 * Just create connection and destroy connection here,
 * Other perl language core server features would be implemented in
 * the perlServer.ts file.
 */
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createConnection, DidChangeConfigurationNotification, InitializeParams, InitializeResult, ProposedFeatures, TextDocuments, TextDocumentSyncKind } from 'vscode-languageserver/node';
import PerlServer from './perlServer';

const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// Create the connection for the server
const connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true,
				triggerCharacters: ["$", "@", "%", ".", ":", "::"],
				completionItem: {
					labelDetailsSupport: true,
				}
			},

			// goto definition
			definitionProvider: true,

			hoverProvider: true,

			// goto implementation
			implementationProvider: false,

			referencesProvider: true,
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}

	// Initialize the Perl Server
	connection.console.info(`Initializing the Perl Language Server`);

	PerlServer.initialize(connection, documents, params)
		.then(server => {
			server.register(capabilities);
		});

	connection.console.info(`Perl Language Server initialized`);

	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.info('Workspace folder change event received.');
		});
	}
});


connection.onDidChangeConfiguration((change) => {
	// if (hasConfigurationCapability) {
	// 	// Reset all cached document settings
	// 	documentSettings.clear();
	// } else {
	// 	globalSettings = <ExtensionSettings>(
	// 		(change.settings.languageServerExample || defaultSettings)
	// 	);
	// }

	// Revalidate all open text documents
	// documents.all().forEach(validateTextDocument);
});

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.info('We received an file change event on a watched file');
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

//Listen on the connection
connection.listen();

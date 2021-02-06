import { createConnection, DidChangeConfigurationNotification, InitializeParams, InitializeResult, ProposedFeatures, TextDocumentSyncKind } from 'vscode-languageserver/node';
import PerlServer from './perlServer';

// Create the connection for the server
const connection = createConnection(ProposedFeatures.all);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

let server: PerlServer;

connection.onInitialize(async (params: InitializeParams) => {
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
			// completionProvider: {
			// 	resolveProvider: true
			// },

			// // goto definition
			// definitionProvider: true,
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

	server = await PerlServer.initialize(connection, params);
	server.register(connection);

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


connection.onDidChangeConfiguration(() => {
	// if (hasConfigurationCapability) {
	// 	// Reset all cached document settings
	// 	documentSettings.clear();
	// } else {
	// 	globalSettings = <ExampleSettings>(
	// 		(change.settings.languageServerExample || defaultSettings)
	// 	);
	// }

	// Revalidate all open text documents
	// documents.all().forEach(validateTextDocument);
});

// TODO: make use of this
// function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
// 	if (!hasConfigurationCapability) {
// 		return Promise.resolve(globalSettings);
// 	}
// 	let result = documentSettings.get(resource);
// 	if (!result) {
// 		result = connection.workspace.getConfiguration({
// 			scopeUri: resource,
// 			section: 'languageServerExample'
// 		});
// 		documentSettings.set(resource, result);
// 	}
// 	return result;
// }

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.info('We received an file change event on a watched file');
});

//Listen on the connection
connection.listen();

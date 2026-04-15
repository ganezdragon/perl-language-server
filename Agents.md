# Agents

This repository is a VS Code extension for Perl with a TypeScript client and a TypeScript language/debug server.

## Project Layout

- `client/`: VS Code extension entrypoint and client integration.
- `server/`: language server, parser/analyzer code, debugger adapter, snippets, and utilities.
- `asset/`: README/demo media.
- `language-configuration.json`: VS Code language configuration for Perl.
- `package.json`: root extension manifest, contributed settings, activation events, and build scripts.

## Key Entry Points

- `client/src/extension.ts`: extension activation and client startup.
- `server/src/server.ts`: language server bootstrap.
- `server/src/perlServer.ts`: core server behavior.
- `server/src/parser.ts`: parsing pipeline.
- `server/src/analyzer.ts`: semantic analysis.
- `server/src/debugger/debugAdapter.ts`: debug adapter entrypoint.
- `server/src/debugger/perlDebugSession.ts`: Perl debug session behavior.

## Common Commands

Run from the repository root unless noted otherwise.

- `npm run compile`: build the client and server TypeScript projects.
- `npm run watch`: incremental TypeScript build.
- `npm run clean`: remove `client/out` and `server/out`.
- `npm run postinstall`: install nested `client` and `server` dependencies.

## Development Notes

- The extension activates on Perl files and debug usage (`onLanguage:perl`, `onDebug`).
- The debugger targets Perl through the built-in `perl -d` flow.
- Debugging support expects `PadWalker` to be available in the Perl environment.
- The server uses `web-tree-sitter` and ships `server/tree-sitter-perl.wasm`.
- Extension settings and debugger contribution metadata live in the root `package.json`.

## Editing Guidelines

- Keep changes scoped to the correct layer:
  - VS Code UX, activation, commands, and client wiring belong in `client/`.
  - Parsing, language features, workspace analysis, and debugger internals belong in `server/`.
- Preserve existing TypeScript project boundaries instead of collapsing code into the root package.
- If behavior changes affect user-visible configuration or debugging, update `README.md` and root `package.json` contributions together.
- Avoid changing generated or dependency files unless the task requires it.

## Verification

- Prefer `npm run compile` after code changes.
- If debugger behavior changes, validate the contributed debug type remains `perl` and the adapter still builds from `server/out/debugger/debugAdapter.js`.

## Known Constraints

- Windows support is currently not guaranteed.
- Large workspaces may stress caching or WebAssembly memory usage.
- Some parser-driven features are still experimental when `perl.showAllErrors` is enabled.

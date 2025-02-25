# Perl IDE

A simple perl language server written in typescript, with a client that's also written in typescript. Intended to be used with vs code, but could be extended.

## Features

- Syntax check
- Goto Function definition
- Goto Variable definition
- Variable autocomplete
- Function autocomplete
- Rename symbol
- Find all references
- Hover provider
- Symbol highlighting


## Upcoming features
- Integrated debugger
- Much more to come

## Requirements

Nothing, nada, nyet!

## Extension Settings

This extension contributes the following settings:

* `perl.maxNumberOfProblems`: Controls the maximum number of problems produced by the server.

## Known Issues

- `Webassembly.Memory(): could not allocate memory`
  - Its a problem with your node runtime, either upgrade your nodejs
  - Or, check out your `ulimit`. Further reading - https://stackoverflow.com/questions/52406217/why-cant-i-construct-webassembly-memory-in-browsers

## Release Notes

### 2.0.0

alpha release, with usable features.

### 0.0.1

Very beta, testing out the integration

### 0.1.0

Somewhat beta, will work my way up to release further stable releases

-----------------------------------------------------------------------------------------------------------

# Electron's version.
export npm_config_target=11.4.1
# The architecture of Electron, see https://electronjs.org/docs/tutorial/support#supported-platforms
# for supported architectures.
# export npm_config_arch=darwin
# Download headers for Electron.
export npm_config_disturl=https://atom.io/download/atom-shell
# Tell node-pre-gyp that we are building for Electron.
export npm_config_runtime=electron
# Tell node-pre-gyp to build module from source code.
export npm_config_build_from_source=true
# Install all dependencies, and store cache to ~/.electron-gyp.
cd node_modules/tree-sitter
HOME=~/.electron-gyp node-gyp rebuild

cd ../../node_modules/@ganezdragon/tree-sitter-perl
HOME=~/.electron-gyp node-gyp rebuild

echo "npm config set up for server/"
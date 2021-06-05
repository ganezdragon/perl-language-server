import * as fGlob from 'fast-glob';

async function getFilesFromPath(rootPath: string, globPattern: string): Promise<string[]> {
  // return glob.sync(globPattern, { absolute: true, cwd: rootPath });
  return fGlob.sync(globPattern, { absolute: true });
}

export {
  getFilesFromPath
}

import * as glob from 'glob';

async function getFilesFromPath(rootPath: string, globPattern: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    glob(globPattern, { nodir: true, absolute: true, strict: false }, (err, files) => {
      if (err) {
        return reject(err);
      }

      return resolve(files);
    });
  });
}

export {
  getFilesFromPath
}

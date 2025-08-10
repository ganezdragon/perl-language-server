import { FunctionReference } from "../types/common.types";
const SET_DELIMITER = "\x01"; // SOH control character - forbidden in filenames across all OS

export function extractSubroutineNameFromFullFunctionName(fullFunctionName: string): string {
    // fullFunctionName is something like "foo::bar" or "foo::second::bar",
    // and we want to extract "bar"
    return fullFunctionName.split('::').slice(-1)[0];
}

// Helper function to create unique key for FunctionReference
export function createFunctionRefKey(funcRef: FunctionReference): string {
    return `${funcRef.uri}${SET_DELIMITER}${funcRef.functionName}${SET_DELIMITER}${funcRef.packageName}${SET_DELIMITER}${funcRef.position.startRow}${SET_DELIMITER}${funcRef.position.startColumn}${SET_DELIMITER}${funcRef.position.endRow}${SET_DELIMITER}${funcRef.position.endColumn}`;
}
  
// Helper function to parse key back to FunctionReference
export function parseFunctionRefKey(key: string): FunctionReference {
    const parts = key.split(SET_DELIMITER);
    return {
      uri: parts[0],
      functionName: parts[1],
      packageName: parts[2],
      position: {
        startRow: parseInt(parts[3]),
        startColumn: parseInt(parts[4]),
        endRow: parseInt(parts[5]),
        endColumn: parseInt(parts[6])
      }
    };
}

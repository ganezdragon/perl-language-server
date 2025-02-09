
export function extractSubroutineNameFromFullFunctionName(fullFunctionName: string): string {
    // fullFunctionName is something like "foo::bar" or "foo::second::bar",
    // and we want to extract "bar"
    return fullFunctionName.split('::').slice(-1)[0];
}

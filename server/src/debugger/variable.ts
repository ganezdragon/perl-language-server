export enum NestedVariableType {
    Array = 'array',
    Hash = 'hash',
    Scalar = 'scalar',
}

export class NestedVariable {
    public type: NestedVariableType;
    public content: string;

    constructor(type: NestedVariableType, content: string) {
        this.type = type;
        this.content = content;
    }
}

export function extractVariables(variables: string): string[] {
    // Explanation of the regex:
    // (?:^|\n) - Starts at the beginning of the string or after a newline
    // ([$%@][^\n]* - Captures a line starting with $, %, or @
    // (?:\n(?![$%@])[^\n]*)* - Captures any subsequent lines that don't start with $, %, @
    // The global flag g ensures we find all matches
    const pattern: RegExp = /(?:^|\n)([$%@][^\n]*(?:\n(?![$%@])[^\n]*)*)/g;
    const matches: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(variables)) !== null) {
        // Trim any trailing lines that might contain DB<number>
        let result = match[1].replace(/\n\s*DB<\d+>.*$/, '');
        matches.push(result);
    }

    return matches;
}

export function getListLengthFromValue(arrayStr: string): number {
    // ^\s{3}(\d+)\b matches:
    // ^\s{3} → Only match numbers at the beginning of lines with exactly 3 spaces (top-level)
    // (\d+) → one or more digits (captures the index)
    // \b → word boundary to avoid partial matches
    const regex = /^\s{3}(\d+)\b/gm;
    let matches: RegExpExecArray | null;
    let lastIndex: number = 0;
    
    // Find all matches
    while ((matches = regex.exec(arrayStr)) !== null) {
        lastIndex = parseInt(matches[1], 10);
    }
    
    return lastIndex ? lastIndex + 1 : 0;
}

// when given the following,
// "(
// 0  2
// 1  'a'
// 2  HASH(0x15b080c90)
//     'hey' => 'no'
//     'lol' => 'yes'
// 3  'b'
// 4  HASH(0x15b00bc78)
//     1 => 'a'
//     2 => 'b'
// )"
// return [
//   "2",
//   "'a'",
//   "HASH(0x13404c6e8)\n'hey' => 'no'\n'lol' => 'yes'",
//   "'b'",
//   "HASH(0x13404cc28)\n1 => 'a'\n2 => 'b'"
// ]
export function getValuesFromArrayContext(arrayContextStr: string): string[] {
    // Step 1: Split into lines
    const lines: string[] = arrayContextStr.split('\n');

    // Step 2: Parse top-level indices
    let result: string[] = [];
    let currentIndex: string | null = null;
    let currentValueLines: string[] = [];

    let indent: number | null = null; // or any dynamic value

    for (const line of lines) {
        if (line.startsWith('(') || line.startsWith('ARRAY') || line.match(/$\w+=ARRAY/)) {
            continue;
        }
        if (indent === null) {
            const indentMatch = line.match(/^(\s*)/);
            indent = indentMatch ? indentMatch[1].length : 0;
        }
        const regex = new RegExp(`^ {${indent}}(\\d+)\\b(.*)$`);
        const indexMatch = line.match(regex);
        if (indexMatch) {
            // Save previous entry if exists
            if (currentIndex !== null) {
                result.push(currentValueLines.join('\n'));
            }
            // Start new entry
            currentIndex = indexMatch[1];
            currentValueLines = [indexMatch[2].trim()];
        }
        else if (currentIndex !== null) {
            // Line is part of current value block (likely nested or indented)
            currentValueLines.push(line);
        }
    }

    // Don't forget last entry
    if (currentIndex !== null) {
        result.push(currentValueLines.join('\n'));
    }

    return result;
}

export function getKeyValuesFromHashContext(hashContextStr: string): Record<string, string> {
    const lines = hashContextStr.split('\n');
    const entries = new Map<string, string>();

    let currentKey: string | null = null;
    let currentValueLines: string[] = [];

    let indent: number | null = null;

    for (const line of lines) {
        if (
            line.startsWith('HASH') || line.match(/\w+=HASH/)
            || line.startsWith('(') || line.startsWith(')')
        ) {
            continue;
        }

        if (indent === null) {
            const indentMatch = line.match(/^(\s*)/);
            indent = indentMatch ? indentMatch[1].length : 0;
        }

        const regex = new RegExp(`^ {${indent}}['"]?([^'"]+)['"]?\\s*=>\\s*(.+)$`);
        const match = line.match(regex);

        if (match) {
            // Save previous key-value block
            if (currentKey !== null) {
                entries.set(currentKey, currentValueLines.join('\n'));
            }

            // Start new key
            currentKey = match[1];
            currentValueLines = [match[2].trim()];
        } else if (currentKey !== null) {
            currentValueLines.push(line);
        }
    }

    // Don't forget last key-value block
    if (currentKey !== null) {
        entries.set(currentKey, currentValueLines.join('\n'));
    }

    // Convert to plain object
    return Object.fromEntries(entries);
}


// export function getKeyValuesFromHashContext(hashContextStr: string): { [key: string]: string } {
//     const lines = hashContextStr.split('\n');
//     const result: Record<string, string> = {};
//     let i = 0;

//     while (i < lines.length) {
//         const line = lines[i];
//         const match = line.match(/^\s*['"]?([\w\d]+)['"]?\s*=>\s*(.+)$/);

//         if (match) {
//             const key = match[1];
//             const valueLine = match[2];
//             const blockLines = [valueLine];

//             i++;

//             // Accumulate lines until the next top-level key=>value pair
//             while (
//                 i < lines.length &&
//                 !lines[i].match(/^\s*['"]?([\w\d]+)['"]?\s*=>\s*(.+)$/)
//             ) {
//                 blockLines.push(lines[i].trimEnd());
//                 i++;
//             }

//             result[key] = blockLines.join('\n');
//         }
//         else {
//             i++;
//         }
//     }

//     return result;
// }

function splitOnUnquotedArrow(line: string): [string, string] | null {
  let insideQuote = false;

  for (let i = 0; i < line.length - 1; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === "'") {
      insideQuote = !insideQuote;
    }

    if (!insideQuote && char === '=' && next === '>') {
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 2).trim();
      return [key, value];
    }
  }

  return null;
}

export function getActualVariableValueFromListContext(listContextStr: string, variableName: string): { value: string, type?: NestedVariableType } {
    // Trim any trailing lines that might contain DB<number>
    listContextStr = listContextStr.replace(/\n\s*DB<\d+>.*$/, '');

    if (variableName.startsWith('@')) {
        return {
            value: listContextStr,
            type: NestedVariableType.Array
        };
    }
    else {
        // remove the first string '0'
        listContextStr = listContextStr.replace('0', '').trimStart();

        return {
            value: listContextStr,
        }
    }
}

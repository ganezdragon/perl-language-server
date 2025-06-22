export interface PerlStackFrame {
    context: 'array' | 'scalar' | 'void' | 'unknown';
    caller: string;
    fullPath: string;
    line: number;
    callee: string;
}

export function parsePerlStackTrace(trace: string): PerlStackFrame[] {
    const frames: PerlStackFrame[] = [];
    const lines = trace.split('\n');

    for (const line of lines) {
        /*
            Regex explanation:

            ^                       // Start of the line
            ([@\$\.])             // Group 1: Captures context symbol:
                                //   '@' = array context
                                //   '$' = scalar context
                                //   '.' = void context

            \s*=\s*                // Matches '=' with optional whitespace around it

            ([\w:]+(?:\(\))?)      // Group 2: Captures the callee function name.
                                //   - [\w:]+ matches names like 'main::foo'
                                //   - (?:\(\))? optionally matches '()' if present

            \s+called\s+from\s+file\s+ // Matches literal text 'called from file' with flexible spacing

            '(.+?)'                // Group 3: Captures the file path inside single quotes (non-greedy)

            \s+line\s+(\d+)        // Group 4: Matches 'line' followed by the line number
        */
        const match = line.match(/^([@\$\.])\s*=\s*([\w:]+(?:\(\))?)\s+called from file\s+'(.+?)'\s+line\s+(\d+)/);
        if (match) {
            const symbol = match[1];
            const callee = match[2];
            const fullPath = match[3];
            const lineNumber = parseInt(match[4], 10);
            const caller = fullPath.split('/').pop() || fullPath;

            let context: 'array' | 'scalar' | 'void' | 'unknown' = 'unknown';
            switch (symbol) {
                case '@':
                    context = 'array';
                    break;
                case '$':
                    context = 'scalar';
                    break;
                case '.':
                    context = 'void';
                    break;
                default:
                    context = 'unknown';
                    break;
            }

            frames.push({
                context,
                caller,
                fullPath,
                line: lineNumber,
                callee
            });
        }
    }

    return frames;
}

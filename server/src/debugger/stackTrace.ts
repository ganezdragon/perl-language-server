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

    // Some debuggers wrap long lines or produce multi-line eval blocks.
    // Build logical lines by concatenating until we see the canonical tail
    // "called from file '...'
    //  line N".
    const logicalLines: string[] = [];
    let acc: string = '';

    const isStartOfFrame = (s: string) => /^(\s*\/\/\s*)?\s*[@\$\.]\s*=/.test(s) || (acc.length > 0 && /^\s+/.test(s));
    const hasEndOfFrame = (s: string) => /called\s+from\s+file\s+'.+?'\s+line\s+\d+/.test(s);

    for (const raw of lines) {
        // tolerate sample lines that are commented with '//'
        const stripped = raw.replace(/^\s*\/\/\s?/, '');

        if (!acc) {
            if (!isStartOfFrame(stripped)) {
                continue;
            }
            acc = stripped.trimEnd() + ' ';
        } else {
            acc += stripped.trimEnd() + ' ';
        }

        if (hasEndOfFrame(acc)) {
            logicalLines.push(acc.replace(/\s+/g, ' ').trim());
            acc = '';
        }
    }

    for (const line of logicalLines) {
        /*
            Regex explanation:

            ^                       // Start of the line
            ([@\$\.])             // Group 1: Captures context symbol:
                                //   '@' = array context
                                //   '$' = scalar context
                                //   '.' = void context

            \s*=\s*                // Matches '=' with optional whitespace around it

            (.+?)                 // Group 2: Captures the callee (flexible: eval {...}, require '...', Foo::Bar::baz(), etc.)

            \s+called\s+from\s+file\s+ // Matches literal text 'called from file' with flexible spacing

            '(.+?)'                // Group 3: Captures the file path inside single quotes (non-greedy)

            \s+line\s+(\d+)        // Group 4: Matches 'line' followed by the line number
        */
        const match = line.match(/^([@\$\.])\s*=\s*(.+?)\s+called\s+from\s+file\s+'(.+?)'\s+line\s+(\d+)/);
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

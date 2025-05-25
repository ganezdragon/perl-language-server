import { EventEmitter } from 'events';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { StreamCatcher } from './streamCatcher';

export interface Breakpoint {
    file: string;
    line: number;
}

export class PerlProcess extends EventEmitter {
    private process: ChildProcessWithoutNullStreams | undefined;
    private streamCatcher: StreamCatcher;
    private pendingStackTraceResolve?: (stack: { file: string; line: number } | null) => void;

    constructor(private program: string, private cwd: string) {
        super();
        this.streamCatcher = new StreamCatcher();
    }

    public start() {
        this.process = spawn('perl', ['-d', this.program], { cwd: this.cwd });

        this.process.stdout.on('data', (data: Buffer) => {
            const output = data.toString();
            this.streamCatcher.handleOutput(output);
            this.emit('output', output);

            if (this.pendingStackTraceResolve) {
                const match = output.match(/called from file '(.*)' line (\d+)/);
                if (match) {
                    const [, file, lineStr] = match;
                    this.pendingStackTraceResolve({ file, line: parseInt(lineStr, 10) });
                    this.pendingStackTraceResolve = undefined;
                }
            }

            if (this.streamCatcher.isDebuggerPrompt(output)) {
                this.emit('stopped');
            }
        });

        this.process.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            this.streamCatcher.handleOutput(output);
            this.emit('output', output);
        });

        this.process.on('exit', (code: number | null) => {
            this.emit('terminated', code);
        });
    }

    public setBreakpoints(breakpoints: Breakpoint[]) {
        if (!this.process) return;

        for (const bp of breakpoints) {
            const cmd = `b ${bp.file}:${bp.line}\n`;
            this.sendCommand(cmd);
        }
    }

    public continue() {
        this.sendCommand("c\n");
    }

    private sendCommand(cmd: string) {
        if (this.process && this.process.stdin.writable) {
            this.process.stdin.write(cmd);
        }
    }

    public stop() {
        if (this.process) {
            this.process.kill();
        }
    }

    public getOutput(): string {
        return this.streamCatcher.getFullOutput();
    }

    public requestStackTrace(): Promise<{ file: string; line: number } | null> {
        return new Promise((resolve) => {
            this.pendingStackTraceResolve = resolve;
            this.sendCommand("T\n");
        });
    }
}
 
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';

export interface Breakpoint {
    file: string;
    line: number;
}

export class PerlProcess extends EventEmitter {
    private process: ChildProcessWithoutNullStreams | undefined;

    constructor(private program: string, private cwd: string) {
        super();
    }

    public start() {
        this.process = spawn('perl', ['-d', this.program], { cwd: this.cwd });

        this.process.stdout.on('data', (data: Buffer) => {
            const output = data.toString();
            this.emit('output', output);

            if (output.includes('DB<')) {
                this.emit('stopped');
            }
        });

        this.process.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
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
            this.process.stdin.write(cmd);
        }
    }

    public continue() {
        if (this.process) {
            this.process.stdin.write("c\n");
        }
    }

    public stepOver() {
        if (this.process) {
            this.process.stdin.write("n\n"); // 'next' in Perl debugger
        }
    }

    public stop() {
        if (this.process) {
            this.process.kill();
            this.process = undefined;
        }
    }
}

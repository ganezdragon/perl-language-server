import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface Breakpoint {
    file: string;
    line: number;
}

export class PerlProcess extends EventEmitter {
    private process: ChildProcess;
    private buffer: string;
    private readyPrompt: RegExp;
    private waitingResolvers: any[];

    constructor(childProcess: ChildProcess) {
        super();

        this.process = childProcess;
        this.buffer = '';
        this.readyPrompt = /DB<\d+>/;
        this.waitingResolvers = [];

        this.process.stdout?.setEncoding('utf8');
        this.process.stdout?.on('data', (data) => {
            console.log("at STD OUT............");
            this.buffer += data;
            this._processBuffer();
            // this.emit('output', data.toString());

            if (data.includes('DB<')) {
                // Perl debugger prompt detected
                this.emit('stopped', data);
            }
        });

        this.process.stderr?.setEncoding('utf8');
        this.process.stderr?.on('data', (data) => {
            console.log("at STDERR............", data);
            this.buffer += data;
            this._processBuffer();
            this.emit('output', data.toString());

            // if (data.includes('DB<')) {
            if (/DB<\d> $/.test(data)) {
                // Perl debugger prompt detected
                this.emit('stopped', data);
            }
        });

        this.process.on('close', (code) => {
            console.log(`Perl process exited with code ${code}`);
        });

    }

    private _processBuffer(): void {
        if (this.readyPrompt.test(this.buffer)) {
            // Resolve the oldest pending request
            const output = this.buffer;
            this.buffer = '';
            if (this.waitingResolvers.length > 0) {
                const resolve = this.waitingResolvers.shift();
                resolve(output);
            }
        }
    }

    private _sendCommand(command: string): Promise<string> {
        return new Promise((resolve) => {
            this.waitingResolvers.push(resolve);
            this.process.stdin?.write(command);
        });
    }

    public async trace(): Promise<string> {
        const output: string = await this._sendCommand('T\n');
        return output;
    }

    public setBreakpoints(breakpoints: Breakpoint[]) {
        for (const bp of breakpoints) {
            const cmd = `b ${bp.file}:${bp.line}\n`;
            this._sendCommand(cmd);
        }
    }

    public async continue() {
        this.emit('continued', {});
        await this._sendCommand("c\n");
    }

    public async next() {
        this.emit('continued', {});
        await this._sendCommand("n\n");
    }

    public stop() {
        if (this.process) {
            this.process.kill();
        }
    }
}
 
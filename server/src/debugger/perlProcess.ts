import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface Breakpoint {
    file: string;
    line: number;
    condition?: string;
    subName?: string;
}

export class PerlProcess extends EventEmitter {
    private process: ChildProcess;
    /**
     * The mutex to make simultaneous execution of public methods impossible.
     *
     * @ignore
     */
    private _lock = Promise.resolve();
    private buffer: string;
    private readyPrompt: RegExp;
    private waitingResolvers: any[];

    constructor(childProcess: ChildProcess) {
        super();

        this.process = childProcess;
        this.buffer = '';
        this.readyPrompt = /DB<\d+> $/;
        this.waitingResolvers = [];

        // basically nothing should be coming off of STDOUT
        // yes, perl redirects everything to STDERR
        this.process.stdout?.setEncoding('utf8');
        this.process.stdout?.on('data', (data) => {
            this.buffer += data;
            this._processBuffer();
            // NOTE: only for debugging
            this.emit('stdout.output', data.toString());

            // if (data.includes('DB<')) {
            if (this.readyPrompt.test(data)) {
                // Perl debugger prompt detected
                this.emit('stopped', data);
            }
        });


        // main channel
        this.process.stderr?.setEncoding('utf8');
        this.process.stderr?.on('data', (data) => {
            this.buffer += data;
            this._processBuffer();
            // NOTE: only for debugging
            this.emit('stderr.output', data.toString());

            // if (data.includes('DB<')) {
            if (this.readyPrompt.test(data)) {
                // Perl debugger prompt detected
                this.emit('stopped', data);
            }
        });

        this.process.on('close', (code) => {
            console.log(`Perl process exited with code ${code}`);
        });

    }

    /**
     * This routine makes it impossible to run multiple punlic methods
     * simultaneously. Why this matter? It's really important for public
     * methods to not interfere with each other, because they can change
     * the state of GDB during execution. They should be atomic,
     * meaning that calling them simultaneously should produce the same
     * results as calling them in order. One way to ensure that is to block
     * execution of public methods until other methods complete.
     *
     * @param {Task} task The task to execute.
     *
     * @returns {Promise<any, GDBError>} A promise that resolves with task results.
     *
     * @ignore
     */
    private _sync (task: any): Promise<any> {
        this._lock = this._lock.then(task, task)
        return this._lock
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
            // else {
            //     this.emit('stderr.output', output);
            //     this.emit('stdout.output', output);
            // }
        }
    }

    private _sendCommand(command: string): Promise<string> {
        return new Promise((resolve) => {
            this.waitingResolvers.push(resolve);
            this.process.stdin?.write(command);
        });
    }

    public async autoFlushStdOut() {
        return this._sync(async () => {
            await this._sendCommand("$| = 1;\n");
        });
    }

    public async setTty(ttyPath: string) {
        return this._sync(async () => {
            await this._sendCommand(`o TTY=${ttyPath}\n`);
        });
    }

    public async trace(): Promise<string> {
        return this._sync(async () => {
            const output: string = await this._sendCommand('T\n');
            return output;
        });
    }

    public async setBreakpoint(file: string, line: number, condition?: string): Promise<string> {
        return this._sync(async () => {
            const cmd = `b ${file}:${line} ${condition}\n`;
            return await this._sendCommand(cmd);
        });
    }

    public async deleteBreakpoints(lines: number[]) {
        return this._sync(async () => {
            for (const line of lines) {
                const cmd = `B ${line}\n`;
                await this._sendCommand(cmd);
            }
        });
    }

    public async continue() {
        return this._sync(async () => {
            this.emit('continued', {});
            await this._sendCommand("c\n");
        })
    }

    public async ctrlC() {
        // Send SIGINT to the entire process group. Since the debuggee is
        // spawned with detached:true and (when shell:true) may involve a
        // pipeline, signaling the group ensures perl -d receives SIGINT
        // like a real Ctrl+C from a terminal, without killing just the shell.
        const pid = this.process.pid;
        if (pid) {
            try {
                // negative PID targets the process group on POSIX systems
                process.kill(-pid, 'SIGINT');
            } catch (err) {
                // fallback: try the direct child if group signaling fails
                try { this.process.kill('SIGINT'); } catch (_) { /* noop */ }
            }
        }
        this.emit('paused');
    }

    public async next() {
        return this._sync(async () => {
            this.emit('stopOnStep');
            await this._sendCommand("n\n");
        });
    }

    public async singleStep() {
        return this._sync(async () => {
            this.emit('stopOnStep');
            await this._sendCommand("s\n");
        });
    }

    public async stepOut() {
        return this._sync(async () => {
            this.emit('stopOnStep');
            await this._sendCommand("o\n");
        });
    }

    public async restart() {
        return this._sync(async () => {
            await this._sendCommand("R\n");
        });
    }

    public stop() {
        if (this.process) {
            this.process.stdin?.end();
            this.process.kill();
        }
    }

    public async getLocalScopedVariables(): Promise<string> {
        return this._sync(async () => {
            const output: string = await this._sendCommand('y\n');
            return output;
        });
    }

    public async getGlobalScopedVariables(): Promise<string> {
        return this._sync(async () => {
            const output: string = await this._sendCommand('V\n');
            return output;
        });
    }

    public async evaluate(expression: string): Promise<string> {
        return this._sync(async () => {
            // add '\' if the variable is a %hash
            if (expression.startsWith('%')) {
                expression = `\\${expression}`
            }
            const output: string = await this._sendCommand(`x ${expression}\n`);
            return output;
        });
    }
}
 
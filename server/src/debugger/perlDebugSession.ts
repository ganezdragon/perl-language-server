import {
    Breakpoint,
    ContinuedEvent,
    DebugSession,
    InitializedEvent,
    OutputEvent,
    Source,
    StoppedEvent,
    TerminatedEvent,
    Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ChildProcess, spawn } from 'child_process';
import { PerlProcess } from './perlProcess';

interface PerlLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    cwd?: string;
}

export class PerlDebugSession extends DebugSession {
    private perlProcess?: PerlProcess;
    private breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

    private isStopped = false; // Flag to prevent multiple StoppedEvents

	private THREADID: number = 1;

    constructor() {
        super();
    }

    protected launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: PerlLaunchRequestArguments
    ): void {
        const program = args.program;
        const cwd = args.cwd || process.cwd();

        if (!program) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'No program specified to debug.'
            });
            return;
        }

        let childProcess: ChildProcess = spawn('perl', ['-d', program], { cwd: cwd });

        this.perlProcess = new PerlProcess(childProcess);

        // register for all events
        this.perlProcess.on('output', (output: string) => {
            this.sendEvent(new OutputEvent(output, 'stdout'));
        });

        this.perlProcess.on('stopped', () => {
            if (!this.isStopped) {
                this.sendEvent(new StoppedEvent('breakpoint', 1));
                this.isStopped = true;
            }
        });

        this.perlProcess.on('continued', () => {
            this.isStopped = false;
            this.sendEvent(new ContinuedEvent(this.THREADID));
        });

        this.perlProcess.on('terminated', (code: number | null) => {
            this.sendEvent(new TerminatedEvent());
        });

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected continueRequest(
        response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments
    ): void {
        this.perlProcess?.continue();
        this.sendResponse(response);
    }

    protected nextRequest(
        response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments
    ): void {
        this.perlProcess?.next();
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        this.perlProcess?.stop();
        this.perlProcess = undefined;
        this.sendResponse(response);
    }

    // protected variablesRequest(
    //     response: DebugProtocol.VariablesResponse,
    //     args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request
    // ): void {
    //     response.body = {
    //         variables: []
    //     };
    //     this.sendResponse(response);
    // }

    protected setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): void {
        const path = args.source.path as string;
        const clientLines = args.lines || [];

        const breakpoints: DebugProtocol.Breakpoint[] = clientLines.map(line => {
            return new Breakpoint(true, line);
        });

        this.breakpoints.set(path, breakpoints);

        this.perlProcess?.setBreakpoints(
            clientLines.map(line => ({ file: path, line }))
        );

        response.body = {
            breakpoints: breakpoints
        };

        this.sendResponse(response);
    }

	// need this for vscode debugger highlight as well
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(this.THREADID, 'main')
            ]
        };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {
        
		let stackTrace: string | undefined = await this.perlProcess?.trace();

        // get the first line from stacktrace
        if (stackTrace) {
            const firstLine = stackTrace.split('\n')[0];
            const match = firstLine.match(/file '(.+)' line (\d+)/);
            if (match) {
                response.body = {
                    stackFrames: [{
                        id: 1,
                        name: 'main',
                        source: new Source(match[1], match[1]),
                        line: parseInt(match[2], 10),
                        column: 1
                    }],
                    totalFrames: 1
                };
                this.sendResponse(response);
            }
            else {
                response.body = {
                    stackFrames: [],
                    totalFrames: 0
                }
                this.sendResponse(response);
            }
        }
    }
}

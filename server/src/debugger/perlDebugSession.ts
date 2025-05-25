import {
    Breakpoint,
    DebugSession,
    InitializedEvent,
    OutputEvent,
    StoppedEvent,
    TerminatedEvent,
    StackFrame,
    Source,
    Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { PerlProcess } from './perlProcess';

interface PerlLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    cwd?: string;
}

export class PerlDebugSession extends DebugSession {
    private perlProcess?: PerlProcess;
    private breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

    // Track current source location for stack trace
    private currentFile: string = '';
    private currentLine: number = 1;

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

        this.currentFile = program;
        this.perlProcess = new PerlProcess();
        this.perlProcess.start(program, cwd);

        this.perlProcess.on('output', (output: string) => {
            this.sendEvent(new OutputEvent(output, 'stdout'));

            // Try to extract the line number
            const line = this.perlProcess!.getOutput().match(/line (\d+)/);
            if (line) {
                this.currentLine = parseInt(line[1], 10);
            }

            if (output.includes('DB<')) {
                this.sendEvent(new StoppedEvent('breakpoint', 1));
            }
        });

        this.perlProcess.on('terminated', () => {
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

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        this.perlProcess?.stop();
        this.perlProcess = undefined;
        this.sendResponse(response);
    }

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

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(1, 'main')
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): void {
        const source = new Source(this.currentFile, this.currentFile);
        const frame = new StackFrame(1, 'main', source, this.currentLine, 1);

        response.body = {
            stackFrames: [frame],
            totalFrames: 1
        };

        this.sendResponse(response);
    }
}

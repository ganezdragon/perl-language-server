import { DebugSession, InitializedEvent, OutputEvent, StoppedEvent, TerminatedEvent, Breakpoint } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { PerlProcess, Breakpoint as PerlBreakpoint } from './perlProcess';

interface PerlLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    cwd?: string;
}

export class PerlDebugSession extends DebugSession {

    private perlProcess: PerlProcess | undefined;
    private breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

    private currentFile: string | undefined;
    private currentLine: number | undefined;

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: PerlLaunchRequestArguments): void {
        const program = args.program;
        const cwd = args.cwd || process.cwd();

        this.currentFile = "/Users/ganesans/Documents/working/personal/test/testing.pl"; // your launched script
        this.currentLine = 1; // from debugger output if possible

        this.sendEvent(new StoppedEvent('breakpoint', 1));

        

        if (!program) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'No program specified to debug.'
            });
            return;
        }

        this.perlProcess = new PerlProcess(program, cwd);
        this.perlProcess.start();

        this.perlProcess.on('output', (output: string) => {
            this.sendEvent(new OutputEvent(output, 'stdout'));
        });

        this.perlProcess.on('stopped', () => {
            this.sendEvent(new StoppedEvent('breakpoint', 1));
        });

        this.perlProcess.on('terminated', () => {
            this.sendEvent(new TerminatedEvent());
        });

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        const path = args.source.path as string;
        const clientLines = args.lines || [];

        const bps: DebugProtocol.Breakpoint[] = clientLines.map(line => {
            return new Breakpoint(true, line);
        });

        this.breakpoints.set(path, bps);

        if (this.perlProcess) {
            const perlBps: PerlBreakpoint[] = clientLines.map(line => ({ file: path, line }));
            this.perlProcess.setBreakpoints(perlBps);
        }

        response.body = {
            breakpoints: bps
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        if (this.perlProcess) {
            this.perlProcess.continue();
        }
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        if (this.perlProcess) {
            this.perlProcess.stepOver();
        }
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        if (this.perlProcess) {
            this.perlProcess.stop();
            this.perlProcess = undefined;
        }
        this.sendResponse(response);
    }

    protected stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): void {
        const frames: DebugProtocol.StackFrame[] = [];
    
        frames.push({
            id: 1,
            name: 'main', // or current function name if you can get
            source: {
                path: this.currentFile, // track this during stopped event
            },
            line: this.currentLine || 1,
            column: 1,  // Perl debugger has no column info; just default 1
        });
    
        response.body = {
            stackFrames: frames,
            totalFrames: frames.length,
        };
    
        this.sendResponse(response);
    }
    
}

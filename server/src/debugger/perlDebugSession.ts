import {
    Breakpoint,
    ContinuedEvent,
    DebugSession,
    Handles,
    InitializedEvent,
    OutputEvent,
    Scope,
    Source,
    StoppedEvent,
    TerminatedEvent,
    Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ChildProcess, spawn } from 'child_process';
import { PerlProcess } from './perlProcess';
import { getKeyValuesFromHashContext, getValuesFromArrayContext, NestedVariable, NestedVariableType } from './variable';
const { Subject } = require('await-notify');

interface PerlLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    cwd?: string;
}

export class PerlDebugSession extends DebugSession {
    private perlProcess?: PerlProcess;
    private breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

    private isStopped = false; // Flag to prevent multiple StoppedEvents

	private THREADID: number = 1;

    private _configurationDone = new Subject();

    private _variableHandles = new Handles<'locals' | 'packages' | 'globals' | NestedVariable>();
    private _reportProgress = false;
    private _useInvalidatedEvent = false;

    constructor() {
        super();
    }

    /**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		if (args.supportsProgressReporting) {
			this._reportProgress = true;
		}
		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = true;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

        // perl supports this with b [file]:[line] [condition] syntax
        response.body.supportsConditionalBreakpoints = true;
        // a [line] command 
        // eg: a 53 print "DB FOUND $foo\n"
        response.body.supportsLogPoints = true;

		// make VS Code support completion in REPL
		response.body.supportsCompletionsRequest = true;
		response.body.completionTriggerCharacters = [ ".", ":", "$", "%", "@" ];

		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = false;

		// the adapter defines two exceptions filters, one with support for conditions.
		response.body.supportsExceptionFilterOptions = true;
		response.body.exceptionBreakpointFilters = [
			{
				filter: 'dieOrCroakNamed',
				label: "Named Die or croak Exception",
				description: `Break on named exceptions. Enter the exception's name as the Condition.`,
				default: false,
				supportsCondition: true,
				conditionDescription: `Enter the exception's name`
			},
			{
				filter: 'dieOrCroakUnamed',
				label: "End or Die Exception",
				description: 'This is a other exception',
				default: true,
				supportsCondition: false
			}
		];

		// make VS Code send exceptionInfo request
		response.body.supportsExceptionInfoRequest = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

		// make VS Code send setExpression request
		response.body.supportsSetExpression = true;

		// make VS Code send disassemble request
		response.body.supportsDisassembleRequest = true;
		response.body.supportsSteppingGranularity = true;
		response.body.supportsInstructionBreakpoints = true;

		// make VS Code able to read and write variable memory
		response.body.supportsReadMemoryRequest = true;
		response.body.supportsWriteMemoryRequest = true;

		response.body.supportSuspendDebuggee = true;
		response.body.supportTerminateDebuggee = true;
        // b subname [condition]
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsDelayedStackTraceLoading = true;

		this.sendResponse(response);

        // TODO: this doesn't work currently. Need to initialize when
        // PerlProcess is initialized in launchRequest
        // otherwise this.perlProcess.setBreakpoints doesn't go through.
		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		// this.sendEvent(new InitializedEvent());
	}

    /**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: PerlLaunchRequestArguments
    ): Promise<void> {
        const program = args.program;
        const cwd = args.cwd || process.cwd();

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

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
                this.sendEvent(new StoppedEvent('breakpoint', this.THREADID));
                this.isStopped = true;
            }
        });

        this.perlProcess.on('continued', () => {
            this.isStopped = false;
            this.sendEvent(new ContinuedEvent(this.THREADID));
        });

        this.perlProcess.on('stopOnStep', () => {
            this.isStopped = false;
            this.sendEvent(new StoppedEvent('step', this.THREADID))
        })

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

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void {
        this.perlProcess?.singleStep();
        this.sendResponse(response);
    }

    protected stepOutRequest(
        response: DebugProtocol.StepOutResponse, 
        args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request
    ): void {
        this.perlProcess?.stepOut();
        this.sendResponse(response);
        
    }

    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
        this.perlProcess?.restart();
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
        this.perlProcess?.stop();
        this.perlProcess = undefined;
        this.sendResponse(response);
    }

    protected async variablesRequest(
        response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request
    ): Promise<void> {
        let variableResponse: DebugProtocol.Variable[] = [];

		const scope: string | NestedVariable = this._variableHandles.get(args.variablesReference);

        if (scope instanceof NestedVariable) {
            if (scope.type === NestedVariableType.Array) {
                const nestedVariables: string[] = getValuesFromArrayContext(scope.content);

                nestedVariables.forEach((variable: string, index: number) => {
                    variableResponse.push({
                        name: index.toString(),
                        value: variable,
                        variablesReference: this.getVariableReferenceFromValue(variable),
                    });
                });
            }
            else if (scope.type === NestedVariableType.Hash) {
                const nestedVariables: { [key: string]: string } = getKeyValuesFromHashContext(scope.content);

                Object.keys(nestedVariables).forEach((key: string) => {
                    variableResponse.push({
                        name: key,
                        value: nestedVariables[key],
                        variablesReference: this.getVariableReferenceFromValue(nestedVariables[key]),
                    });
                });
            }
        }
        else if (scope === 'locals') {
            let localVariables: string | undefined = await this.perlProcess?.getLocalScopedVariables();

            if (localVariables) {
                const variables: string[] = this.extractVariables(localVariables);
                variables.forEach((variable: string) => {
                    variableResponse.push(this.prettifyVariables(variable, false));
                });
            }
        }
        else if (scope === 'globals') {
            let globalVariables: string | undefined = await this.perlProcess?.getGlobalScopedVariables();

            if (globalVariables) {
                // get key value pairs from string which is like $variable = 10
                const variables: string[] = this.extractVariables(globalVariables);
                variables.forEach(variable => {
                    const variableName: string = variable.split(' = ')[0];
                    const variableValue: string = variable.split(' = ')[1];

                    if (variableValue) {
                        variableResponse.push({
                            name: variableName,
                            value: variableValue,
                            // type: typeof variableValue,
                            variablesReference: 0
                        });
                    }
                });
            }
        }
		
        response.body = {
            variables: variableResponse
        };
        this.sendResponse(response);
    }

    private getVariableReferenceFromValue(variableValue: string, context?: NestedVariableType): number {
        if (variableValue.match(/^(\w+=)?HASH\((0x[0-9a-f]+)\)/)) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Hash, variableValue));
        }
        else if (variableValue.match(/^ARRAY\((0x[0-9a-f]+)\)/)) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Array, variableValue));
        }
        else if (context === NestedVariableType.Array) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Array, variableValue));
        }
        else if (context === NestedVariableType.Hash) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Hash, variableValue));
        }

        // return 0 if its not nested
        return 0;
    }

    private extractVariables(variables: string): string[] {
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

    private prettifyVariables(variable: string, isListContext: boolean): DebugProtocol.Variable {
        // get key value pairs from string which is like $variable = 10
        const variableName: string = variable.split(' = ')[0];
        const variableValue: string = variable.split(' = ')[1];

        // singular variables start with '$'
        if (variableName.startsWith('$')) {
            // if variableValue has a HASH or ARRAY in the first line,
            // then it could have nested variables
            if (variableValue.startsWith('HASH(0x') || variableValue.startsWith('ARRAY(0x')) {
                return {
                    name: variableName,
                    value: variableValue,
                    evaluateName: variableName,
                    variablesReference: this.getVariableReferenceFromValue(variableValue),
                };
            }
            // perl hash objects
            else if (variableValue.match(/.*=HASH/)) {
                return {
                    name: variableName,
                    value: `Obj ${variableValue}`,
                    evaluateName: variableName,
                    variablesReference: this.getVariableReferenceFromValue(variableValue),
                };
            }
        }
        // array
        else if (variableName.startsWith('@')) {
            return {
                name: variableName,
                value: `[${this.getListLengthFromValue(variableValue)}] ${variableValue}`,
                evaluateName: variableName,
                variablesReference: this.getVariableReferenceFromValue(variableValue, NestedVariableType.Array),
            };
        }
        // hash
        else if (variableName.startsWith('%')) {
            return {
                name: variableName,
                value: variableValue,
                evaluateName: variableName,
                variablesReference: this.getVariableReferenceFromValue(variableValue, NestedVariableType.Hash),
            };
        }

        return {
            name: variableName,
            value: variableValue,
            variablesReference: 0,
        };
    }

    private getListLengthFromValue(arrayStr: string): number {
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

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        const result: string | undefined = await this.perlProcess?.evaluate(args.expression);
        // value would be like below, so split it and get 1th element
        // eg: 0  3433
        const value: string = result?.split('  ')[1] || '';
        response.body = {
            result: value,
            variablesReference: this.getVariableReferenceFromValue(value)
        };
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments
    ): Promise<void> {
        const path = args.source.path as string;
        const clientLines = args.lines || [];

        const breakpoints: DebugProtocol.Breakpoint[] = clientLines.map(line => {
            return new Breakpoint(true, line);
        });

        this.breakpoints.set(path, breakpoints);

        await this.perlProcess?.setBreakpoints(
            clientLines.map(line => ({ file: path, line }))
        );

        response.body = {
            breakpoints: breakpoints
        };

        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Locals & Closure", this._variableHandles.create('locals'), false),
                new Scope("Package Variables", this._variableHandles.create('packages'), true),
                new Scope("Globals", this._variableHandles.create('globals'), true)
			]
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
                response.success = true;
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
        }
    }
}

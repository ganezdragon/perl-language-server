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
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { PerlProcess } from './perlProcess';
import { extractVariables, getActualVariableValueFromListContext, getKeyValuesFromHashContext, getListLengthFromValue, getValuesFromArrayContext, NestedVariable, NestedVariableType } from './variable';
import { parsePerlStackTrace, PerlStackFrame } from './stackTrace';
const { Subject } = require('await-notify');

interface PerlLaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    env?: { [key: string]: string };
    program: string;
    stopOnEntry: boolean;
    cwd?: string;
    args?: string;
}

export class PerlDebugSession extends DebugSession {
    private perlProcess?: PerlProcess;
    private breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

    private shouldStop = true; // Flag to prevent multiple StoppedEvents
    private hasPassedStopOnEntry = false;

	private THREADID: number = 1;

    private _configurationDone = new Subject();

    private _variableHandles = new Handles<'locals' | 'globals' | NestedVariable>();

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
                filter: 'die',
                label: "Uncaught Exception",
                description: 'Break on a die / croak signal. TODO: this doesn\'t work yet.',
                default: false,
                supportsCondition: false,
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
        const env: PerlLaunchRequestArguments['env'] = args.env;

        // set stopOnEntry
        this.hasPassedStopOnEntry = !!args.stopOnEntry;

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

        if (!program) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'No program specified to debug.'
            });
            return;
        }

        const spawnOptions: SpawnOptions = {
            detached: true,
            // stdio: ['pipe', 'pipe', 'pipe'],
            cwd,
            env
        };
        const commandPlusArgs: string[] = [
            '-d',
            program,
            ...(args.args?.split(' ') || [])
        ];

        let childProcess: ChildProcess = spawn('perl', commandPlusArgs, spawnOptions);

        this.perlProcess = new PerlProcess(childProcess);

        // set things on the process
        // so that all the STDOUT is sent out as when available.
        this.perlProcess.autoFlushStdOut();

        // register for all events
        this.perlProcess.on('stderr.output', (output: string) => {
            this.sendEvent(new OutputEvent(output, 'stdout'));
        });
        this.perlProcess.on('stdout.output', (output: string) => {
            this.sendEvent(new OutputEvent(output, 'stdout'));
        });

        this.perlProcess.on('stopped', () => {
            if (this.shouldStop) {
                this.shouldStop = false;
                this.sendEvent(new StoppedEvent('breakpoint', this.THREADID));
            }
        });

        this.perlProcess.on('continued', () => {
            this.shouldStop = true;
            this.sendEvent(new ContinuedEvent(this.THREADID));
        });

        this.perlProcess.on('stopOnStep', () => {
            this.shouldStop = false;
            this.sendEvent(new StoppedEvent('step', this.THREADID))
        })

        this.perlProcess.on('terminated', (code: number | null) => {
            this.sendEvent(new TerminatedEvent());
        });
        // end of all events

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
                        variablesReference: this._getVariableReferenceFromValue(variable),
                    });
                });
            }
            else if (scope.type === NestedVariableType.Hash) {
                const nestedVariables: { [key: string]: string } = getKeyValuesFromHashContext(scope.content);

                Object.keys(nestedVariables).forEach((key: string) => {
                    variableResponse.push({
                        name: key,
                        value: nestedVariables[key],
                        variablesReference: this._getVariableReferenceFromValue(nestedVariables[key]),
                    });
                });
            }
            else if (scope.type === NestedVariableType.Scalar) {
                /**
                 * eg:
                 *  [0] DB<0> x \$a
                 *  0  SCALAR(0x13e812830)
                 *  -> undef
                 */
                const scalarValue: string = scope.content.replace(/^SCALAR\((0x[0-9a-f]+)\)/, '').replace('->', '').trimStart();
                variableResponse.push({
                    name: scope.content,
                    value: scalarValue,
                    variablesReference: this._getVariableReferenceFromValue(scalarValue),
                });
            }
        }
        else if (scope === 'locals') {
            let localVariables: string | undefined = await this.perlProcess?.getLocalScopedVariables();

            if (localVariables) {
                const variables: string[] = extractVariables(localVariables);
                variables.forEach((variable: string) => {
                    variableResponse.push(this.prettifyVariables(variable, false));
                });
            }
        }
        else if (scope === 'globals') {
            let globalVariables: string | undefined = await this.perlProcess?.getGlobalScopedVariables();

            if (globalVariables) {
                // get key value pairs from string which is like $variable = 10
                const variables: string[] = extractVariables(globalVariables);
                variables.forEach(variable => {
                    variableResponse.push(this.prettifyVariables(variable, false));
                });
            }
        }
		
        response.body = {
            variables: variableResponse
        };
        this.sendResponse(response);
    }

    private _getVariableReferenceFromValue(variableValue: string, context?: NestedVariableType): number {
        if (variableValue.match(/^(\w+=)?HASH\((0x[0-9a-f]+)\)/)) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Hash, variableValue));
        }
        else if (variableValue.match(/^ARRAY\((0x[0-9a-f]+)\)/)) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Array, variableValue));
        }
        else if (variableValue.match(/^SCALAR\((0x[0-9a-f]+)\)/)) {
            return this._variableHandles.create(new NestedVariable(NestedVariableType.Scalar, variableValue));
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
                    variablesReference: this._getVariableReferenceFromValue(variableValue),
                };
            }
            // perl hash objects
            else if (variableValue.match(/.*=HASH/)) {
                return {
                    name: variableName,
                    value: `Obj ${variableValue}`,
                    evaluateName: variableName,
                    variablesReference: this._getVariableReferenceFromValue(variableValue),
                };
            }
        }
        // array
        else if (variableName.startsWith('@')) {
            return {
                name: variableName,
                value: `[${getListLengthFromValue(variableValue)}] ${variableValue}`,
                evaluateName: variableName,
                variablesReference: this._getVariableReferenceFromValue(variableValue, NestedVariableType.Array),
            };
        }
        // hash
        else if (variableName.startsWith('%')) {
            return {
                name: variableName,
                value: variableValue,
                evaluateName: variableName,
                variablesReference: this._getVariableReferenceFromValue(variableValue, NestedVariableType.Hash),
            };
        }

        return {
            name: variableName,
            value: variableValue,
            variablesReference: 0,
        };
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        const result: string | undefined = await this.perlProcess?.evaluate(args.expression);

        if (result) {
            let parsedResult: { value: string, type?: NestedVariableType } = getActualVariableValueFromListContext(result, args.expression);

            response.body = {
                result: `${parsedResult.value}`,
                variablesReference: this._getVariableReferenceFromValue(parsedResult.value, parsedResult.type),
            };
        }
        this.sendResponse(response);
    }


    // this function would be called for each source
    protected async setBreakPointsRequest(
        response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments,
        request: DebugProtocol.Request,

    ): Promise<void> {
        const path: string = args.source.path as string;
        const clientLines: number[] = args.breakpoints?.map(breakpoint => breakpoint.line) || [];
        let breakpoints: DebugProtocol.Breakpoint[] = [];

        // first, delete all existing breakpoints in current file
        // and then set it later
        const linesToDelete: number[] = this.breakpoints.get(path)?.map(bp => bp.line || 0) || [];
        await this.perlProcess?.deleteBreakpoints(linesToDelete);

        for (const line of clientLines) {
            const result: string | undefined = await this.perlProcess?.setBreakpoint(path, line);
            if (result?.match(/not breakable/)) {
                let failedBreakpoint: DebugProtocol.Breakpoint = new Breakpoint(false, line, 1, new Source(path, path));
                failedBreakpoint.message = 'Perl cannot set breakpoint here';
                breakpoints.push(failedBreakpoint);
            }
            else {
                breakpoints.push(new Breakpoint(true, line, 1, new Source(path, path)));
            }
        }

        this.breakpoints.set(path, breakpoints);

        response.body = {
            breakpoints: breakpoints
        };

        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Locals & Closure", this._variableHandles.create('locals'), false),
                new Scope("Globals", this._variableHandles.create('globals'), true)
			]
		};
		this.sendResponse(response);
	}

	// need this for vscode debugger highlight as well
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(this.THREADID, 'main thread')
            ]
        };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments
    ): Promise<void> {

        // perl is going to return all stack frames,
        // so just return all for all requests
        if (args.startFrame !=- 0) {
            return this.sendResponse(response);
        }
        
		let stackTrace: string | undefined = await this.perlProcess?.trace();

        if (stackTrace) {
            const result: PerlStackFrame[] = parsePerlStackTrace(stackTrace);

            response.body = {
                stackFrames: result.map((frame, index) => {
                    return {
                        id: index,
                        name: `:(${frame.context}) ${frame.caller}`,
                        source: new Source(frame.callee, frame.fullPath),
                        line: frame.line,
                        column: 1,
                        canRestart: true,
                        presentationHint: 'normal',
                    };
                }),
                totalFrames: result.length
            };

            // HACK: for stopOnEntry, if the first line is not in breakpoints, continue
            if (!this.hasPassedStopOnEntry && this.lineNotInBreakpoints(result[0].line, result[0].fullPath)) {
                this.hasPassedStopOnEntry = true;
                await this.perlProcess?.continue();
            }

            this.sendResponse(response);
        }
    }

    private lineNotInBreakpoints(line: number, filePath: string): boolean {
        return this.breakpoints.get(filePath)?.every(bp => bp.line != line) || false;
    }
}

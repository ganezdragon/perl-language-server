import { EventEmitter } from "events";
import { ILaunchRequestArguments, PerlDebugSession } from "./perlDebug";

export interface IPerlBreakpoint {
  id: number;
	line: number;
	verified: boolean;
}

export class PerlRuntime extends EventEmitter {
	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}

	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];

	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private _currentColumn: number | undefined;

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, IPerlBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private _noDebug = false;

	private _namedException: string | undefined;
	private _otherExceptions = false;

	// dependencies to be injected
	private session: PerlDebugSession;

	constructor(session: PerlDebugSession) {
		super();
		this.session = session;
	}

	public async start(args: ILaunchRequestArguments) {
		this._currentLine = -1;

		await this.launchSession(args);
	}

	public async launchSession(args: ILaunchRequestArguments) {
		const response = await new Promise((resolve, reject) => {
			this.session.runInTerminalRequest({
				kind: "integrated",
				cwd: '/',
				args: [
					"perl",
					"-d",
					args.program,
				],
				// env: {
				// 	...args.env,
				// }
			}, 5000, response => {
				if (response.success) {
					resolve(response);
				} else {
					reject(response);
				}
			});
		});
	}

}

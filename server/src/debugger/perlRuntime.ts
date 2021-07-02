import { EventEmitter } from "events";
import { ILaunchRequestArguments, PerlDebugSession } from "./perlDebug";

export interface IPerlBreakpoint {
  id: number;
	line: number;
	verified: boolean;
}

export class PerlRuntime extends EventEmitter {
	constructor() {
		super();
	}

	public async start(args: ILaunchRequestArguments, session: PerlDebugSession) {
		await this.launchSession(args, session);
	}

	public async launchSession(args: ILaunchRequestArguments, session: PerlDebugSession) {
	}

}

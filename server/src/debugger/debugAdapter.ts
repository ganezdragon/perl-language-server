import { PerlDebugSession } from "./perlDebugSession";

if (! process.env.VSCODE_DEBUGGING) {
    PerlDebugSession.run(PerlDebugSession);
}


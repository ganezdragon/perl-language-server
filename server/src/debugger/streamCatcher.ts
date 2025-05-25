// streamCatcher.ts
export class StreamCatcher {
    private buffer: string[] = [];
    private taskQueue: (() => void)[] = [];

    handleOutput(output: string) {
        this.buffer.push(output);
        this.flushQueue();
    }

    isDebuggerPrompt(output: string): boolean {
        return output.includes('DB<');
    }

    extractLineNumber(output: string): number | null {
        const match = output.match(/main::.*? at .*? line (\d+)/);
        return match ? parseInt(match[1], 10) : null;
    }

    getFullOutput(): string {
        return this.buffer.join('');
    }

    clearBuffer(): void {
        this.buffer = [];
    }

    // Example task queuing system
    enqueueTask(task: () => void): void {
        this.taskQueue.push(task);
        this.flushQueue();
    }

    private flushQueue() {
        while (this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            if (task) task();
        }
    }
}

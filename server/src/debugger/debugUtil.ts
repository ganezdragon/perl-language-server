import { execSync } from "node:child_process";
import * as fs from 'fs';

export function getTtyFromProcessId(processId: number): string | null {
    try {
        // Use lsof to find the TTY associated with the process
        // lsof -p <pid> -a -d 0 shows file descriptor 0 (stdin) which points to the TTY
        const output = execSync(`lsof -p ${processId} -a -d 0 -F n`, { encoding: 'utf8' });
        
        // Parse lsof output to extract TTY path
        // Output format: "n/dev/ttys001" where 'n' prefix indicates name field
        const lines = output.trim().split('\n');
        for (const line of lines) {
            if (line.startsWith('n/dev/tty')) {
                return line.substring(1); // Remove 'n' prefix
            }
        }
        
        // Alternative method using ps command if lsof doesn't work
        const psOutput = execSync(`ps -o tty= -p ${processId}`, { encoding: 'utf8' });
        const tty = psOutput.trim();
        if (tty && tty !== '?') {
            return `/dev/${tty}`;
        }
        
        return null;
    } catch (error) {
        console.error('Failed to get TTY from process ID:', error);
        return null;
    }
}

/**
 * Write output to a TTY device
 * @param ttyPath Path to TTY device (e.g., /dev/ttys001)
 * @param data Data to write to the TTY
 */
export function writeToTty(ttyPath: string, data: string): void {
    try {
        if (fs.existsSync(ttyPath)) {
            fs.writeFileSync(ttyPath, data);
        }
    } catch (error) {
        console.error('Failed to write to TTY:', error);
    }
}
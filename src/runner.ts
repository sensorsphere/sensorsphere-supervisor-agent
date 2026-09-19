import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
}

export class ExecCommandRunner implements CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          reject(new Error(`${command} failed: ${message}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult>;
}

const MANAGED_COMPOSE_ENV_KEYS = [
  "SENSORSPHERE_URL",
  "SENSORSPHERE_AGENT_TOKEN",
  "SENSORSPHERE_DEVICE_AGENT_TOKEN",
  "AGENT_NAME",
  "AGENT_LABELS",
  "DEVICE_AGENT_IMAGE",
  "MONITOR_AGENT_IMAGE",
  "DATA_DIR",
  "PUID",
  "PGID",
] as const;

export function commandEnvironment(command: string, args: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  if (command !== "docker" || args[0] !== "compose") return env;
  for (const key of MANAGED_COMPOSE_ENV_KEYS) delete env[key];
  return env;
}

export class ExecCommandRunner implements CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(command, args, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: commandEnvironment(command, args),
      }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed);
          const message = stderr.trim() || error.message;
          reject(new Error(timedOut
            ? `${command} timed out after ${timeoutMs}ms: ${message}`
            : `${command} failed: ${message}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

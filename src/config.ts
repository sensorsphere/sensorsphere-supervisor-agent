import path from "node:path";

export interface SupervisorConfig {
  socketPath: string;
  socketGid: number;
  managedRoot: string;
  defaultPuid: number;
  defaultPgid: number;
  operationTimeoutMs: number;
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function parseInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const managedRoot = required("SUPERVISOR_MANAGED_ROOT", env.SUPERVISOR_MANAGED_ROOT);
  if (!path.isAbsolute(managedRoot)) throw new Error("SUPERVISOR_MANAGED_ROOT must be absolute");

  return {
    socketPath: env.SUPERVISOR_SOCKET_PATH?.trim() || "/run/sensorsphere-supervisor-agent/supervisor.sock",
    socketGid: parseInteger("SUPERVISOR_SOCKET_GID", env.SUPERVISOR_SOCKET_GID, 0),
    managedRoot: path.resolve(managedRoot),
    defaultPuid: parseInteger("SUPERVISOR_DEFAULT_PUID", env.SUPERVISOR_DEFAULT_PUID, 1000),
    defaultPgid: parseInteger("SUPERVISOR_DEFAULT_PGID", env.SUPERVISOR_DEFAULT_PGID, 1000),
    operationTimeoutMs: parseInteger("SUPERVISOR_OPERATION_TIMEOUT_MS", env.SUPERVISOR_OPERATION_TIMEOUT_MS, 120_000),
  };
}

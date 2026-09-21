import path from "node:path";

export interface SupervisorConfig {
  socketPath: string;
  socketGid: number;
  managedRoot: string;
  defaultPuid: number;
  defaultPgid: number;
  operationTimeoutMs: number;
  selfInstallDir: string;
  selfUpdateStatusFile: string;
  selfUpdateTimeoutMs: number;
  sensorsphereUrl: string | null;
  sensorsphereAgentToken: string | null;
  supervisorName: string | null;
  sensorsphereHeartbeatIntervalMs: number;
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

  const resolvedManagedRoot = path.resolve(managedRoot);
  const selfInstallDir = path.resolve(env.SUPERVISOR_SELF_INSTALL_DIR?.trim() || path.join(resolvedManagedRoot, "sensorsphere-supervisor-agent"));
  const selfRelative = path.relative(resolvedManagedRoot, selfInstallDir);
  if (selfRelative.startsWith("..") || path.isAbsolute(selfRelative)) throw new Error("SUPERVISOR_SELF_INSTALL_DIR must be inside SUPERVISOR_MANAGED_ROOT");

  return {
    socketPath: env.SUPERVISOR_SOCKET_PATH?.trim() || "/run/sensorsphere-supervisor-agent/supervisor.sock",
    socketGid: parseInteger("SUPERVISOR_SOCKET_GID", env.SUPERVISOR_SOCKET_GID, 0),
    managedRoot: resolvedManagedRoot,
    defaultPuid: parseInteger("SUPERVISOR_DEFAULT_PUID", env.SUPERVISOR_DEFAULT_PUID, 1000),
    defaultPgid: parseInteger("SUPERVISOR_DEFAULT_PGID", env.SUPERVISOR_DEFAULT_PGID, 1000),
    operationTimeoutMs: parseInteger("SUPERVISOR_OPERATION_TIMEOUT_MS", env.SUPERVISOR_OPERATION_TIMEOUT_MS, 120_000),
    selfInstallDir,
    selfUpdateStatusFile: path.join(selfInstallDir, ".supervisor-update-status.json"),
    selfUpdateTimeoutMs: parseInteger("SUPERVISOR_SELF_UPDATE_TIMEOUT_MS", env.SUPERVISOR_SELF_UPDATE_TIMEOUT_MS, 120_000),
    sensorsphereUrl: env.SENSORSPHERE_URL?.trim() || null,
    sensorsphereAgentToken: env.SENSORSPHERE_AGENT_TOKEN?.trim() || null,
    supervisorName: env.SUPERVISOR_NAME?.trim() || null,
    sensorsphereHeartbeatIntervalMs: parseInteger("SENSORSPHERE_HEARTBEAT_INTERVAL_MS", env.SENSORSPHERE_HEARTBEAT_INTERVAL_MS, 30_000),
  };
}

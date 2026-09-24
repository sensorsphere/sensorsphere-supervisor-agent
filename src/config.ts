import path from "node:path";

export interface SupervisorConfig {
  environment: string;
  namespace: string;
  composeProjectName: string;
  socketHostDir: string;
  socketPath: string;
  socketGid: number;
  managedRoot: string;
  additionalManagedRoot: string | null;
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

export function normalizeEnvironment(value: string | undefined): { environment: string; namespace: string } {
  const environment = (value?.trim() || "DEFAULT").toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(environment)) throw new Error("SENSORSPHERE_ENVIRONMENT must match ^[A-Z0-9][A-Z0-9._-]{0,31}$");
  const namespace = environment.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
  return { environment, namespace };
}

function parseInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const { environment, namespace } = normalizeEnvironment(env.SENSORSPHERE_ENVIRONMENT);
  const managedRoot = required("SUPERVISOR_MANAGED_ROOT", env.SUPERVISOR_MANAGED_ROOT);
  if (!path.isAbsolute(managedRoot)) throw new Error("SUPERVISOR_MANAGED_ROOT must be absolute");

  const resolvedManagedRoot = path.resolve(managedRoot);
  const additionalManagedRootValue = env.SUPERVISOR_ADDITIONAL_MANAGED_ROOT?.trim() || (namespace === "default" ? "/opt" : `/opt/sensorsphere-${environment}`);
  if (!path.isAbsolute(additionalManagedRootValue)) throw new Error("SUPERVISOR_ADDITIONAL_MANAGED_ROOT must be absolute");
  const additionalManagedRoot = path.resolve(additionalManagedRootValue) === resolvedManagedRoot ? null : path.resolve(additionalManagedRootValue);
  const selfInstallDir = path.resolve(env.SUPERVISOR_SELF_INSTALL_DIR?.trim() || path.join(resolvedManagedRoot, namespace === "default" ? "sensorsphere-supervisor-agent" : "supervisor-agent"));
  const selfRelative = path.relative(resolvedManagedRoot, selfInstallDir);
  if (selfRelative.startsWith("..") || path.isAbsolute(selfRelative)) throw new Error("SUPERVISOR_SELF_INSTALL_DIR must be inside SUPERVISOR_MANAGED_ROOT");

  const socketHostDir = path.resolve(env.SUPERVISOR_SOCKET_DIR?.trim() || (namespace === "default" ? "/run/sensorsphere-supervisor-agent" : `/run/sensorsphere/${namespace}`));

  return {
    environment,
    namespace,
    composeProjectName: env.COMPOSE_PROJECT_NAME?.trim() || `sensorsphere-${namespace}-supervisor`,
    socketHostDir,
    socketPath: env.SUPERVISOR_SOCKET_PATH?.trim() || "/run/sensorsphere-supervisor-agent/supervisor.sock",
    socketGid: parseInteger("SUPERVISOR_SOCKET_GID", env.SUPERVISOR_SOCKET_GID, 0),
    managedRoot: resolvedManagedRoot,
    additionalManagedRoot,
    defaultPuid: parseInteger("SUPERVISOR_DEFAULT_PUID", env.SUPERVISOR_DEFAULT_PUID, 1000),
    defaultPgid: parseInteger("SUPERVISOR_DEFAULT_PGID", env.SUPERVISOR_DEFAULT_PGID, 1000),
    operationTimeoutMs: Math.max(parseInteger("SUPERVISOR_OPERATION_TIMEOUT_MS", env.SUPERVISOR_OPERATION_TIMEOUT_MS, 600_000), 600_000),
    selfInstallDir,
    selfUpdateStatusFile: path.join(selfInstallDir, ".supervisor-update-status.json"),
    selfUpdateTimeoutMs: parseInteger("SUPERVISOR_SELF_UPDATE_TIMEOUT_MS", env.SUPERVISOR_SELF_UPDATE_TIMEOUT_MS, 120_000),
    sensorsphereUrl: env.SENSORSPHERE_URL?.trim() || null,
    sensorsphereAgentToken: env.SENSORSPHERE_AGENT_TOKEN?.trim() || null,
    supervisorName: env.SUPERVISOR_NAME?.trim() || null,
    sensorsphereHeartbeatIntervalMs: parseInteger("SENSORSPHERE_HEARTBEAT_INTERVAL_MS", env.SENSORSPHERE_HEARTBEAT_INTERVAL_MS, 30_000),
  };
}

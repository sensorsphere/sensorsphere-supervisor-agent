import path from "node:path";

export interface SupervisorConfig {
  socketPath: string;
  socketGid: number;
  managedAgentInstallDir: string;
  managedImage: string;
  composeSourceUrlTemplate: string;
  updateTimeoutMs: number;
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
  const installDir = required("SUPERVISOR_MANAGED_AGENT_INSTALL_DIR", env.SUPERVISOR_MANAGED_AGENT_INSTALL_DIR);
  if (!path.isAbsolute(installDir)) throw new Error("SUPERVISOR_MANAGED_AGENT_INSTALL_DIR must be absolute");

  const template = env.SUPERVISOR_COMPOSE_SOURCE_URL_TEMPLATE?.trim()
    || "https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/v{version}/docker-compose.yml";
  if (!template.includes("{version}")) throw new Error("SUPERVISOR_COMPOSE_SOURCE_URL_TEMPLATE must contain {version}");

  return {
    socketPath: env.SUPERVISOR_SOCKET_PATH?.trim() || "/run/sensorsphere-supervisor-agent/supervisor.sock",
    socketGid: parseInteger("SUPERVISOR_SOCKET_GID", env.SUPERVISOR_SOCKET_GID, 0),
    managedAgentInstallDir: path.resolve(installDir),
    managedImage: env.SUPERVISOR_MANAGED_IMAGE?.trim() || "ghcr.io/sensorsphere/sensorsphere-device-agent",
    composeSourceUrlTemplate: template,
    updateTimeoutMs: parseInteger("SUPERVISOR_UPDATE_TIMEOUT_MS", env.SUPERVISOR_UPDATE_TIMEOUT_MS, 120_000),
  };
}

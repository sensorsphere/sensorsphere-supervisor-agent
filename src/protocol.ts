export type SupervisorAction = "GET_STATUS" | "DEPLOY_AGENT" | "UPDATE_AGENT" | "REMOVE_AGENT" | "GET_SELF_STATUS" | "UPDATE_SELF";
export type ManagedAgentType = "device-agent" | "monitor-agent";

export interface SupervisorRequest {
  request_id: string;
  action: SupervisorAction;
  agent_type?: ManagedAgentType;
  instance?: string;
  version?: string;
  environment?: Record<string, string>;
}

export interface SupervisorResponse {
  request_id: string;
  ok: boolean;
  action: SupervisorAction;
  result?: unknown;
  error?: string;
}

const ACTIONS = new Set<SupervisorAction>(["GET_STATUS", "DEPLOY_AGENT", "UPDATE_AGENT", "REMOVE_AGENT", "GET_SELF_STATUS", "UPDATE_SELF"]);
const AGENT_TYPES = new Set<ManagedAgentType>(["device-agent", "monitor-agent"]);

export function parseRequest(line: string): SupervisorRequest {
  const raw = JSON.parse(line) as Partial<SupervisorRequest>;
  if (typeof raw.request_id !== "string" || raw.request_id.trim() === "") {
    throw new Error("request_id is required");
  }
  if (typeof raw.action !== "string" || !ACTIONS.has(raw.action as SupervisorAction)) {
    throw new Error("unsupported action");
  }

  if (raw.agent_type !== undefined && !AGENT_TYPES.has(raw.agent_type)) {
    throw new Error("unsupported agent_type");
  }
  if (raw.instance !== undefined && typeof raw.instance !== "string") {
    throw new Error("instance must be a string");
  }

  if ((raw.action === "DEPLOY_AGENT" || raw.action === "REMOVE_AGENT") && !raw.agent_type) {
    throw new Error(`agent_type is required for ${raw.action}`);
  }
  if ((raw.action === "DEPLOY_AGENT" || raw.action === "UPDATE_AGENT" || raw.action === "UPDATE_SELF")
      && (typeof raw.version !== "string" || raw.version.trim() === "")) {
    throw new Error(`version is required for ${raw.action}`);
  }
  if (raw.environment !== undefined) {
    if (raw.environment === null || Array.isArray(raw.environment) || typeof raw.environment !== "object") {
      throw new Error("environment must be an object");
    }
    for (const [key, value] of Object.entries(raw.environment)) {
      if (typeof value !== "string") throw new Error(`environment value for ${key} must be a string`);
    }
  }

  return raw as SupervisorRequest;
}

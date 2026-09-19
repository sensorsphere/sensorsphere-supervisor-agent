export type SupervisorAction = "GET_STATUS" | "UPDATE_AGENT";

export interface SupervisorRequest {
  request_id: string;
  action: SupervisorAction;
  version?: string;
}

export interface SupervisorResponse {
  request_id: string;
  ok: boolean;
  action: SupervisorAction;
  result?: unknown;
  error?: string;
}

export function parseRequest(line: string): SupervisorRequest {
  const raw = JSON.parse(line) as Partial<SupervisorRequest>;
  if (typeof raw.request_id !== "string" || raw.request_id.trim() === "") {
    throw new Error("request_id is required");
  }
  if (raw.action !== "GET_STATUS" && raw.action !== "UPDATE_AGENT") {
    throw new Error("unsupported action");
  }
  if (raw.action === "UPDATE_AGENT" && (typeof raw.version !== "string" || raw.version.trim() === "")) {
    throw new Error("version is required for UPDATE_AGENT");
  }
  return raw as SupervisorRequest;
}

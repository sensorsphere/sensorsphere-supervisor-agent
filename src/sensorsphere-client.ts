import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import type { SupervisorConfig } from "./config.js";
import type { ManagedAgentManager, ManagedAssignment } from "./manager.js";
import type { SelfUpdateManager } from "./self-manager.js";

interface RemoteCommand {
  type: "SUPERVISOR_COMMAND";
  commandId: string;
  operation: "LIST" | "DEPLOY" | "UPDATE" | "REMOVE" | "UPDATE_SELF";
  agentType?: "device-agent" | "monitor-agent";
  instance?: string;
  version?: string;
  environment?: Record<string, string>;
  managementId?: string;
  agentId?: string;
  installDir?: string;
}

interface ManagedAssignmentMessage {
  id: string;
  agentType: "device-agent" | "monitor-agent";
  agentId: string;
  instance: string;
  installDir: string | null;
}

function reportedHostname(): string {
  try {
    const value = fs.readFileSync("/host/etc/hostname", "utf8").trim();
    if (value) return value;
  } catch {
    // Older deployments may not mount the host hostname yet.
  }
  return os.hostname();
}

function wsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/device-control/supervisor/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class SensorSphereSupervisorClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly config: SupervisorConfig,
    private readonly version: string,
    private readonly manager: ManagedAgentManager,
    private readonly selfManager: SelfUpdateManager
  ) {}

  start(): void {
    if (!this.config.sensorsphereUrl || !this.config.sensorsphereAgentToken) {
      console.log(JSON.stringify({ message: "Supervisor direct SensorSphere connection disabled", reason: "SENSORSPHERE_URL or SENSORSPHERE_AGENT_TOKEN not configured" }));
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped || !this.config.sensorsphereUrl || !this.config.sensorsphereAgentToken) return;
    const socket = new WebSocket(wsUrl(this.config.sensorsphereUrl), {
      headers: { Authorization: `Bearer ${this.config.sensorsphereAgentToken}` }
    });
    this.socket = socket;

    socket.on("open", () => {
      console.log(JSON.stringify({ url: wsUrl(this.config.sensorsphereUrl!), message: "Supervisor connected directly to SensorSphere" }));
      void this.sendHello();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, this.config.sensorsphereHeartbeatIntervalMs);
      this.heartbeatTimer.unref();
    });

    socket.on("message", data => {
      void this.handleMessage(data.toString()).catch(error => {
        console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), message: "Supervisor remote command failed" }));
      });
    });

    socket.on("error", error => {
      console.error(JSON.stringify({ error: error.message, message: "Supervisor SensorSphere WebSocket error" }));
    });

    socket.on("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.socket = null;
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        this.reconnectTimer.unref();
      }
    });
  }

  private async snapshot() {
    const [managedAgents, selfStatus] = await Promise.all([
      this.manager.listStatuses(),
      this.selfManager.getStatus()
    ]);
    return { managedAgents, selfStatus };
  }

  private async sendHello(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const snapshot = await this.snapshot();
    this.socket.send(JSON.stringify({
      type: "HELLO",
      supervisorName: this.config.supervisorName || reportedHostname(),
      version: this.version,
      hostname: reportedHostname(),
      systemInfo: { os: os.type(), osVersion: os.release(), architecture: os.arch() },
      selfUpdateSupported: true,
      ...snapshot
    }));
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const snapshot = await this.snapshot();
    this.socket.send(JSON.stringify({ type: "HEARTBEAT", ...snapshot }));
  }

  private async handleMessage(text: string): Promise<void> {
    const message = JSON.parse(text) as { type?: string; managedAssignments?: ManagedAssignmentMessage[] } & Omit<Partial<RemoteCommand>, "type">;
    if (message.type === "HELLO_ACK" || message.type === "MANAGED_ASSIGNMENTS") {
      const assignments: ManagedAssignment[] = Array.isArray(message.managedAssignments)
        ? message.managedAssignments
            .filter(item => item && typeof item.id === "string" && typeof item.agentId === "string" && (item.agentType === "device-agent" || item.agentType === "monitor-agent") && typeof item.instance === "string")
            .map(item => ({ id: item.id, agentType: item.agentType, agentId: item.agentId, instance: item.instance, installDir: typeof item.installDir === "string" ? item.installDir : null }))
        : [];
      this.manager.setManagedAssignments(assignments);
      return;
    }
    if (message.type !== "SUPERVISOR_COMMAND" || !message.commandId || !message.operation) return;
    let result: unknown;
    try {
      switch (message.operation) {
        case "LIST":
          result = await this.manager.listStatuses();
          break;
        case "DEPLOY":
          if (!message.agentType || !message.version) throw new Error("agentType and version are required");
          result = await this.manager.deploy(message.agentType, message.instance ?? "main", message.version, message.environment ?? {});
          break;
        case "UPDATE":
          if (!message.agentType || !message.version) throw new Error("agentType and version are required");
          result = await this.manager.update(message.version, message.agentType, message.instance ?? "main");
          break;
        case "REMOVE":
          if (!message.agentType) throw new Error("agentType is required");
          result = await this.manager.remove(message.agentType, message.instance ?? "main");
          break;
        case "UPDATE_SELF":
          if (!message.version) throw new Error("version is required");
          result = await this.selfManager.updateSelf(message.version);
          break;
      }
      this.socket?.send(JSON.stringify({ type: "SUPERVISOR_COMMAND_RESULT", commandId: message.commandId, operation: message.operation, status: "SUCCESS", result }));
    } catch (error) {
      this.socket?.send(JSON.stringify({ type: "SUPERVISOR_COMMAND_RESULT", commandId: message.commandId, operation: message.operation, status: "FAILED", error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

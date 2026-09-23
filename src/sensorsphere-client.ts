import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import type { SupervisorConfig } from "./config.js";
import type { ManagedAgentManager, ManagedAssignment } from "./manager.js";
import type { SelfUpdateManager } from "./self-manager.js";

interface RemoteCommand {
  type: "SUPERVISOR_COMMAND";
  commandId: string;
  operation: "LIST" | "DEPLOY" | "UPDATE" | "REMOVE" | "CHECK_TOKEN" | "GET_PROXMOX_CONFIG" | "SET_PROXMOX_CONFIG" | "DELETE_PROXMOX_CONFIG" | "UPDATE_SELF";
  agentType?: "device-agent" | "monitor-agent";
  instance?: string;
  version?: string;
  environment?: Record<string, string>;
  managementId?: string;
  agentId?: string;
  installDir?: string;
  config?: unknown;
}


export interface HostNetworkAddress {
  family: "IPv4" | "IPv6";
  address: string;
  prefixLength: number;
  cidr: string;
  network: string | null;
}

export interface HostNetworkInterface {
  interface: string;
  mac: string | null;
  addresses: HostNetworkAddress[];
}

function ipv4Network(address: string, prefixLength: number): string | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255) || prefixLength < 0 || prefixLength > 32) return null;
  const value = (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (value & mask) >>> 0;
  return `${(network >>> 24) & 255}.${(network >>> 16) & 255}.${(network >>> 8) & 255}.${network & 255}/${prefixLength}`;
}

function excludedInterface(name: string): boolean {
  return name === "lo" || name === "docker0" || /^br-[0-9a-f]+$/i.test(name) || /^veth/i.test(name) || /^cni/i.test(name) || /^flannel/i.test(name);
}

function excludedAddress(family: string, address: string, internal: boolean): boolean {
  if (internal) return true;
  if (family === "IPv4") return address.startsWith("127.") || address.startsWith("169.254.");
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fe80:");
}

export function collectHostNetworks(): HostNetworkInterface[] {
  const interfaces = os.networkInterfaces();
  const result: HostNetworkInterface[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || excludedInterface(name)) continue;
    const addresses: HostNetworkAddress[] = [];
    let mac: string | null = null;
    for (const entry of entries) {
      const rawFamily = String(entry.family);
      const family = rawFamily === "IPv4" || rawFamily === "4" ? "IPv4" : rawFamily === "IPv6" || rawFamily === "6" ? "IPv6" : null;
      if (!family || excludedAddress(family, entry.address, entry.internal)) continue;
      const cidr = entry.cidr || `${entry.address}/${family === "IPv4" ? 32 : 128}`;
      const prefixLength = Number.parseInt(cidr.split("/").pop() || (family === "IPv4" ? "32" : "128"), 10);
      addresses.push({ family, address: entry.address, prefixLength, cidr, network: family === "IPv4" ? ipv4Network(entry.address, prefixLength) : null });
      if (!mac && entry.mac && entry.mac !== "00:00:00:00:00:00") mac = entry.mac.toLowerCase();
    }
    if (addresses.length > 0 || mac) result.push({ interface: name, mac, addresses });
  }
  return result.sort((a, b) => a.interface.localeCompare(b.interface, undefined, { numeric: true, sensitivity: "base" }));
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
      hostNetworks: collectHostNetworks(),
      ...snapshot
    }));
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const snapshot = await this.snapshot();
    this.socket.send(JSON.stringify({ type: "HEARTBEAT", hostNetworks: collectHostNetworks(), ...snapshot }));
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
        case "GET_PROXMOX_CONFIG":
          result = await this.manager.getProxmoxConfig(message.instance ?? "main");
          break;
        case "SET_PROXMOX_CONFIG":
          result = await this.manager.setProxmoxConfig(message.instance ?? "main", message.config);
          break;
        case "DELETE_PROXMOX_CONFIG":
          result = await this.manager.deleteProxmoxConfig(message.instance ?? "main");
          break;
        case "CHECK_TOKEN":
          if (message.agentType) {
            result = await this.manager.checkToken(message.agentType, message.instance ?? "main");
          } else {
            const token = this.config.sensorsphereAgentToken;
            if (!token) throw new Error("SENSORSPHERE_AGENT_TOKEN is not configured");
            const tokenHash = createHash("sha256").update(token).digest("hex");
            result = {
              token_hash: tokenHash,
              token_fingerprint: `${tokenHash.slice(0, 4).toUpperCase()}-${tokenHash.slice(4, 8).toUpperCase()}`,
              runtime_token_hash: tokenHash,
              runtime_token_fingerprint: `${tokenHash.slice(0, 4).toUpperCase()}-${tokenHash.slice(4, 8).toUpperCase()}`,
              runtime_token_present: true,
              runtime_sensorsphere_url: this.config.sensorsphereUrl
            };
          }
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

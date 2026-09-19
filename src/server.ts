import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { SupervisorConfig } from "./config.js";
import type { ManagedAgentManager } from "./manager.js";
import type { SelfUpdateManager } from "./self-manager.js";
import { parseRequest, type SupervisorResponse } from "./protocol.js";

export async function startServer(config: SupervisorConfig, manager: ManagedAgentManager, selfManager: SelfUpdateManager): Promise<net.Server> {
  await fs.mkdir(path.dirname(config.socketPath), { recursive: true });
  await fs.rm(config.socketPath, { force: true });

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void handleLine(line, socket, manager, selfManager);
        newline = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => resolve());
  });

  await fs.chmod(config.socketPath, 0o660);
  await fs.chown(config.socketPath, 0, config.socketGid);
  return server;
}

async function handleLine(line: string, socket: net.Socket, manager: ManagedAgentManager, selfManager: SelfUpdateManager): Promise<void> {
  let requestId = "unknown";
  let action: SupervisorResponse["action"] = "GET_STATUS";
  try {
    const request = parseRequest(line);
    requestId = request.request_id;
    action = request.action;
    let result: unknown;
    switch (request.action) {
      case "GET_STATUS":
        result = await manager.getStatus(request.agent_type ?? "device-agent", request.instance ?? "main");
        break;
      case "DEPLOY_AGENT":
        result = await manager.deploy(request.agent_type!, request.instance ?? "main", request.version!, request.environment ?? {});
        break;
      case "UPDATE_AGENT":
        // Backward compatibility: Device Agent 1.2.x sends UPDATE_AGENT without an explicit target.
        result = await manager.update(request.version!, request.agent_type ?? "device-agent", request.instance ?? "main");
        break;
      case "REMOVE_AGENT":
        result = await manager.remove(request.agent_type!, request.instance ?? "main");
        break;
      case "GET_SELF_STATUS":
        result = await selfManager.getStatus();
        break;
      case "UPDATE_SELF":
        result = await selfManager.updateSelf(request.version!);
        break;
    }
    const response: SupervisorResponse = { request_id: requestId, ok: true, action, result };
    socket.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    const response: SupervisorResponse = {
      request_id: requestId,
      ok: false,
      action,
      error: error instanceof Error ? error.message : String(error),
    };
    socket.write(`${JSON.stringify(response)}\n`);
  }
}

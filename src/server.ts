import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { SupervisorConfig } from "./config.js";
import type { DeviceAgentManager } from "./manager.js";
import { parseRequest, type SupervisorResponse } from "./protocol.js";

export async function startServer(config: SupervisorConfig, manager: DeviceAgentManager): Promise<net.Server> {
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
        if (line) void handleLine(line, socket, manager);
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

async function handleLine(line: string, socket: net.Socket, manager: DeviceAgentManager): Promise<void> {
  let requestId = "unknown";
  let action: "GET_STATUS" | "UPDATE_AGENT" = "GET_STATUS";
  try {
    const request = parseRequest(line);
    requestId = request.request_id;
    action = request.action;
    const result = request.action === "GET_STATUS"
      ? await manager.getStatus()
      : await manager.update(request.version!);
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

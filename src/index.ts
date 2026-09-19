import fs from "node:fs";
import { loadConfig } from "./config.js";
import { ManagedAgentManager } from "./manager.js";
import { ExecCommandRunner } from "./runner.js";
import { startServer } from "./server.js";

const config = loadConfig();
const manager = new ManagedAgentManager(config, new ExecCommandRunner());
const version = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

await startServer(config, manager);

console.log(JSON.stringify({
  version,
  socket_path: config.socketPath,
  managed_root: config.managedRoot,
  managed_agent_types: ["device-agent", "monitor-agent"],
  message: "SensorSphere Supervisor Agent started",
}));

import fs from "node:fs";
import { loadConfig } from "./config.js";
import { ManagedAgentManager } from "./manager.js";
import { ExecCommandRunner } from "./runner.js";
import { startServer } from "./server.js";
import { SelfUpdateManager } from "./self-manager.js";

const config = loadConfig();
const runner = new ExecCommandRunner();
const manager = new ManagedAgentManager(config, runner);
const selfManager = new SelfUpdateManager(config, runner);
const version = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

await startServer(config, manager, selfManager);

console.log(JSON.stringify({
  version,
  socket_path: config.socketPath,
  managed_root: config.managedRoot,
  managed_agent_types: ["device-agent", "monitor-agent"],
  self_update: true,
  message: "SensorSphere Supervisor Agent started",
}));

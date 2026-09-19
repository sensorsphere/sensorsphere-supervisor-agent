import fs from "node:fs";
import { loadConfig } from "./config.js";
import { DeviceAgentManager } from "./manager.js";
import { ExecCommandRunner } from "./runner.js";
import { startServer } from "./server.js";

const config = loadConfig();
const manager = new DeviceAgentManager(config, new ExecCommandRunner());
const version = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

await startServer(config, manager);

console.log(JSON.stringify({
  version,
  socket_path: config.socketPath,
  managed_agent_install_dir: config.managedAgentInstallDir,
  managed_image: config.managedImage,
  message: "SensorSphere Supervisor Agent started",
}));

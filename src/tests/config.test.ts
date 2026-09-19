import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loadConfig requires an absolute managed installation directory", () => {
  assert.throws(() => loadConfig({ SUPERVISOR_MANAGED_AGENT_INSTALL_DIR: "relative" }), /must be absolute/);
});

test("loadConfig uses safe defaults", () => {
  const config = loadConfig({ SUPERVISOR_MANAGED_AGENT_INSTALL_DIR: "/srv/device-agent" });
  assert.equal(config.managedImage, "ghcr.io/sensorsphere/sensorsphere-device-agent");
  assert.equal(config.socketPath, "/run/sensorsphere-supervisor-agent/supervisor.sock");
  assert.equal(config.updateTimeoutMs, 120000);
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loadConfig requires an absolute managed root", () => {
  assert.throws(() => loadConfig({ SUPERVISOR_MANAGED_ROOT: "relative" }), /must be absolute/);
});

test("loadConfig uses safe defaults", () => {
  const config = loadConfig({ SUPERVISOR_MANAGED_ROOT: "/srv/sensorsphere" });
  assert.equal(config.managedRoot, "/srv/sensorsphere");
  assert.equal(config.defaultPuid, 1000);
  assert.equal(config.defaultPgid, 1000);
  assert.equal(config.socketPath, "/run/sensorsphere-supervisor-agent/supervisor.sock");
  assert.equal(config.operationTimeoutMs, 120000);
});

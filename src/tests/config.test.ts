import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loadConfig requires an absolute managed root", () => {
  assert.throws(() => loadConfig({ SUPERVISOR_MANAGED_ROOT: "relative" }), /must be absolute/);
});

test("loadConfig uses safe defaults including self-update paths", () => {
  const config = loadConfig({ SUPERVISOR_MANAGED_ROOT: "/srv/sensorsphere" });
  assert.equal(config.environment, "DEFAULT");
  assert.equal(config.namespace, "default");
  assert.equal(config.composeProjectName, "sensorsphere-default-supervisor");
  assert.equal(config.managedRoot, "/srv/sensorsphere");
  assert.equal(config.defaultPuid, 1000);
  assert.equal(config.defaultPgid, 1000);
  assert.equal(config.socketHostDir, "/run/sensorsphere-supervisor-agent");
  assert.equal(config.socketPath, "/run/sensorsphere-supervisor-agent/supervisor.sock");
  assert.equal(config.operationTimeoutMs, 600000);
  assert.equal(config.selfInstallDir, "/srv/sensorsphere/sensorsphere-supervisor-agent");
  assert.equal(config.selfUpdateStatusFile, "/srv/sensorsphere/sensorsphere-supervisor-agent/.supervisor-update-status.json");
  assert.equal(config.selfUpdateTimeoutMs, 120000);
});

test("loadConfig clamps legacy managed-operation timeouts to ten minutes", () => {
  const config = loadConfig({ SUPERVISOR_MANAGED_ROOT: "/srv/sensorsphere", SUPERVISOR_OPERATION_TIMEOUT_MS: "120000" });
  assert.equal(config.operationTimeoutMs, 600000);
});

test("loadConfig rejects a self install directory outside the managed root", () => {
  assert.throws(
    () => loadConfig({ SUPERVISOR_MANAGED_ROOT: "/srv/sensorsphere", SUPERVISOR_SELF_INSTALL_DIR: "/opt/supervisor" }),
    /must be inside/,
  );
});


test("loadConfig normalizes an explicit SensorSphere environment", () => {
  const config = loadConfig({ SENSORSPHERE_ENVIRONMENT: "dit", SUPERVISOR_MANAGED_ROOT: "/srv/sensorsphere-DIT" });
  assert.equal(config.environment, "DIT");
  assert.equal(config.namespace, "dit");
  assert.equal(config.composeProjectName, "sensorsphere-dit-supervisor");
  assert.equal(config.socketHostDir, "/run/sensorsphere/dit");
  assert.equal(config.socketPath, "/run/sensorsphere-supervisor-agent/supervisor.sock");
  assert.equal(config.additionalManagedRoot, "/opt/sensorsphere-DIT");
});

test("loadConfig rejects an invalid SensorSphere environment", () => {
  assert.throws(() => loadConfig({ SENSORSPHERE_ENVIRONMENT: "DIT PROD", SUPERVISOR_MANAGED_ROOT: "/srv/sensorsphere" }), /SENSORSPHERE_ENVIRONMENT/);
});

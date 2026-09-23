import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SupervisorConfig } from "../config.js";
import { ManagedAgentManager } from "../manager.js";
import type { CommandResult, CommandRunner } from "../runner.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  failOn: string | null = null;
  image = "ghcr.io/sensorsphere/sensorsphere-device-agent:1.2.1";

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const joined = `${command} ${args.join(" ")}`;
    if (this.failOn && joined.includes(this.failOn)) throw new Error(`forced failure: ${this.failOn}`);
    if (args.includes("-q") && (args.includes("device-agent") || args.includes("monitor-agent"))) {
      return { stdout: "container123\n", stderr: "" };
    }
    if (command === "docker" && args[0] === "inspect") return { stdout: `running|${this.image}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  }
}

async function fixture(): Promise<{ root: string; config: SupervisorConfig; runner: FakeRunner }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
  return {
    root,
    config: {
      socketPath: path.join(root, "supervisor.sock"),
      socketGid: 0,
      managedRoot: root,
      additionalManagedRoot: null,
      defaultPuid: 0,
      defaultPgid: 0,
      operationTimeoutMs: 1000,
      selfInstallDir: path.join(root, "sensorsphere-supervisor-agent"),
      selfUpdateStatusFile: path.join(root, "sensorsphere-supervisor-agent", ".supervisor-update-status.json"),
      selfUpdateTimeoutMs: 1000,
      sensorsphereUrl: null,
      sensorsphereAgentToken: null,
      supervisorName: null,
      sensorsphereHeartbeatIntervalMs: 30_000,
    },
    runner: new FakeRunner(),
  };
}

async function existingDevice(root: string): Promise<string> {
  const dir = path.join(root, "sensorsphere-device-agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, ".env"),
    "SENSORSPHERE_URL=http://example\nDEVICE_AGENT_IMAGE=ghcr.io/sensorsphere/sensorsphere-device-agent:1.2.0\n",
    "utf8",
  );
  await fs.writeFile(path.join(dir, "docker-compose.yml"), "services:\n  device-agent:\n    image: test\n", "utf8");
  return dir;
}

const fetchForKnownAgents: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("sensorsphere-monitor-agent")) {
    return new Response("services:\n  monitor-agent:\n    image: test\n", { status: 200 });
  }
  return new Response("services:\n  device-agent:\n    image: test\n", { status: 200 });
};

test("legacy status resolves to device-agent/main", async () => {
  const { root, config, runner } = await fixture();
  await existingDevice(root);
  runner.image = "ghcr.io/sensorsphere/sensorsphere-device-agent:1.2.0";
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  const status = await manager.getStatus();
  assert.equal(status.agent_type, "device-agent");
  assert.equal(status.instance, "main");
  assert.equal(status.installed, true);
  assert.equal(status.configured_version, "1.2.0");
});

test("status for an absent named instance is safe", async () => {
  const { config, runner } = await fixture();
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  const status = await manager.getStatus("monitor-agent", "i2");
  assert.equal(status.installed, false);
  assert.equal(status.container_state, "not_installed");
  assert.match(status.install_dir, /sensorsphere-monitor-agent-i2$/);
  assert.equal(runner.calls.length, 0);
});

test("deploy creates a monitor-agent instance from the known registry", async () => {
  const { root, config, runner } = await fixture();
  runner.image = "ghcr.io/sensorsphere/sensorsphere-monitor-agent:1.0.9";
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  const result = await manager.deploy("monitor-agent", "i2", "1.0.9", {
    SENSORSPHERE_URL: "http://example",
    SENSORSPHERE_AGENT_TOKEN: "ssma_test",
    AGENT_NAME: "monitor-i2",
  });
  const dir = path.join(root, "sensorsphere-monitor-agent-i2");
  const env = await fs.readFile(path.join(dir, ".env"), "utf8");
  assert.match(env, /MONITOR_AGENT_IMAGE=ghcr\.io\/sensorsphere\/sensorsphere-monitor-agent:1\.0\.9/);
  assert.match(env, /SENSORSPHERE_AGENT_TOKEN="ssma_test"/);
  assert.match(env, /PUID="0"/);
  assert.equal(result.target_version, "1.0.9");
  assert.ok(runner.calls.some(({ args }) => args.includes("pull") && args.includes("monitor-agent")));
  assert.ok(runner.calls.some(({ args }) => args.includes("up") && args.includes("monitor-agent")));
});

test("deploy rejects missing secrets and non-allowlisted environment keys", async () => {
  const { config, runner } = await fixture();
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  await assert.rejects(
    () => manager.deploy("monitor-agent", "main", "1.0.9", { SENSORSPHERE_URL: "http://example" }),
    /SENSORSPHERE_AGENT_TOKEN is required/,
  );
  await assert.rejects(
    () => manager.deploy("device-agent", "main", "1.2.0", {
      SENSORSPHERE_URL: "http://example",
      SENSORSPHERE_DEVICE_AGENT_TOKEN: "ssda_test",
      EVIL_IMAGE: "alpine:latest",
    }),
    /EVIL_IMAGE is not allowed/,
  );
  assert.equal(runner.calls.length, 0);
});

test("deploy rejects cross-agent token types", async () => {
  const { config, runner } = await fixture();
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  await assert.rejects(() => manager.deploy("monitor-agent", "main", "1.0.10", { SENSORSPHERE_URL: "http://example", SENSORSPHERE_AGENT_TOKEN: "sssa_wrong" }), /ssma_/);
  await assert.rejects(() => manager.deploy("device-agent", "main", "1.9.0", { SENSORSPHERE_URL: "http://example", SENSORSPHERE_DEVICE_AGENT_TOKEN: "ssma_wrong" }), /ssda_/);
});

test("managed updates require the exact SensorSphere association", async () => {
  const { root, config, runner } = await fixture();
  const dir = path.join(root, "sensorsphere-monitor-agent-i1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".env"), "MONITOR_AGENT_IMAGE=ghcr.io/sensorsphere/sensorsphere-monitor-agent:1.0.9\nSENSORSPHERE_AGENT_TOKEN=ssma_test\n", "utf8");
  await fs.writeFile(path.join(dir, "docker-compose.yml"), "services:\n  monitor-agent:\n    image: test\n", "utf8");
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  manager.setManagedAssignments([{ id: "management-i1", agentType: "monitor-agent", agentId: "agent-i1", instance: "i1", installDir: dir }]);
  assert.doesNotThrow(() => manager.assertManagedAssignment("monitor-agent", "i1", "management-i1", "agent-i1"));
  assert.throws(() => manager.assertManagedAssignment("monitor-agent", "main", "management-i1", "agent-i1"), /not explicitly associated/);
  assert.throws(() => manager.assertManagedAssignment("monitor-agent", "i1", "management-i1", "other-agent"), /does not match/);
});


test("renaming a Proxmox endpoint preserves the existing token secret", async () => {
  const { root, config, runner } = await fixture();
  const dir = await existingDevice(root);
  const configDir = path.join(dir, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "proxmox.yml"), [
    "version: 1",
    "endpoints:",
    '  - id: "pve-1"',
    '    product: "PVE"',
    '    url: "https://7.0.100.11:8006"',
    '    token_id: "sensorsphere@pve!device-agent2"',
    '    token_secret: "existing-secret"',
    "    verify_tls: false",
    "",
  ].join("\n"), "utf8");

  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  const result = await manager.setProxmoxConfig("main", { endpoints: [{
    id: "pve-cluster",
    originalId: "pve-1",
    product: "PVE",
    url: "https://7.0.100.11:8006",
    tokenId: "sensorsphere@pve!device-agent2",
    verifyTls: false,
  }] });

  const written = await fs.readFile(path.join(configDir, "proxmox.yml"), "utf8");
  assert.match(written, /id: "pve-cluster"/);
  assert.doesNotMatch(written, /id: "pve-1"/);
  assert.match(written, /token_secret: "existing-secret"/);
  assert.deepEqual(result, {
    configured: true,
    config_path: path.join(configDir, "proxmox.yml"),
    endpoints: [{
      id: "pve-cluster",
      product: "PVE",
      url: "https://7.0.100.11:8006",
      tokenId: "sensorsphere@pve!device-agent2",
      tokenSecretConfigured: true,
      verifyTls: false,
    }],
  });
});

test("legacy update still updates device-agent/main and rolls back on failure", async () => {
  const { root, config, runner } = await fixture();
  const dir = await existingDevice(root);
  runner.image = "ghcr.io/sensorsphere/sensorsphere-device-agent:1.2.1";
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  const result = await manager.update("1.2.1", "device-agent", "main");
  assert.equal(result.target_version, "1.2.1");
  assert.match(await fs.readFile(path.join(dir, ".env"), "utf8"), /DEVICE_AGENT_IMAGE=.*:1\.2\.1/);

  runner.failOn = "up -d --no-deps device-agent";
  await assert.rejects(() => manager.update("1.2.2", "device-agent", "main"), /forced failure/);
  assert.match(await fs.readFile(path.join(dir, ".env"), "utf8"), /DEVICE_AGENT_IMAGE=.*:1\.2\.1/);
});

test("remove archives an installation instead of deleting it", async () => {
  const { root, config, runner } = await fixture();
  await existingDevice(root);
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  const result = await manager.remove("device-agent", "main");
  assert.equal(result.removed, true);
  assert.match(String(result.archive_dir), /sensorsphere-device-agent\.removed-/);
  assert.equal(await fs.stat(String(result.archive_dir)).then(() => true), true);
  await assert.rejects(() => fs.stat(path.join(root, "sensorsphere-device-agent")));
});

test("explicit SensorSphere association can manage an installation outside the conventional directory", async () => {
  const { root, config, runner } = await fixture();
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-external-"));
  config.additionalManagedRoot = externalRoot;
  const customDir = path.join(externalRoot, "mysensorsphere-device-agent-i1");
  await fs.mkdir(customDir, { recursive: true });
  await fs.writeFile(path.join(customDir, ".env"), "DEVICE_AGENT_IMAGE=ghcr.io/sensorsphere/sensorsphere-device-agent:1.8.2\n", "utf8");
  await fs.writeFile(path.join(customDir, "docker-compose.yml"), "services:\n  device-agent:\n    image: test\n", "utf8");
  runner.image = "ghcr.io/sensorsphere/sensorsphere-device-agent:1.8.2";
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  manager.setManagedAssignments([{ id: "management-1", agentType: "device-agent", agentId: "agent-1", instance: "i1", installDir: customDir }]);
  const status = await manager.getStatus("device-agent", "i1");
  assert.equal(status.management_id, "management-1");
  assert.equal(status.sensor_sphere_agent_id, "agent-1");
  assert.equal(status.install_dir, customDir);
  assert.equal(status.reconciliation_status, "MANAGED");
});

test("invalid versions and path-like instance names are rejected", async () => {
  const { config, runner } = await fixture();
  const manager = new ManagedAgentManager(config, runner, fetchForKnownAgents);
  await assert.rejects(() => manager.update("../../latest", "device-agent", "main"), /invalid target version/);
  await assert.rejects(() => manager.getStatus("monitor-agent", "../x"), /invalid instance name/);
  assert.equal(runner.calls.length, 0);
});

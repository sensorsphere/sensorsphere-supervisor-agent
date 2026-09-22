import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SupervisorConfig } from "../config.js";
import type { CommandResult, CommandRunner } from "../runner.js";
import { SelfUpdateManager } from "../self-manager.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  runningImage = "ghcr.io/sensorsphere/sensorsphere-supervisor-agent:0.3.0";

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command === "docker" && args[0] === "compose" && args.includes("-q")) {
      return { stdout: "supervisor123\n", stderr: "" };
    }
    if (command === "docker" && args[0] === "inspect") {
      return { stdout: `running|${this.runningImage}\n`, stderr: "" };
    }
    if (command === "docker" && args[0] === "run") {
      return { stdout: "helper123\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

async function fixture(): Promise<{ root: string; installDir: string; config: SupervisorConfig; runner: FakeRunner }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-self-test-"));
  const installDir = path.join(root, "sensorsphere-supervisor-agent");
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(
    path.join(installDir, ".env"),
    "SUPERVISOR_AGENT_IMAGE=ghcr.io/sensorsphere/sensorsphere-supervisor-agent:0.3.0\nSUPERVISOR_MANAGED_ROOT=" + root + "\n",
    "utf8",
  );
  await fs.writeFile(path.join(installDir, "docker-compose.yml"), "services:\n  supervisor-agent:\n    image: test\n", "utf8");
  const config: SupervisorConfig = {
    socketPath: path.join(root, "run", "supervisor.sock"),
    socketGid: 0,
    managedRoot: root,
    additionalManagedRoot: null,
    defaultPuid: 0,
    defaultPgid: 0,
    operationTimeoutMs: 1000,
    selfInstallDir: installDir,
    selfUpdateStatusFile: path.join(installDir, ".supervisor-update-status.json"),
    selfUpdateTimeoutMs: 1000,
    sensorsphereUrl: null,
    sensorsphereAgentToken: null,
    supervisorName: null,
    sensorsphereHeartbeatIntervalMs: 30_000,
  };
  return { root, installDir, config, runner: new FakeRunner() };
}

test("GET_SELF_STATUS reports configured/running version and idle update state", async () => {
  const { config, runner } = await fixture();
  const manager = new SelfUpdateManager(config, runner);
  const status = await manager.getStatus();
  assert.equal(status.configured_version, "0.3.0");
  assert.equal(status.running_version, "0.3.0");
  assert.equal(status.container_state, "running");
  assert.equal(status.update.status, "IDLE");
});

test("UPDATE_SELF pulls only the fixed Supervisor image and launches detached helper", async () => {
  const { config, runner } = await fixture();
  const manager = new SelfUpdateManager(config, runner);
  const result = await manager.updateSelf("0.3.1");
  assert.equal(result.accepted, true);
  assert.equal(result.target_version, "0.3.1");
  assert.ok(runner.calls.some(({ command, args }) => command === "docker" && args[0] === "pull" && args[1] === "ghcr.io/sensorsphere/sensorsphere-supervisor-agent:0.3.1"));
  const helper = runner.calls.find(({ command, args }) => command === "docker" && args[0] === "run");
  assert.ok(helper);
  assert.ok(helper!.args.includes("ghcr.io/sensorsphere/sensorsphere-supervisor-agent:0.3.1"));
  assert.ok(helper!.args.includes("dist/self-update-helper.js"));
  const record = JSON.parse(await fs.readFile(config.selfUpdateStatusFile, "utf8")) as { status: string; target_version: string };
  assert.equal(record.status, "REQUESTED");
  assert.equal(record.target_version, "0.3.1");
});

test("UPDATE_SELF rejects versions that cannot contain the helper", async () => {
  const { config, runner } = await fixture();
  const manager = new SelfUpdateManager(config, runner);
  await assert.rejects(() => manager.updateSelf("0.2.9"), /does not support self-update helper/);
  assert.equal(runner.calls.length, 0);
});

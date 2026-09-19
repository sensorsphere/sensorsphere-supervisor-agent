import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SupervisorConfig } from "../config.js";
import { DeviceAgentManager } from "../manager.js";
import type { CommandResult, CommandRunner } from "../runner.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  failOn: string | null = null;
  image = "ghcr.io/sensorsphere/sensorsphere-device-agent:1.1.1";

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const joined = `${command} ${args.join(" ")}`;
    if (this.failOn && joined.includes(this.failOn)) throw new Error(`forced failure: ${this.failOn}`);
    if (args.includes("-q") && args.includes("device-agent")) return { stdout: "container123\n", stderr: "" };
    if (command === "docker" && args[0] === "inspect") return { stdout: `running|${this.image}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  }
}

async function fixture(): Promise<{ dir: string; config: SupervisorConfig; runner: FakeRunner }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
  await fs.writeFile(path.join(dir, ".env"), "SENSORSPHERE_URL=http://example\nDEVICE_AGENT_IMAGE=ghcr.io/sensorsphere/sensorsphere-device-agent:1.1.0\n", "utf8");
  await fs.writeFile(path.join(dir, "docker-compose.yml"), "services:\n  device-agent:\n    image: test\n", "utf8");
  return {
    dir,
    config: {
      socketPath: path.join(dir, "supervisor.sock"),
      socketGid: 0,
      managedAgentInstallDir: dir,
      managedImage: "ghcr.io/sensorsphere/sensorsphere-device-agent",
      composeSourceUrlTemplate: "https://example.invalid/v{version}/docker-compose.yml",
      updateTimeoutMs: 1000,
    },
    runner: new FakeRunner(),
  };
}

const okFetch: typeof fetch = async () => new Response("services:\n  device-agent:\n    image: test\n", { status: 200 });

test("update replaces compose and image, then recreates only device-agent", async () => {
  const { dir, config, runner } = await fixture();
  const manager = new DeviceAgentManager(config, runner, okFetch);
  const result = await manager.update("1.1.1");
  const env = await fs.readFile(path.join(dir, ".env"), "utf8");
  assert.match(env, /DEVICE_AGENT_IMAGE=ghcr\.io\/sensorsphere\/sensorsphere-device-agent:1\.1\.1/);
  assert.equal(result.target_version, "1.1.1");
  assert.ok(runner.calls.some(({ args }) => args.includes("pull") && args.includes("device-agent")));
  assert.ok(runner.calls.some(({ args }) => args.includes("up") && args.includes("--no-deps") && args.includes("device-agent")));
});

test("invalid versions are rejected before any Docker operation", async () => {
  const { config, runner } = await fixture();
  const manager = new DeviceAgentManager(config, runner, okFetch);
  await assert.rejects(() => manager.update("../../latest"), /invalid target version/);
  assert.equal(runner.calls.length, 0);
});

test("update restores environment and compose when recreation fails", async () => {
  const { dir, config, runner } = await fixture();
  runner.failOn = "up -d --no-deps device-agent";
  const manager = new DeviceAgentManager(config, runner, okFetch);
  await assert.rejects(() => manager.update("1.1.1"), /forced failure/);
  const env = await fs.readFile(path.join(dir, ".env"), "utf8");
  const compose = await fs.readFile(path.join(dir, "docker-compose.yml"), "utf8");
  assert.match(env, /DEVICE_AGENT_IMAGE=ghcr\.io\/sensorsphere\/sensorsphere-device-agent:1\.1\.0/);
  assert.match(compose, /image: test/);
});

test("download failures include the resolved compose URL", async () => {
  const { config, runner } = await fixture();
  const failingFetch: typeof fetch = async () => new Response("not found", { status: 404 });
  const manager = new DeviceAgentManager(config, runner, failingFetch);
  await assert.rejects(
    () => manager.update("1.1.1"),
    /HTTP 404 URL=https:\/\/example\.invalid\/v1\.1\.1\/docker-compose\.yml/,
  );
});

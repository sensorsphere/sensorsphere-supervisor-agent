import assert from "node:assert/strict";
import test from "node:test";
import { commandEnvironment } from "../runner.js";

const source = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/test",
  SENSORSPHERE_URL: "http://supervisor.example",
  SENSORSPHERE_AGENT_TOKEN: "sssa_supervisor",
  SENSORSPHERE_DEVICE_AGENT_TOKEN: "ssda_unrelated",
  AGENT_NAME: "supervisor-name",
  AGENT_LABELS: "supervisor-label",
  DEVICE_AGENT_IMAGE: "device:wrong",
  MONITOR_AGENT_IMAGE: "monitor:wrong",
  DATA_DIR: "/wrong/data",
  PUID: "1234",
  PGID: "1234",
  SUPERVISOR_AGENT_IMAGE: "supervisor:0.7.3",
};

test("docker compose environment does not leak Supervisor identity into managed Compose interpolation", () => {
  const env = commandEnvironment("docker", ["compose", "--env-file", ".env", "up", "-d"], source);

  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.SUPERVISOR_AGENT_IMAGE, "supervisor:0.7.3");
  for (const key of [
    "SENSORSPHERE_URL",
    "SENSORSPHERE_AGENT_TOKEN",
    "SENSORSPHERE_DEVICE_AGENT_TOKEN",
    "AGENT_NAME",
    "AGENT_LABELS",
    "DEVICE_AGENT_IMAGE",
    "MONITOR_AGENT_IMAGE",
    "DATA_DIR",
    "PUID",
    "PGID",
  ]) assert.equal(env[key], undefined, `${key} must not be inherited by docker compose`);
});

test("non-Compose commands keep their inherited environment", () => {
  const env = commandEnvironment("docker", ["inspect", "container"], source);
  assert.equal(env.SENSORSPHERE_AGENT_TOKEN, "sssa_supervisor");
  assert.equal(env.PUID, "1234");
});

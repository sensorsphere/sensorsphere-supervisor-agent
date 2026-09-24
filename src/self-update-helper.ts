import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";

const SELF_IMAGE = "ghcr.io/sensorsphere/sensorsphere-supervisor-agent";
const SERVICE = "supervisor-agent";

interface UpdateRecord {
  status: string;
  previous_version?: string | null;
  target_version?: string | null;
  requested_at?: string;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
  helper_container_id?: string | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readRecord(statusFile: string): Promise<UpdateRecord> {
  try {
    return JSON.parse(await fs.readFile(statusFile, "utf8")) as UpdateRecord;
  } catch {
    return { status: "REQUESTED" };
  }
}

async function writeRecord(statusFile: string, patch: Partial<UpdateRecord>): Promise<void> {
  const current = await readRecord(statusFile);
  const next = { ...current, ...patch };
  const temp = `${statusFile}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, statusFile);
}

async function replaceImage(envPath: string, image: string): Promise<void> {
  const original = await fs.readFile(envPath, "utf8");
  const lines = original.split(/\r?\n/);
  let replaced = false;
  const output = lines.map((line) => {
    if (line.startsWith("SUPERVISOR_AGENT_IMAGE=")) {
      replaced = true;
      return `SUPERVISOR_AGENT_IMAGE=${image}`;
    }
    return line;
  });
  if (!replaced) output.push(`SUPERVISOR_AGENT_IMAGE=${image}`);
  let next = output.join("\n");
  if (original.endsWith("\n") && !next.endsWith("\n")) next += "\n";
  await fs.writeFile(envPath, next, { mode: 0o600 });
}

function composeArgs(installDir: string, envPath: string, composePath: string, projectName: string, extra: string[]): string[] {
  return ["compose", "--project-name", projectName, "--project-directory", installDir, "--env-file", envPath, "-f", composePath, ...extra];
}

async function inspectService(installDir: string, envPath: string, composePath: string, projectName: string, timeoutMs: number): Promise<{ state: string; image: string | null }> {
  const ps = await run("docker", composeArgs(installDir, envPath, composePath, projectName, ["ps", "-q", SERVICE]), timeoutMs);
  const id = ps.stdout.trim();
  if (!id) return { state: "not_found", image: null };
  const inspect = await run("docker", ["inspect", "--format", "{{.State.Status}}|{{.Config.Image}}", id], timeoutMs);
  const [state = "unknown", image = ""] = inspect.stdout.trim().split("|", 2);
  return { state, image: image || null };
}

async function querySelfStatus(socketPath: string, timeoutMs: number): Promise<{ configured_version?: string; running_version?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout waiting for Supervisor socket response"));
    }, Math.min(timeoutMs, 5000));
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ request_id: "self-update-verify", action: "GET_SELF_STATUS" })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { ok?: boolean; result?: { configured_version?: string; running_version?: string }; error?: string };
        if (!response.ok || !response.result) reject(new Error(response.error || "Supervisor status verification failed"));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForTarget(
  installDir: string,
  envPath: string,
  composePath: string,
  socketPath: string,
  targetImage: string,
  targetVersion: string,
  projectName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "target Supervisor did not become ready";
  while (Date.now() < deadline) {
    try {
      const inspected = await inspectService(installDir, envPath, composePath, projectName, Math.min(timeoutMs, 10_000));
      if (inspected.state === "running" && inspected.image === targetImage) {
        const status = await querySelfStatus(socketPath, 5000);
        if (status.configured_version === targetVersion && status.running_version === targetVersion) return;
        lastError = `Supervisor socket reported configured=${status.configured_version ?? "unknown"} running=${status.running_version ?? "unknown"}`;
      } else {
        lastError = `Supervisor container state=${inspected.state} image=${inspected.image ?? "unknown"}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(lastError);
}

async function main(): Promise<void> {
  const installDir = required("SUPERVISOR_SELF_INSTALL_DIR");
  const targetVersion = required("SUPERVISOR_SELF_TARGET_VERSION");
  const previousImage = required("SUPERVISOR_SELF_PREVIOUS_IMAGE");
  const statusFile = required("SUPERVISOR_SELF_STATUS_FILE");
  const socketPath = required("SUPERVISOR_SELF_SOCKET_PATH");
  const composeUrl = required("SUPERVISOR_SELF_COMPOSE_URL");
  const projectName = required("SUPERVISOR_SELF_COMPOSE_PROJECT");
  const timeoutMs = Number.parseInt(required("SUPERVISOR_SELF_TIMEOUT_MS"), 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("SUPERVISOR_SELF_TIMEOUT_MS must be >= 1000");

  const envPath = path.join(installDir, ".env");
  const composePath = path.join(installDir, "docker-compose.yml");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const envBackup = `${envPath}.self-update-backup-${stamp}`;
  const composeBackup = `${composePath}.self-update-backup-${stamp}`;
  const composeTemp = `${composePath}.self-update-new-${stamp}`;
  const targetImage = `${SELF_IMAGE}:${targetVersion}`;

  await writeRecord(statusFile, { status: "UPDATING", started_at: new Date().toISOString(), error: null });

  let backupsCreated = false;
  try {
    await fs.copyFile(envPath, envBackup);
    await fs.copyFile(composePath, composeBackup);
    backupsCreated = true;

    const response = await fetch(composeUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`failed to download target docker-compose.yml: HTTP ${response.status} URL=${composeUrl}`);
    const body = await response.text();
    if (!body.includes(`${SERVICE}:`)) throw new Error(`target docker-compose.yml does not define ${SERVICE} service`);
    await fs.writeFile(composeTemp, body.endsWith("\n") ? body : `${body}\n`, "utf8");
    await replaceImage(envPath, targetImage);
    await fs.rename(composeTemp, composePath);

    await run("docker", composeArgs(installDir, envPath, composePath, projectName, ["config", "--quiet"]), timeoutMs);
    await run("docker", composeArgs(installDir, envPath, composePath, projectName, ["pull", SERVICE]), timeoutMs);
    await run("docker", composeArgs(installDir, envPath, composePath, projectName, ["up", "-d", "--no-deps", SERVICE]), timeoutMs);
    await waitForTarget(installDir, envPath, composePath, socketPath, targetImage, targetVersion, projectName, timeoutMs);

    await writeRecord(statusFile, { status: "UPDATED", finished_at: new Date().toISOString(), error: null });
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    if (!backupsCreated) {
      await writeRecord(statusFile, { status: "FAILED", finished_at: new Date().toISOString(), error: original });
      throw error;
    }

    await writeRecord(statusFile, { status: "ROLLING_BACK", error: original });
    try {
      await fs.copyFile(envBackup, envPath);
      await fs.copyFile(composeBackup, composePath);
      await run("docker", composeArgs(installDir, envPath, composePath, projectName, ["pull", SERVICE]), timeoutMs);
      await run("docker", composeArgs(installDir, envPath, composePath, projectName, ["up", "-d", "--no-deps", SERVICE]), timeoutMs);
      const previousVersion = previousImage.startsWith(`${SELF_IMAGE}:`) ? previousImage.slice(SELF_IMAGE.length + 1) : "";
      if (previousVersion) await waitForTarget(installDir, envPath, composePath, socketPath, previousImage, previousVersion, projectName, timeoutMs);
      await writeRecord(statusFile, { status: "ROLLED_BACK", finished_at: new Date().toISOString(), error: original });
    } catch (rollbackError) {
      const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      await writeRecord(statusFile, { status: "FAILED", finished_at: new Date().toISOString(), error: `${original}; rollback failed: ${rollback}` });
      throw new Error(`${original}; rollback failed: ${rollback}`);
    }
  } finally {
    await fs.rm(composeTemp, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

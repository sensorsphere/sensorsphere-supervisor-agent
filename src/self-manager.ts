import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisorConfig } from "./config.js";
import type { CommandRunner } from "./runner.js";

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const SELF_IMAGE = "ghcr.io/sensorsphere/sensorsphere-supervisor-agent";
const SELF_SERVICE = "supervisor-agent";
const SELF_COMPOSE_URL = "https://raw.githubusercontent.com/sensorsphere/sensorsphere-supervisor-agent/v{version}/docker-compose.yml";

export type SelfUpdateState = "IDLE" | "REQUESTED" | "UPDATING" | "UPDATED" | "FAILED" | "ROLLING_BACK" | "ROLLED_BACK";

export interface SelfUpdateRecord {
  status: SelfUpdateState;
  previous_version?: string | null;
  target_version?: string | null;
  requested_at?: string;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
  helper_container_id?: string | null;
}

export interface SelfStatus {
  install_dir: string;
  configured_image: string | null;
  configured_version: string | null;
  container_id: string | null;
  container_state: string;
  running_image: string | null;
  running_version: string | null;
  update: SelfUpdateRecord;
}

function versionFromImage(image: string | null): string | null {
  if (!image?.startsWith(`${SELF_IMAGE}:`)) return null;
  return image.slice(SELF_IMAGE.length + 1);
}

export class SelfUpdateManager {
  constructor(
    private readonly config: SupervisorConfig,
    private readonly runner: CommandRunner,
  ) {}

  private composeArgs(extra: string[]): string[] {
    return [
      "compose",
      "--project-directory", this.config.selfInstallDir,
      "--env-file", path.join(this.config.selfInstallDir, ".env"),
      "-f", path.join(this.config.selfInstallDir, "docker-compose.yml"),
      ...extra,
    ];
  }

  private async readConfiguredImage(): Promise<string | null> {
    try {
      const content = await fs.readFile(path.join(this.config.selfInstallDir, ".env"), "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line?.startsWith("SUPERVISOR_AGENT_IMAGE=")) return line.slice("SUPERVISOR_AGENT_IMAGE=".length).trim() || null;
      }
      return null;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readUpdateRecord(): Promise<SelfUpdateRecord> {
    try {
      const raw = await fs.readFile(this.config.selfUpdateStatusFile, "utf8");
      return JSON.parse(raw) as SelfUpdateRecord;
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return { status: "IDLE" };
      throw error;
    }
  }

  private async writeUpdateRecord(record: SelfUpdateRecord): Promise<void> {
    const temp = `${this.config.selfUpdateStatusFile}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.config.selfUpdateStatusFile);
    await fs.chown(this.config.selfUpdateStatusFile, this.config.defaultPuid, this.config.defaultPgid);
  }

  private async inspectContainer(): Promise<{ id: string | null; state: string; image: string | null }> {
    const ps = await this.runner.run("docker", this.composeArgs(["ps", "-q", SELF_SERVICE]), this.config.operationTimeoutMs);
    const id = ps.stdout.trim() || null;
    if (!id) return { id: null, state: "not_found", image: null };
    const inspect = await this.runner.run(
      "docker",
      ["inspect", "--format", "{{.State.Status}}|{{.Config.Image}}", id],
      this.config.operationTimeoutMs,
    );
    const [state = "unknown", image = ""] = inspect.stdout.trim().split("|", 2);
    return { id, state, image: image || null };
  }


  async ensureInstallOwnership(): Promise<void> {
    const candidates = [
      this.config.selfInstallDir,
      path.join(this.config.selfInstallDir, ".env"),
      path.join(this.config.selfInstallDir, ".env.example"),
      path.join(this.config.selfInstallDir, "docker-compose.yml"),
      this.config.selfUpdateStatusFile
    ];
    try {
      const entries = await fs.readdir(this.config.selfInstallDir);
      for (const entry of entries) {
        if (entry.includes(".self-update-backup-") || entry.startsWith(".supervisor-update-status")) {
          candidates.push(path.join(this.config.selfInstallDir, entry));
        }
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
      if (code !== "ENOENT") throw error;
    }
    for (const candidate of [...new Set(candidates)]) {
      try {
        await fs.chown(candidate, this.config.defaultPuid, this.config.defaultPgid);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
        if (code !== "ENOENT") throw error;
      }
    }
  }

  async getStatus(): Promise<SelfStatus> {
    // The detached self-update helper runs as root and may recreate status or backup files.
    // Re-apply the original installer UID/GID on every status refresh so ownership converges
    // immediately after a self-update instead of remaining root-owned.
    await this.ensureInstallOwnership();
    const configuredImage = await this.readConfiguredImage();
    const container = await this.inspectContainer();
    return {
      install_dir: this.config.selfInstallDir,
      configured_image: configuredImage,
      configured_version: versionFromImage(configuredImage),
      container_id: container.id,
      container_state: container.state,
      running_image: container.image,
      running_version: versionFromImage(container.image),
      update: await this.readUpdateRecord(),
    };
  }

  async updateSelf(version: string): Promise<Record<string, unknown>> {
    const targetVersion = version.trim();
    if (!VERSION_RE.test(targetVersion)) throw new Error("invalid target version");
    const [major = 0, minor = 0] = targetVersion.split(".").map((part) => Number.parseInt(part, 10));
    if (major === 0 && minor < 3) throw new Error("target Supervisor version does not support self-update helper");

    const current = await this.getStatus();
    if (!current.configured_image || !current.configured_version) throw new Error("Supervisor configured image cannot be determined");
    if (current.container_state !== "running") throw new Error(`Supervisor is not running (state=${current.container_state})`);
    if (["REQUESTED", "UPDATING", "ROLLING_BACK"].includes(current.update.status)) {
      throw new Error(`Supervisor self-update already in progress (status=${current.update.status})`);
    }

    const targetImage = `${SELF_IMAGE}:${targetVersion}`;
    const requestId = new Date().toISOString().replace(/[:.]/g, "-");
    const helperName = `sensorsphere-supervisor-self-update-${requestId}`.toLowerCase();
    const requestedAt = new Date().toISOString();

    await this.runner.run("docker", ["pull", targetImage], this.config.operationTimeoutMs);

    const record: SelfUpdateRecord = {
      status: "REQUESTED",
      previous_version: current.configured_version,
      target_version: targetVersion,
      requested_at: requestedAt,
      error: null,
      helper_container_id: null,
    };
    await this.writeUpdateRecord(record);

    const args = [
      "run", "-d", "--rm",
      "--name", helperName,
      "--entrypoint", "node",
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-v", `${this.config.managedRoot}:${this.config.managedRoot}`,
      "-v", `${path.dirname(this.config.socketPath)}:${path.dirname(this.config.socketPath)}`,
      "-e", `SUPERVISOR_SELF_INSTALL_DIR=${this.config.selfInstallDir}`,
      "-e", `SUPERVISOR_SELF_TARGET_VERSION=${targetVersion}`,
      "-e", `SUPERVISOR_SELF_PREVIOUS_IMAGE=${current.configured_image}`,
      "-e", `SUPERVISOR_SELF_STATUS_FILE=${this.config.selfUpdateStatusFile}`,
      "-e", `SUPERVISOR_SELF_SOCKET_PATH=${this.config.socketPath}`,
      "-e", `SUPERVISOR_SELF_TIMEOUT_MS=${this.config.selfUpdateTimeoutMs}`,
      "-e", `SUPERVISOR_SELF_COMPOSE_URL=${SELF_COMPOSE_URL.replace("{version}", targetVersion)}`,
      targetImage,
      "dist/self-update-helper.js",
    ];
    let helperId: string | null = null;
    try {
      const helper = await this.runner.run("docker", args, this.config.operationTimeoutMs);
      helperId = helper.stdout.trim() || null;
    } catch (error) {
      await this.writeUpdateRecord({
        ...record,
        status: "FAILED",
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return {
      accepted: true,
      previous_version: current.configured_version,
      target_version: targetVersion,
      target_image: targetImage,
      helper_container_id: helperId,
      status_file: this.config.selfUpdateStatusFile,
    };
  }
}

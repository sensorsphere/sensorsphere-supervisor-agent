import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisorConfig } from "./config.js";
import type { CommandRunner } from "./runner.js";

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?$/;

interface ManagedPaths {
  env: string;
  compose: string;
}

export interface ManagedStatus {
  install_dir: string;
  configured_image: string | null;
  configured_version: string | null;
  container_id: string | null;
  container_state: string;
  running_image: string | null;
}

export class DeviceAgentManager {
  private updateInProgress = false;

  constructor(
    private readonly config: SupervisorConfig,
    private readonly runner: CommandRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private paths(): ManagedPaths {
    return {
      env: path.join(this.config.managedAgentInstallDir, ".env"),
      compose: path.join(this.config.managedAgentInstallDir, "docker-compose.yml"),
    };
  }

  private composeArgs(paths: ManagedPaths, extra: string[]): string[] {
    return [
      "compose",
      "--project-directory", this.config.managedAgentInstallDir,
      "--env-file", paths.env,
      "-f", paths.compose,
      ...extra,
    ];
  }

  private async readEnvImage(envPath: string): Promise<string | null> {
    const content = await fs.readFile(envPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line?.startsWith("DEVICE_AGENT_IMAGE=")) return line.slice("DEVICE_AGENT_IMAGE=".length).trim() || null;
    }
    return null;
  }

  private versionFromImage(image: string | null): string | null {
    if (!image?.startsWith(`${this.config.managedImage}:`)) return null;
    return image.slice(this.config.managedImage.length + 1);
  }

  private async replaceEnvImage(envPath: string, image: string): Promise<void> {
    const original = await fs.readFile(envPath, "utf8");
    const hasFinalNewline = original.endsWith("\n");
    const lines = original.split(/\r?\n/);
    let replaced = false;
    const output = lines.map((line) => {
      if (line.startsWith("DEVICE_AGENT_IMAGE=")) {
        replaced = true;
        return `DEVICE_AGENT_IMAGE=${image}`;
      }
      return line;
    });
    if (!replaced) {
      if (output.at(-1) === "") output.splice(output.length - 1, 0, `DEVICE_AGENT_IMAGE=${image}`);
      else output.push(`DEVICE_AGENT_IMAGE=${image}`);
    }
    let next = output.join("\n");
    if (hasFinalNewline && !next.endsWith("\n")) next += "\n";
    await fs.writeFile(envPath, next, { mode: 0o600 });
  }

  private async inspectContainer(paths: ManagedPaths): Promise<{ id: string | null; state: string; image: string | null }> {
    const ps = await this.runner.run("docker", this.composeArgs(paths, ["ps", "-q", "device-agent"]), this.config.updateTimeoutMs);
    const id = ps.stdout.trim() || null;
    if (!id) return { id: null, state: "not_found", image: null };
    const inspect = await this.runner.run(
      "docker",
      ["inspect", "--format", "{{.State.Status}}|{{.Config.Image}}", id],
      this.config.updateTimeoutMs,
    );
    const [state = "unknown", image = ""] = inspect.stdout.trim().split("|", 2);
    return { id, state, image: image || null };
  }

  async getStatus(): Promise<ManagedStatus> {
    const paths = this.paths();
    const configuredImage = await this.readEnvImage(paths.env);
    const container = await this.inspectContainer(paths);
    return {
      install_dir: this.config.managedAgentInstallDir,
      configured_image: configuredImage,
      configured_version: this.versionFromImage(configuredImage),
      container_id: container.id,
      container_state: container.state,
      running_image: container.image,
    };
  }

  async update(version: string): Promise<Record<string, unknown>> {
    const normalizedVersion = version.trim();
    if (!VERSION_RE.test(normalizedVersion)) throw new Error("invalid target version");
    if (this.updateInProgress) throw new Error("an update is already in progress");
    this.updateInProgress = true;

    const paths = this.paths();
    const targetImage = `${this.config.managedImage}:${normalizedVersion}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const envBackup = `${paths.env}.supervisor-backup-${stamp}`;
    const composeBackup = `${paths.compose}.supervisor-backup-${stamp}`;
    const composeTemp = `${paths.compose}.supervisor-new-${stamp}`;
    let previousImage: string | null = null;
    let backupsCreated = false;

    try {
      previousImage = await this.readEnvImage(paths.env);
      await fs.copyFile(paths.env, envBackup);
      await fs.copyFile(paths.compose, composeBackup);
      backupsCreated = true;

      const sourceUrl = this.config.composeSourceUrlTemplate.replace("{version}", normalizedVersion);
      const response = await this.fetchImpl(sourceUrl, { redirect: "follow" });
      if (!response.ok) throw new Error(`failed to download target docker-compose.yml: HTTP ${response.status}`);
      const composeBody = await response.text();
      if (!composeBody.includes("device-agent:")) throw new Error("target docker-compose.yml does not define device-agent service");
      await fs.writeFile(composeTemp, composeBody.endsWith("\n") ? composeBody : `${composeBody}\n`, "utf8");

      await this.replaceEnvImage(paths.env, targetImage);
      await fs.rename(composeTemp, paths.compose);

      await this.runner.run("docker", this.composeArgs(paths, ["config", "--quiet"]), this.config.updateTimeoutMs);
      await this.runner.run("docker", this.composeArgs(paths, ["pull", "device-agent"]), this.config.updateTimeoutMs);
      await this.runner.run("docker", this.composeArgs(paths, ["up", "-d", "--no-deps", "device-agent"]), this.config.updateTimeoutMs);

      const after = await this.inspectContainer(paths);
      if (after.state !== "running") throw new Error(`updated Device Agent is not running (state=${after.state})`);
      if (after.image !== targetImage) throw new Error(`updated Device Agent is running unexpected image ${after.image ?? "unknown"}`);

      return {
        previous_image: previousImage,
        target_image: targetImage,
        target_version: normalizedVersion,
        container_id: after.id,
        container_state: after.state,
        backup_env: envBackup,
        backup_compose: composeBackup,
      };
    } catch (error) {
      if (backupsCreated) {
        try {
          await fs.copyFile(envBackup, paths.env);
          await fs.copyFile(composeBackup, paths.compose);
          await this.runner.run("docker", this.composeArgs(paths, ["pull", "device-agent"]), this.config.updateTimeoutMs);
          await this.runner.run("docker", this.composeArgs(paths, ["up", "-d", "--no-deps", "device-agent"]), this.config.updateTimeoutMs);
        } catch (rollbackError) {
          const original = error instanceof Error ? error.message : String(error);
          const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          throw new Error(`${original}; rollback failed: ${rollback}`);
        }
      }
      throw error;
    } finally {
      await fs.rm(composeTemp, { force: true }).catch(() => undefined);
      this.updateInProgress = false;
    }
  }
}

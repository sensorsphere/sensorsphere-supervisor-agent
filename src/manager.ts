import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisorConfig } from "./config.js";
import type { ManagedAgentType } from "./protocol.js";
import type { CommandRunner } from "./runner.js";

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

interface AgentDefinition {
  type: ManagedAgentType;
  serviceName: string;
  image: string;
  imageEnv: string;
  directoryName: string;
  composeSourceUrlTemplate: string;
  requiredEnvironment: string[];
  allowedEnvironment: Set<string>;
}

interface ManagedTarget {
  agentType: ManagedAgentType;
  instance: string;
  definition: AgentDefinition;
  installDir: string;
  managementId: string | null;
  agentId: string | null;
}

export interface ManagedAssignment {
  id: string;
  agentType: ManagedAgentType;
  agentId: string;
  instance: string;
  installDir: string | null;
}

interface ManagedPaths {
  env: string;
  compose: string;
}

const COMMON_ENVIRONMENT = ["PUID", "PGID", "DATA_DIR", "AGENT_NAME", "AGENT_LABELS"];

const DEFINITIONS: Record<ManagedAgentType, AgentDefinition> = {
  "device-agent": {
    type: "device-agent",
    serviceName: "device-agent",
    image: "ghcr.io/sensorsphere/sensorsphere-device-agent",
    imageEnv: "DEVICE_AGENT_IMAGE",
    directoryName: "sensorsphere-device-agent",
    composeSourceUrlTemplate: "https://raw.githubusercontent.com/sensorsphere/sensorsphere-device-agent/v{version}/docker-compose.yml",
    requiredEnvironment: ["SENSORSPHERE_URL", "SENSORSPHERE_DEVICE_AGENT_TOKEN"],
    allowedEnvironment: new Set([
      ...COMMON_ENVIRONMENT,
      "SENSORSPHERE_URL",
      "SENSORSPHERE_DEVICE_AGENT_TOKEN",
      "SENSORSPHERE_HEARTBEAT_INTERVAL_SECONDS",
      "SENSORSPHERE_DEVICE_AGENT_WS_URL",
      "SENSORSPHERE_LOG_LEVEL",
      "SENSORSPHERE_RECONNECT_INITIAL_MS",
      "SENSORSPHERE_RECONNECT_MAX_MS",
      "SENSORSPHERE_SUPERVISOR_SOCKET_PATH",
      "SENSORSPHERE_SUPERVISOR_REQUEST_TIMEOUT_MS",
      "YEELIGHT_REQUEST_TIMEOUT_MS",
      "ESPHOME_REQUEST_TIMEOUT_MS",
      "ESPHOME_NOISE_PSK",
      "PROXMOX_REQUEST_TIMEOUT_MS",
    ]),
  },
  "monitor-agent": {
    type: "monitor-agent",
    serviceName: "monitor-agent",
    image: "ghcr.io/sensorsphere/sensorsphere-monitor-agent",
    imageEnv: "MONITOR_AGENT_IMAGE",
    directoryName: "sensorsphere-monitor-agent",
    composeSourceUrlTemplate: "https://raw.githubusercontent.com/sensorsphere/sensorsphere-monitor-agent/v{version}/docker-compose.yml",
    requiredEnvironment: ["SENSORSPHERE_URL", "SENSORSPHERE_AGENT_TOKEN"],
    allowedEnvironment: new Set([
      ...COMMON_ENVIRONMENT,
      "SENSORSPHERE_URL",
      "SENSORSPHERE_AGENT_TOKEN",
      "SENSORSPHERE_HEARTBEAT_INTERVAL_SECONDS",
      "SENSORSPHERE_CONFIG_POLL_INTERVAL_SECONDS",
      "SENSORSPHERE_REQUEST_TIMEOUT_MS",
      "SENSORSPHERE_STATE_FILE",
      "SENSORSPHERE_QUEUE_MAX_RESULTS",
      "SENSORSPHERE_QUEUE_RETENTION_HOURS",
      "SENSORSPHERE_LOG_LEVEL",
    ]),
  },
};


export interface ProxmoxManagedEndpoint {
  id: string;
  product: "PVE" | "PBS";
  url: string;
  tokenId: string;
  tokenSecret?: string;
  verifyTls: boolean;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function serializeProxmoxConfig(endpoints: ProxmoxManagedEndpoint[]): string {
  const lines = ["version: 1", "endpoints:"];
  for (const endpoint of endpoints) {
    lines.push(`  - id: ${yamlScalar(endpoint.id)}`);
    lines.push(`    product: ${yamlScalar(endpoint.product)}`);
    lines.push(`    url: ${yamlScalar(endpoint.url)}`);
    lines.push(`    token_id: ${yamlScalar(endpoint.tokenId)}`);
    lines.push(`    token_secret: ${yamlScalar(endpoint.tokenSecret ?? "")}`);
    lines.push(`    verify_tls: ${endpoint.verifyTls ? "true" : "false"}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseYamlValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  try { return JSON.parse(value); } catch { return value; }
}

function parseProxmoxConfig(content: string): ProxmoxManagedEndpoint[] {
  const endpoints: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const start = line.match(/^\s*-\s+id:\s*(.+)$/);
    if (start) {
      current = { id: parseYamlValue(start[1]!) };
      endpoints.push(current);
      continue;
    }
    const field = line.match(/^\s+(product|url|token_id|token_secret|verify_tls):\s*(.*)$/);
    if (current && field) current[field[1]!] = parseYamlValue(field[2]!);
  }
  return endpoints.map((value, index) => {
    const id = String(value.id ?? "").trim();
    const product = String(value.product ?? "PVE").trim().toUpperCase();
    const url = String(value.url ?? "").trim();
    const tokenId = String(value.token_id ?? "").trim();
    const tokenSecret = String(value.token_secret ?? "");
    const verifyTls = value.verify_tls !== false;
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Invalid Proxmox endpoint id at index ${index}`);
    if (product !== "PVE" && product !== "PBS") throw new Error(`Invalid Proxmox product for ${id}`);
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error(`Invalid Proxmox URL for ${id}`);
    if (!tokenId.includes("!")) throw new Error(`Invalid Proxmox token id for ${id}`);
    return { id, product: product as "PVE" | "PBS", url: parsedUrl.toString().replace(/\/$/, ""), tokenId, tokenSecret, verifyTls };
  });
}

export interface ManagedStatus {
  management_id: string | null;
  sensor_sphere_agent_id: string | null;
  agent_type: ManagedAgentType;
  instance: string;
  install_dir: string;
  installed: boolean;
  configured_image: string | null;
  configured_version: string | null;
  container_id: string | null;
  container_state: string;
  running_image: string | null;
  reconciliation_status: "MANAGED" | "MISSING" | "DISCOVERED";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class ManagedAgentManager {
  private readonly operationsInProgress = new Set<string>();
  private assignments = new Map<string, ManagedAssignment>();

  constructor(
    private readonly config: SupervisorConfig,
    private readonly runner: CommandRunner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private assignmentKey(agentType: ManagedAgentType, instance: string): string {
    return `${agentType}/${instance}`;
  }

  setManagedAssignments(assignments: ManagedAssignment[]): void {
    const next = new Map<string, ManagedAssignment>();
    for (const assignment of assignments) {
      const instance = assignment.instance.trim() || "main";
      if (!INSTANCE_RE.test(instance)) continue;
      if (!DEFINITIONS[assignment.agentType]) continue;
      next.set(this.assignmentKey(assignment.agentType, instance), { ...assignment, instance });
    }
    this.assignments = next;
  }

  private isAllowedInstallDir(installDir: string): boolean {
    const roots = [this.config.managedRoot, this.config.additionalManagedRoot].filter((value): value is string => Boolean(value));
    return roots.some(root => {
      const relative = path.relative(root, installDir);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
  }

  private target(agentType: ManagedAgentType = "device-agent", instance = "main"): ManagedTarget {
    const normalizedInstance = instance.trim() || "main";
    if (!INSTANCE_RE.test(normalizedInstance)) throw new Error("invalid instance name");
    const definition = DEFINITIONS[agentType];
    if (!definition) throw new Error("unsupported agent type");
    const assignment = this.assignments.get(this.assignmentKey(agentType, normalizedInstance));
    const directory = normalizedInstance === "main"
      ? definition.directoryName
      : `${definition.directoryName}-${normalizedInstance}`;
    const installDir = path.resolve(assignment?.installDir?.trim() || path.join(this.config.managedRoot, directory));
    if (!this.isAllowedInstallDir(installDir)) {
      throw new Error(`managed target ${installDir} is outside configured managed roots`);
    }
    return {
      agentType,
      instance: normalizedInstance,
      definition,
      installDir,
      managementId: assignment?.id ?? null,
      agentId: assignment?.agentId ?? null,
    };
  }

  private key(target: ManagedTarget): string {
    return `${target.agentType}/${target.instance}`;
  }

  private paths(target: ManagedTarget): ManagedPaths {
    return {
      env: path.join(target.installDir, ".env"),
      compose: path.join(target.installDir, "docker-compose.yml"),
    };
  }

  private composeArgs(target: ManagedTarget, paths: ManagedPaths, extra: string[]): string[] {
    return [
      "compose",
      "--project-directory", target.installDir,
      "--env-file", paths.env,
      "-f", paths.compose,
      ...extra,
    ];
  }

  private validateVersion(version: string): string {
    const normalized = version.trim();
    if (!VERSION_RE.test(normalized)) throw new Error("invalid target version");
    return normalized;
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async readEnvImage(target: ManagedTarget, envPath: string): Promise<string | null> {
    let content: string;
    try {
      content = await fs.readFile(envPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const prefix = `${target.definition.imageEnv}=`;
    const lines = content.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line?.startsWith(prefix)) return line.slice(prefix.length).trim() || null;
    }
    return null;
  }

  private versionFromImage(target: ManagedTarget, image: string | null): string | null {
    if (!image?.startsWith(`${target.definition.image}:`)) return null;
    return image.slice(target.definition.image.length + 1);
  }

  private async replaceEnvImage(target: ManagedTarget, envPath: string, image: string): Promise<void> {
    const original = await fs.readFile(envPath, "utf8");
    const hasFinalNewline = original.endsWith("\n");
    const prefix = `${target.definition.imageEnv}=`;
    const lines = original.split(/\r?\n/);
    let replaced = false;
    const output = lines.map((line: string) => {
      if (line.startsWith(prefix)) {
        replaced = true;
        return `${target.definition.imageEnv}=${image}`;
      }
      return line;
    });
    if (!replaced) {
      if (output.at(-1) === "") output.splice(output.length - 1, 0, `${target.definition.imageEnv}=${image}`);
      else output.push(`${target.definition.imageEnv}=${image}`);
    }
    let next = output.join("\n");
    if (hasFinalNewline && !next.endsWith("\n")) next += "\n";
    await fs.writeFile(envPath, next, { mode: 0o600 });
  }

  private async inspectContainer(target: ManagedTarget, paths: ManagedPaths): Promise<{ id: string | null; state: string; image: string | null }> {
    if (!(await this.exists(paths.env)) || !(await this.exists(paths.compose))) {
      return { id: null, state: "not_installed", image: null };
    }
    const ps = await this.runner.run(
      "docker",
      this.composeArgs(target, paths, ["ps", "-q", target.definition.serviceName]),
      this.config.operationTimeoutMs,
    );
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

  private async downloadCompose(target: ManagedTarget, version: string): Promise<string> {
    const sourceUrl = target.definition.composeSourceUrlTemplate.replace("{version}", version);
    const response = await this.fetchImpl(sourceUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`failed to download target docker-compose.yml: HTTP ${response.status} URL=${sourceUrl}`);
    const body = await response.text();
    if (!body.includes(`${target.definition.serviceName}:`)) {
      throw new Error(`target docker-compose.yml does not define ${target.definition.serviceName} service`);
    }
    return body.endsWith("\n") ? body : `${body}\n`;
  }

  private validateEnvironment(target: ManagedTarget, environment: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (!ENV_KEY_RE.test(key) || !target.definition.allowedEnvironment.has(key)) {
        throw new Error(`environment key ${key} is not allowed for ${target.agentType}`);
      }
      if (value.includes("\n") || value.includes("\r")) throw new Error(`environment value for ${key} contains a newline`);
      result[key] = value;
    }
    for (const key of target.definition.requiredEnvironment) {
      if (!result[key]?.trim()) throw new Error(`${key} is required to deploy ${target.agentType}`);
    }
    if (target.agentType === "monitor-agent" && result.SENSORSPHERE_AGENT_TOKEN && !result.SENSORSPHERE_AGENT_TOKEN.startsWith("ssma_")) {
      throw new Error("SENSORSPHERE_AGENT_TOKEN for monitor-agent must use an ssma_ Monitoring Agent token");
    }
    if (target.agentType === "device-agent" && result.SENSORSPHERE_DEVICE_AGENT_TOKEN && !result.SENSORSPHERE_DEVICE_AGENT_TOKEN.startsWith("ssda_")) {
      throw new Error("SENSORSPHERE_DEVICE_AGENT_TOKEN for device-agent must use an ssda_ Device Agent token");
    }
    for (const key of ["PUID", "PGID"]) {
      if (result[key] !== undefined && !/^\d+$/.test(result[key])) throw new Error(`${key} must be a non-negative integer`);
    }
    return result;
  }

  private envLine(key: string, value: string): string {
    return `${key}=${JSON.stringify(value)}`;
  }

  private async writeNewEnvironment(target: ManagedTarget, version: string, environment: Record<string, string>): Promise<void> {
    const values = this.validateEnvironment(target, environment);
    if (!values.PUID) values.PUID = String(this.config.defaultPuid);
    if (!values.PGID) values.PGID = String(this.config.defaultPgid);
    const lines = [
      `${target.definition.imageEnv}=${target.definition.image}:${version}`,
      ...Object.entries(values).map(([key, value]) => this.envLine(key, value)),
      "",
    ];
    await fs.writeFile(this.paths(target).env, lines.join("\n"), { mode: 0o600 });
    await fs.chown(target.installDir, Number(values.PUID), Number(values.PGID));
    const dataDir = path.join(target.installDir, "data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.chown(dataDir, Number(values.PUID), Number(values.PGID));
  }


  private async readOwnership(target: ManagedTarget): Promise<{ uid: number; gid: number }> {
    const envPath = this.paths(target).env;
    let uid = this.config.defaultPuid;
    let gid = this.config.defaultPgid;
    try {
      const content = await fs.readFile(envPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const normalized = line.trim();
        if (normalized.startsWith("PUID=")) {
          const value = normalized.slice(5).replace(/^["']|["']$/g, "");
          if (/^\d+$/.test(value)) uid = Number(value);
        } else if (normalized.startsWith("PGID=")) {
          const value = normalized.slice(5).replace(/^["']|["']$/g, "");
          if (/^\d+$/.test(value)) gid = Number(value);
        }
      }
    } catch {
      // New deployments may not have an environment file yet.
    }
    return { uid, gid };
  }

  private async applyOwnership(target: ManagedTarget, pathsToOwn: string[] = []): Promise<void> {
    const { uid, gid } = await this.readOwnership(target);
    const candidates = [target.installDir, path.join(target.installDir, "data"), ...pathsToOwn];
    for (const candidate of candidates) {
      try {
        await fs.chown(candidate, uid, gid);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code ?? "") : "";
        if (code !== "ENOENT") throw error;
      }
    }
  }

  private tokenFingerprint(token: string | null): { hash: string | null; fingerprint: string | null } {
    if (!token) return { hash: null, fingerprint: null };
    const hash = createHash("sha256").update(token).digest("hex");
    return { hash, fingerprint: `${hash.slice(0, 4).toUpperCase()}-${hash.slice(4, 8).toUpperCase()}` };
  }

  private readEnvValue(content: string, key: string): string | null {
    let value: string | null = null;
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`));
      if (!match) continue;
      const raw = match[1]!.trim();
      value = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
    return value?.trim() || null;
  }

  private async runtimeEnvironment(containerId: string | null): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!containerId) return result;
    const inspect = await this.runner.run(
      "docker",
      ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerId],
      this.config.operationTimeoutMs,
    );
    for (const line of inspect.stdout.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      result.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return result;
  }

  async checkToken(agentType: ManagedAgentType, instance = "main"): Promise<Record<string, unknown>> {
    const target = this.target(agentType, instance);
    const paths = this.paths(target);
    if (!(await this.exists(paths.env))) throw new Error(`${this.key(target)} is not installed`);

    const content = await fs.readFile(paths.env, "utf8");
    const tokenKey = agentType === "device-agent" ? "SENSORSPHERE_DEVICE_AGENT_TOKEN" : "SENSORSPHERE_AGENT_TOKEN";
    const configuredToken = this.readEnvValue(content, tokenKey);
    if (!configuredToken) throw new Error(`${tokenKey} is not configured for ${this.key(target)}`);
    const configuredUrl = this.readEnvValue(content, "SENSORSPHERE_URL");

    const configured = this.tokenFingerprint(configuredToken);
    const container = await this.inspectContainer(target, paths);
    const runtimeEnv = await this.runtimeEnvironment(container.id);
    const runtimeToken = runtimeEnv.get(tokenKey)?.trim() || null;
    const runtimeUrl = runtimeEnv.get("SENSORSPHERE_URL")?.trim() || null;
    const runtime = this.tokenFingerprint(runtimeToken);

    return {
      agent_type: agentType,
      instance,
      install_dir: target.installDir,
      container_id: container.id,
      container_state: container.state,
      token_hash: runtime.hash ?? configured.hash,
      token_fingerprint: runtime.fingerprint ?? configured.fingerprint,
      configured_token_hash: configured.hash,
      configured_token_fingerprint: configured.fingerprint,
      runtime_token_hash: runtime.hash,
      runtime_token_fingerprint: runtime.fingerprint,
      runtime_token_present: runtimeToken != null,
      configured_sensorsphere_url: configuredUrl,
      runtime_sensorsphere_url: runtimeUrl
    };
  }

  private async withOperation<T>(target: ManagedTarget, operation: () => Promise<T>): Promise<T> {
    const key = this.key(target);
    if (this.operationsInProgress.has(key)) throw new Error(`an operation is already in progress for ${key}`);
    this.operationsInProgress.add(key);
    try {
      return await operation();
    } finally {
      this.operationsInProgress.delete(key);
    }
  }

  async listStatuses(): Promise<ManagedStatus[]> {
    const targets = new Map<string, { agentType: ManagedAgentType; instance: string }>();
    for (const assignment of this.assignments.values()) {
      targets.set(this.assignmentKey(assignment.agentType, assignment.instance), { agentType: assignment.agentType, instance: assignment.instance });
    }

    const roots = [this.config.managedRoot, this.config.additionalManagedRoot].filter((value): value is string => Boolean(value));
    for (const root of roots) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.includes(".removed-") || entry.name.includes(".failed-deploy-")) continue;
        for (const definition of Object.values(DEFINITIONS)) {
          let instance: string | null = null;
          if (entry.name === definition.directoryName) instance = "main";
          else {
            const prefix = `${definition.directoryName}-`;
            if (entry.name.startsWith(prefix)) {
              const candidate = entry.name.slice(prefix.length);
              if (INSTANCE_RE.test(candidate)) instance = candidate;
            }
          }
          if (!instance) continue;
          const key = this.assignmentKey(definition.type, instance);
          if (!targets.has(key)) targets.set(key, { agentType: definition.type, instance });
        }
      }
    }

    const statuses = await Promise.all([...targets.values()].map(target => this.getStatus(target.agentType, target.instance)));
    return statuses.sort((left, right) => `${left.agent_type}/${left.instance}`.localeCompare(`${right.agent_type}/${right.instance}`));
  }

  async getStatus(agentType: ManagedAgentType = "device-agent", instance = "main"): Promise<ManagedStatus> {
    const target = this.target(agentType, instance);
    const paths = this.paths(target);
    const installed = await this.exists(paths.env) && await this.exists(paths.compose);
    const configuredImage = installed ? await this.readEnvImage(target, paths.env) : null;
    const container = installed ? await this.inspectContainer(target, paths) : { id: null, state: "not_installed", image: null };
    return {
      management_id: target.managementId,
      sensor_sphere_agent_id: target.agentId,
      agent_type: target.agentType,
      instance: target.instance,
      install_dir: target.installDir,
      installed,
      configured_image: configuredImage,
      configured_version: this.versionFromImage(target, configuredImage),
      container_id: container.id,
      container_state: container.state,
      running_image: container.image,
      reconciliation_status: target.managementId ? (installed ? "MANAGED" : "MISSING") : "DISCOVERED",
    };
  }

  async deploy(
    agentType: ManagedAgentType,
    instance: string,
    version: string,
    environment: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const target = this.target(agentType, instance);
    const normalizedVersion = this.validateVersion(version);
    return this.withOperation(target, async () => {
      const paths = this.paths(target);
      if (await this.exists(paths.env) || await this.exists(paths.compose)) {
        throw new Error(`${this.key(target)} is already installed`);
      }

      const failedDir = `${target.installDir}.failed-deploy-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await fs.mkdir(target.installDir, { recursive: true });
        const composeBody = await this.downloadCompose(target, normalizedVersion);
        await this.writeNewEnvironment(target, normalizedVersion, environment);
        const configDir = path.join(target.installDir, "config");
        if (target.agentType === "device-agent") {
          await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
          await fs.chmod(configDir, 0o700);
        }
        await fs.writeFile(paths.compose, composeBody, "utf8");
        await this.applyOwnership(target, [paths.env, paths.compose, ...(target.agentType === "device-agent" ? [configDir] : [])]);

        await this.runner.run("docker", this.composeArgs(target, paths, ["config", "--quiet"]), this.config.operationTimeoutMs);
        await this.runner.run("docker", this.composeArgs(target, paths, ["pull", target.definition.serviceName]), this.config.operationTimeoutMs);
        await this.runner.run("docker", this.composeArgs(target, paths, ["up", "-d", "--no-deps", target.definition.serviceName]), this.config.operationTimeoutMs);

        const after = await this.inspectContainer(target, paths);
        const targetImage = `${target.definition.image}:${normalizedVersion}`;
        if (after.state !== "running") throw new Error(`deployed ${this.key(target)} is not running (state=${after.state})`);
        if (after.image !== targetImage) throw new Error(`deployed ${this.key(target)} is running unexpected image ${after.image ?? "unknown"}`);
        const tokenCheck = await this.checkToken(agentType, instance);
        return { ...(await this.getStatus(agentType, instance)), target_version: normalizedVersion, token_hash: tokenCheck.token_hash, token_fingerprint: tokenCheck.token_fingerprint, configured_token_hash: tokenCheck.configured_token_hash, configured_token_fingerprint: tokenCheck.configured_token_fingerprint, runtime_token_hash: tokenCheck.runtime_token_hash, runtime_token_fingerprint: tokenCheck.runtime_token_fingerprint, runtime_token_present: tokenCheck.runtime_token_present, configured_sensorsphere_url: tokenCheck.configured_sensorsphere_url, runtime_sensorsphere_url: tokenCheck.runtime_sensorsphere_url };
      } catch (error) {
        try {
          if (await this.exists(paths.env) && await this.exists(paths.compose)) {
            await this.runner.run("docker", this.composeArgs(target, paths, ["down", "--remove-orphans"]), this.config.operationTimeoutMs);
          }
          if (await this.exists(target.installDir)) await fs.rename(target.installDir, failedDir);
        } catch {
          // Preserve the original deployment error. Failed artifacts remain for diagnostics if cleanup also fails.
        }
        throw error;
      }
    });
  }


  assertManagedAssignment(agentType: ManagedAgentType, instance: string, managementId: string, agentId: string): void {
    const target = this.target(agentType, instance);
    if (!target.managementId || !target.agentId) throw new Error(`${this.key(target)} is not explicitly associated with SensorSphere`);
    if (target.managementId !== managementId || target.agentId !== agentId) {
      throw new Error(`${this.key(target)} association does not match the requested SensorSphere agent`);
    }
  }

  async update(version: string, agentType: ManagedAgentType = "device-agent", instance = "main"): Promise<Record<string, unknown>> {
    const target = this.target(agentType, instance);
    const normalizedVersion = this.validateVersion(version);
    return this.withOperation(target, async () => {
      const paths = this.paths(target);
      if (!(await this.exists(paths.env)) || !(await this.exists(paths.compose))) {
        throw new Error(`${this.key(target)} is not installed`);
      }
      const targetImage = `${target.definition.image}:${normalizedVersion}`;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const envBackup = `${paths.env}.supervisor-backup-${stamp}`;
      const composeBackup = `${paths.compose}.supervisor-backup-${stamp}`;
      const composeTemp = `${paths.compose}.supervisor-new-${stamp}`;
      let previousImage: string | null = null;
      let backupsCreated = false;

      try {
        previousImage = await this.readEnvImage(target, paths.env);
        await fs.copyFile(paths.env, envBackup);
        await fs.copyFile(paths.compose, composeBackup);
        backupsCreated = true;
        await fs.writeFile(composeTemp, await this.downloadCompose(target, normalizedVersion), "utf8");
        await this.replaceEnvImage(target, paths.env, targetImage);
        await fs.rename(composeTemp, paths.compose);
        await this.applyOwnership(target, [paths.env, paths.compose, envBackup, composeBackup]);

        await this.runner.run("docker", this.composeArgs(target, paths, ["config", "--quiet"]), this.config.operationTimeoutMs);
        await this.runner.run("docker", this.composeArgs(target, paths, ["pull", target.definition.serviceName]), this.config.operationTimeoutMs);
        await this.runner.run("docker", this.composeArgs(target, paths, ["up", "-d", "--no-deps", target.definition.serviceName]), this.config.operationTimeoutMs);

        const after = await this.inspectContainer(target, paths);
        if (after.state !== "running") throw new Error(`updated ${this.key(target)} is not running (state=${after.state})`);
        if (after.image !== targetImage) throw new Error(`updated ${this.key(target)} is running unexpected image ${after.image ?? "unknown"}`);
        return {
          agent_type: target.agentType,
          instance: target.instance,
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
            await this.applyOwnership(target, [paths.env, paths.compose]);
            await this.runner.run("docker", this.composeArgs(target, paths, ["pull", target.definition.serviceName]), this.config.operationTimeoutMs);
            await this.runner.run("docker", this.composeArgs(target, paths, ["up", "-d", "--no-deps", target.definition.serviceName]), this.config.operationTimeoutMs);
          } catch (rollbackError) {
            const original = error instanceof Error ? error.message : String(error);
            const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`${original}; rollback failed: ${rollback}`);
          }
        }
        throw error;
      } finally {
        await fs.rm(composeTemp, { force: true });
      }
    });
  }


  async getProxmoxConfig(instance = "main"): Promise<Record<string, unknown>> {
    const target = this.target("device-agent", instance);
    const configPath = path.join(target.installDir, "config", "proxmox.yml");
    if (!(await this.exists(configPath))) return { configured: false, endpoints: [], config_path: configPath };
    const endpoints = parseProxmoxConfig(await fs.readFile(configPath, "utf8"));
    return {
      configured: endpoints.length > 0,
      config_path: configPath,
      endpoints: endpoints.map(endpoint => ({
        id: endpoint.id, product: endpoint.product, url: endpoint.url, tokenId: endpoint.tokenId,
        tokenSecretConfigured: Boolean(endpoint.tokenSecret), verifyTls: endpoint.verifyTls
      }))
    };
  }

  async setProxmoxConfig(instance: string, input: unknown): Promise<Record<string, unknown>> {
    const target = this.target("device-agent", instance);
    const paths = this.paths(target);
    if (!(await this.exists(paths.env)) || !(await this.exists(paths.compose))) throw new Error(`${this.key(target)} is not installed`);
    const payload = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (!Array.isArray(payload.endpoints)) throw new Error("Proxmox configuration must contain an endpoints array");
    const configDir = path.join(target.installDir, "config");
    const configPath = path.join(configDir, "proxmox.yml");
    let existing = new Map<string, ProxmoxManagedEndpoint>();
    if (await this.exists(configPath)) {
      existing = new Map(parseProxmoxConfig(await fs.readFile(configPath, "utf8")).map(endpoint => [endpoint.id, endpoint]));
    }
    const endpoints: ProxmoxManagedEndpoint[] = payload.endpoints.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid Proxmox endpoint at index ${index}`);
      const value = raw as Record<string, unknown>;
      const id = String(value.id ?? "").trim();
      const product = String(value.product ?? "PVE").trim().toUpperCase();
      const url = String(value.url ?? "").trim();
      const tokenId = String(value.tokenId ?? "").trim();
      const suppliedSecret = typeof value.tokenSecret === "string" ? value.tokenSecret : "";
      const tokenSecret = suppliedSecret || existing.get(id)?.tokenSecret || "";
      const verifyTls = value.verifyTls !== false;
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`Invalid Proxmox endpoint id at index ${index}`);
      if (product !== "PVE" && product !== "PBS") throw new Error(`Invalid Proxmox product for ${id}`);
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error(`Invalid Proxmox URL for ${id}`);
      if (!tokenId.includes("!")) throw new Error(`Invalid Proxmox token id for ${id}`);
      if (!tokenSecret) throw new Error(`Proxmox token secret is required for ${id}`);
      return { id, product: product as "PVE" | "PBS", url: parsedUrl.toString().replace(/\/$/, ""), tokenId, tokenSecret, verifyTls };
    });
    if (new Set(endpoints.map(endpoint => endpoint.id)).size !== endpoints.length) throw new Error("Duplicate Proxmox endpoint id");
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(configPath, serializeProxmoxConfig(endpoints), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(configDir, 0o700);
    await fs.chmod(configPath, 0o600);
    await this.applyOwnership(target, [configDir, configPath]);
    await this.runner.run("docker", this.composeArgs(target, paths, ["up", "-d", "--force-recreate", "--no-deps", target.definition.serviceName]), this.config.operationTimeoutMs);
    return this.getProxmoxConfig(instance);
  }

  async deleteProxmoxConfig(instance = "main"): Promise<Record<string, unknown>> {
    const target = this.target("device-agent", instance);
    const paths = this.paths(target);
    if (!(await this.exists(paths.env)) || !(await this.exists(paths.compose))) throw new Error(`${this.key(target)} is not installed`);
    const configPath = path.join(target.installDir, "config", "proxmox.yml");
    await fs.rm(configPath, { force: true });
    await this.runner.run("docker", this.composeArgs(target, paths, ["up", "-d", "--force-recreate", "--no-deps", target.definition.serviceName]), this.config.operationTimeoutMs);
    return { configured: false, endpoints: [], config_path: configPath };
  }

  async remove(agentType: ManagedAgentType, instance = "main"): Promise<Record<string, unknown>> {
    const target = this.target(agentType, instance);
    return this.withOperation(target, async () => {
      const paths = this.paths(target);
      if (!(await this.exists(paths.env)) || !(await this.exists(paths.compose))) {
        throw new Error(`${this.key(target)} is not installed`);
      }
      await this.runner.run("docker", this.composeArgs(target, paths, ["down", "--remove-orphans"]), this.config.operationTimeoutMs);
      const archiveDir = `${target.installDir}.removed-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await fs.rename(target.installDir, archiveDir);
      return {
        agent_type: target.agentType,
        instance: target.instance,
        removed: true,
        archive_dir: archiveDir,
      };
    });
  }
}

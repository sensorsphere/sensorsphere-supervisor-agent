# SensorSphere Supervisor Agent

SensorSphere Supervisor Agent is the host-local lifecycle service for known SensorSphere agents. It owns Docker lifecycle access so managed agents never need direct access to the Docker daemon.

## Scope of 0.6.0

0.4.0 provides the generic host-local lifecycle service used by SensorSphere to manage known Device and Monitor Agent instances and to self-update the Supervisor.

The Supervisor is provider-neutral across known SensorSphere agent types:

- `device-agent`
- `monitor-agent`
- multiple named instances per type (`main`, `i2`, `site-b`, ...)

Supported local operations are:

- `GET_STATUS`
- `DEPLOY_AGENT`
- `UPDATE_AGENT`
- `REMOVE_AGENT`
- `GET_SELF_STATUS`
- `UPDATE_SELF`

Arbitrary image names, Compose repositories, install paths, environment keys, or shell commands are never accepted from callers. Each supported agent type is defined by a local allowlist in the Supervisor.

`UPDATE_AGENT` and `GET_STATUS` without an explicit target continue to mean `device-agent/main` so Device Agent 1.2.x remains compatible.

## Quick install

The recommended bootstrap does not require cloning this repository. Install the current release with:

```sh
curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-supervisor-agent/master/scripts/install.sh | VERSION=0.4.0 bash
```

The installer defaults to:

```text
install directory:  $HOME/sensorsphere-supervisor-agent
managed root:       $HOME
socket:             /run/sensorsphere-supervisor-agent/supervisor.sock
UID/GID defaults:   current user
```

It downloads the Compose file and `.env.example` for the requested release, creates or migrates `.env`, updates the selected image tag, validates the Compose configuration, pulls/recreates the service, and waits for the Unix socket. Existing `.env` files are backed up and custom values are preserved; missing required variables are added automatically.

Verify installation with:

```sh
cd ~/sensorsphere-supervisor-agent
docker compose --env-file .env ps
docker compose --env-file .env logs --tail=100 supervisor-agent
test -S /run/sensorsphere-supervisor-agent/supervisor.sock && echo "Supervisor socket OK"
```

### Why there is no SensorSphere token

The Supervisor does not connect to SensorSphere and does not expose a TCP management API. Local agents communicate with it only through the Unix socket. Access is therefore controlled by host filesystem/socket permissions and `SUPERVISOR_SOCKET_GID`, while the Supervisor itself restricts callers to a fixed allowlist of known agent types and lifecycle operations. Do not expose the Supervisor socket over the network.

### Legacy Device Agent bootstrap

If a host still runs a Device Agent version that predates Supervisor integration:

1. Install Supervisor Agent first.
2. Perform one manual Device Agent upgrade using the Device Agent `scripts/install.sh`.
3. Verify that the upgraded Device Agent sees `/run/sensorsphere-supervisor-agent/supervisor.sock`.
4. Use SensorSphere-managed updates for later versions.


## Direct SensorSphere connection (0.5.0+)

The Supervisor can now connect directly and outbound-only to SensorSphere. This removes the bootstrap dependency on a Device Agent: a new host can run only the Supervisor first, appear in `Agents > Supervisor Agents`, then receive Device/Monitoring Agent deployments from SensorSphere in a later control increment.

Create a Supervisor Agent entry/token in SensorSphere and configure:

For a new host, the recommended bootstrap is:

```sh
SENSORSPHERE_URL=http://100.64.0.8:8080 \
SENSORSPHERE_AGENT_TOKEN=sssa_replace_me \
SUPERVISOR_NAME=homefcs-iot-ap \
VERSION=0.6.0 \
bash -c "$(curl -fsSL https://raw.githubusercontent.com/sensorsphere/sensorsphere-supervisor-agent/master/scripts/install.sh)"
```

The installer downloads the version-matched Compose file, preserves/migrates an existing `.env`, updates the image tag, starts the container and validates the Unix socket.

The equivalent `.env` values are:

```env
SENSORSPHERE_URL=http://100.64.0.8:8080
SENSORSPHERE_AGENT_TOKEN=sssa_replace_me
SUPERVISOR_NAME=homefcs-iot-ap
```

If `SENSORSPHERE_URL` or `SENSORSPHERE_AGENT_TOKEN` is omitted, the existing local Unix-socket mode remains available for backward compatibility. No inbound TCP port is opened.

## Explicit SensorSphere associations

Starting with 0.6.0, SensorSphere can send immutable managed-agent associations to the Supervisor. Each association carries the SensorSphere agent UUID, Supervisor-local instance and an optional explicit install directory. The Supervisor reports the association UUID back with runtime status, so SensorSphere no longer has to infer ownership from hostname or directory naming.

The conventional `SUPERVISOR_MANAGED_ROOT` scan remains available for discovery/adoption. Explicit paths must stay under `SUPERVISOR_MANAGED_ROOT` or `SUPERVISOR_ADDITIONAL_MANAGED_ROOT` (default `/opt`), both mounted at identical host/container paths so Docker Compose relative volumes remain valid.

## Managed layout

`SUPERVISOR_MANAGED_ROOT` is an absolute host directory mounted at the same path in the Supervisor container. Target directories are derived locally:

```text
<root>/sensorsphere-device-agent
<root>/sensorsphere-monitor-agent
<root>/sensorsphere-monitor-agent-i2
<root>/sensorsphere-monitor-agent-site-b
```

Callers cannot provide filesystem paths.

For an existing installation such as `/home/pi/sensorsphere-device-agent`, set:

```text
SUPERVISOR_MANAGED_ROOT=/home/pi
```

## Local protocol

Requests and responses are one JSON object per line over the Unix socket.

Legacy Device Agent status request:

```json
{"request_id":"1","action":"GET_STATUS"}
```

Target-aware status:

```json
{"request_id":"2","action":"GET_STATUS","agent_type":"monitor-agent","instance":"i2"}
```

Deploy a known agent/version:

```json
{
  "request_id":"3",
  "action":"DEPLOY_AGENT",
  "agent_type":"monitor-agent",
  "instance":"main",
  "version":"1.0.9",
  "environment":{
    "SENSORSPHERE_URL":"http://100.64.0.8:8080",
    "SENSORSPHERE_AGENT_TOKEN":"replace_me",
    "AGENT_NAME":"monitor-rpi4"
  }
}
```

Update a named instance:

```json
{"request_id":"4","action":"UPDATE_AGENT","agent_type":"monitor-agent","instance":"i2","version":"1.0.9"}
```

Remove an instance:

```json
{"request_id":"5","action":"REMOVE_AGENT","agent_type":"monitor-agent","instance":"i2"}
```

Removal stops the Compose project and renames the installation directory to a timestamped `.removed-*` archive instead of deleting its configuration/data.

## Supervisor self-update

From 0.3.0 onward the Supervisor can update itself without exposing arbitrary Docker commands.
`UPDATE_SELF` accepts only a semantic version and always uses the fixed image repository
`ghcr.io/sensorsphere/sensorsphere-supervisor-agent`.

The running Supervisor pulls the target image and starts a detached one-shot helper from that
target image. The helper backs up `.env` and `docker-compose.yml`, downloads the target Compose
file from the Supervisor repository, recreates the Supervisor, waits for `GET_SELF_STATUS` from
the new version, and rolls back to the previous image/Compose files if verification fails.

Status:

```json
{"request_id":"self-1","action":"GET_SELF_STATUS"}
```

Request an update:

```json
{"request_id":"self-2","action":"UPDATE_SELF","version":"0.3.1"}
```

The update request returns once the detached helper has been started. Progress and final state are
reported by subsequent `GET_SELF_STATUS` calls (`REQUESTED`, `UPDATING`, `UPDATED`,
`ROLLING_BACK`, `ROLLED_BACK`, or `FAILED`).

0.2.x does not contain the self-update entry point, so the first upgrade to 0.3.0 must still be
performed with the existing deployment procedure. After 0.3.0, supported future Supervisor
versions can be installed through `UPDATE_SELF`.

## Deployment security

For a new deployment, the caller may provide only environment keys explicitly allowed for that known agent type. Required SensorSphere URL/token settings must be present. Newline-containing values are rejected. The Supervisor itself chooses:

- GHCR image repository
- Compose source repository
- Compose service name
- installation directory

The generated `.env` is mode `0600`.

## Manual configuration and start

The installer is preferred. For a manual deployment, copy `.env.example` to `.env` and configure at least the managed root and socket group for the target host:

```text
SUPERVISOR_MANAGED_ROOT=/home/pi
SUPERVISOR_SOCKET_GID=1000
SUPERVISOR_SELF_INSTALL_DIR=/home/pi/sensorsphere-supervisor-agent
SUPERVISOR_SELF_UPDATE_TIMEOUT_MS=120000
```

`scripts/install.sh` also records the host OS hostname in `SUPERVISOR_HOSTNAME` and passes it as the container hostname. This keeps the hostname reported to SensorSphere independent from Docker container IDs. `SUPERVISOR_NAME` remains the operator-facing name reported by the Supervisor.

Then start with:

```sh
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

To repeat a manual installer-driven update, rerun `scripts/install.sh` with a new `VERSION`. The existing `.env` is backed up and preserved, missing required variables are migrated, and the image tag is updated before `docker compose pull` and `docker compose up -d`.

## Tests

```sh
docker build --target build -t sensorsphere-supervisor-agent:test .
docker run --rm sensorsphere-supervisor-agent:test npm test
```

## Release

`VERSION` is authoritative:

```sh
IMAGE_NAMESPACE=sensorsphere ./scripts/release-image.sh
```

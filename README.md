# SensorSphere Supervisor Agent

SensorSphere Supervisor Agent is the host-local lifecycle service for known SensorSphere agents. It owns Docker lifecycle access so managed agents never need direct access to the Docker daemon.

## Scope of 0.3.1

0.3.1 is the first maintenance release used to validate the complete SensorSphere-driven self-update path introduced in 0.3.0. It keeps the same supported lifecycle surface and security model.

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

## Configuration

Copy `.env.example` to `.env` and configure at least:

```text
SUPERVISOR_MANAGED_ROOT=/home/pi
SUPERVISOR_SOCKET_GID=1000
SUPERVISOR_SELF_INSTALL_DIR=/home/pi/sensorsphere-supervisor-agent
SUPERVISOR_SELF_UPDATE_TIMEOUT_MS=120000
```

## Start

```sh
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

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

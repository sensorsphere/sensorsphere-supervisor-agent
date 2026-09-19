# SensorSphere Supervisor Agent

SensorSphere Supervisor Agent is a small host-local lifecycle service used to update a SensorSphere Device Agent without giving the Device Agent direct access to the Docker daemon.

## Scope of 0.1.0

- Unix-domain socket API; no TCP listener.
- `GET_STATUS` for the locally managed Device Agent.
- `UPDATE_AGENT` with a version only; arbitrary images and shell commands are not accepted.
- Pull/recreate of the `device-agent` Compose service.
- Retrieval of the target version's `docker-compose.yml` from the fixed SensorSphere Device Agent repository.
- Preservation of the managed `.env`.
- Automatic restoration of `.env` and `docker-compose.yml` when an update operation fails.
- The Docker socket is mounted only into the Supervisor Agent, never into the Device Agent.

The first release is intentionally local-only. SensorSphere/API orchestration and the Device Agent client are added in later PRs.

## Local protocol

Requests and responses are one JSON object per line over the Unix socket.

Status request:

```json
{"request_id":"1","action":"GET_STATUS"}
```

Update request:

```json
{"request_id":"2","action":"UPDATE_AGENT","version":"1.1.1"}
```

The caller can supply only a version. The managed image name, installation directory, Compose source repository, and Docker operations are defined locally by Supervisor configuration.

## Configuration

Copy `.env.example` to `.env` and adjust at least:

```text
DEVICE_AGENT_INSTALL_DIR=/home/pi/sensorsphere-device-agent
SUPERVISOR_SOCKET_GID=1000
```

`DEVICE_AGENT_INSTALL_DIR` must be the absolute host path of the existing Device Agent installation. The directory is mounted into the Supervisor container at the same absolute path so relative Compose bind mounts continue to resolve to valid host paths.

## Start

```sh
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

## Tests

The project is intended to be built and tested in Docker:

```sh
docker build --target build -t sensorsphere-supervisor-agent:test .
docker run --rm sensorsphere-supervisor-agent:test npm test
```

## Release

`VERSION` is the authoritative image version. Publishing follows the same multi-architecture convention as the Device Agent:

```sh
IMAGE_NAMESPACE=sensorsphere ./scripts/release-image.sh
```

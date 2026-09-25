#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${REPOSITORY:-sensorsphere/sensorsphere-supervisor-agent}"
RAW_BASE_URL="${RAW_BASE_URL:-https://raw.githubusercontent.com}"
VERSION="${VERSION:-0.8.5}"
ENVIRONMENT="${SENSORSPHERE_ENVIRONMENT:-DEFAULT}"
ENVIRONMENT="$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')"
[[ "$ENVIRONMENT" =~ ^[A-Z0-9][A-Z0-9._-]{0,31}$ ]] || { printf 'ERROR: SENSORSPHERE_ENVIRONMENT must match ^[A-Z0-9][A-Z0-9._-]{0,31}$\n' >&2; exit 1; }
NAMESPACE="$(printf '%s' "$ENVIRONMENT" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
[[ -n "$NAMESPACE" ]] || NAMESPACE=default
if [[ "$ENVIRONMENT" == "DEFAULT" ]]; then
  MANAGED_ROOT="${SUPERVISOR_MANAGED_ROOT:-${HOME}}"
  INSTALL_DIR="${SUPERVISOR_INSTALL_DIR:-${MANAGED_ROOT}/sensorsphere-supervisor-agent}"
  SOCKET_DIR="${SUPERVISOR_SOCKET_DIR:-/run/sensorsphere-supervisor-agent}"
else
  MANAGED_ROOT="${SUPERVISOR_MANAGED_ROOT:-${HOME}/sensorsphere-${ENVIRONMENT}}"
  INSTALL_DIR="${SUPERVISOR_INSTALL_DIR:-${MANAGED_ROOT}/supervisor-agent}"
  SOCKET_DIR="${SUPERVISOR_SOCKET_DIR:-/run/sensorsphere/${NAMESPACE}}"
fi
ADDITIONAL_MANAGED_ROOT="${SUPERVISOR_ADDITIONAL_MANAGED_ROOT:-$([[ "$ENVIRONMENT" == "DEFAULT" ]] && printf /opt || printf /opt/sensorsphere-%s "$ENVIRONMENT")}"
SOCKET_PATH="${SUPERVISOR_SOCKET_PATH:-/run/sensorsphere-supervisor-agent/supervisor.sock}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-sensorsphere-${NAMESPACE}-supervisor}"
HOST_SOCKET_PATH="${SOCKET_DIR}/$(basename "$SOCKET_PATH")"
SOURCE_REF="v${VERSION}"
IMAGE="ghcr.io/sensorsphere/sensorsphere-supervisor-agent:${VERSION}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for cmd in curl docker mktemp; do command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"; done
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || fail "VERSION must be a semantic version"
[[ "$MANAGED_ROOT" = /* ]] || fail "SUPERVISOR_MANAGED_ROOT must be absolute"

mkdir -p "$INSTALL_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SENSORSPHERE_URL_DISPLAY="${SENSORSPHERE_URL:-}"
if [[ -z "$SENSORSPHERE_URL_DISPLAY" && -f "$INSTALL_DIR/.env" ]]; then
  SENSORSPHERE_URL_DISPLAY="$(sed -n 's/^SENSORSPHERE_URL=//p' "$INSTALL_DIR/.env" | tail -1)"
fi
[[ -n "$SENSORSPHERE_URL_DISPLAY" ]] || SENSORSPHERE_URL_DISPLAY="(not configured)"

printf 'Installing SensorSphere Supervisor Agent\n'
printf '  SensorSphere URL:  %s\n' "$SENSORSPHERE_URL_DISPLAY"
printf '  version:           %s\n' "$VERSION"
printf '  environment:       %s\n' "$ENVIRONMENT"
printf '  namespace:         %s\n' "$NAMESPACE"
printf '  install dir:       %s\n' "$INSTALL_DIR"
printf '  managed root:      %s\n' "$MANAGED_ROOT"
printf '  Supervisor socket: %s\n' "$HOST_SOCKET_PATH"
printf '  PUID/PGID:         %s/%s\n' "$(id -u)" "$(id -g)"

curl -fsSL "${RAW_BASE_URL}/${REPOSITORY}/${SOURCE_REF}/docker-compose.yml" -o "$TMP_DIR/docker-compose.yml"
curl -fsSL "${RAW_BASE_URL}/${REPOSITORY}/${SOURCE_REF}/.env.example" -o "$TMP_DIR/.env.example"
cp "$TMP_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
cp "$TMP_DIR/.env.example" "$INSTALL_DIR/.env.example"

if [[ -f "$INSTALL_DIR/.env" ]]; then
  backup="$INSTALL_DIR/.env.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$INSTALL_DIR/.env" "$backup"
  printf 'Preserving existing %s/.env\n' "$INSTALL_DIR"
  printf 'Backup created: %s\n' "$backup"
else
  : > "$INSTALL_DIR/.env"
fi

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$INSTALL_DIR/.env"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$INSTALL_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$INSTALL_DIR/.env"
  fi
}
ensure_env() {
  local key="$1" value="$2"
  grep -q "^${key}=." "$INSTALL_DIR/.env" || printf '%s=%s\n' "$key" "$value" >> "$INSTALL_DIR/.env"
}

set_env SUPERVISOR_AGENT_IMAGE "$IMAGE"
set_env SENSORSPHERE_ENVIRONMENT "$ENVIRONMENT"
set_env COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT"
set_env SUPERVISOR_MANAGED_ROOT "$MANAGED_ROOT"
set_env SUPERVISOR_ADDITIONAL_MANAGED_ROOT "$ADDITIONAL_MANAGED_ROOT"
ensure_env SUPERVISOR_DEFAULT_PUID "$(id -u)"
ensure_env SUPERVISOR_DEFAULT_PGID "$(id -g)"
set_env SUPERVISOR_SOCKET_DIR "$SOCKET_DIR"
set_env SUPERVISOR_SOCKET_PATH "$SOCKET_PATH"
ensure_env SUPERVISOR_SOCKET_GID "$(id -g)"
set_env SUPERVISOR_OPERATION_TIMEOUT_MS "${SUPERVISOR_OPERATION_TIMEOUT_MS:-600000}"
ensure_env SUPERVISOR_SELF_INSTALL_DIR "$INSTALL_DIR"
ensure_env SUPERVISOR_SELF_UPDATE_TIMEOUT_MS "120000"
ensure_env SENSORSPHERE_HEARTBEAT_INTERVAL_MS "30000"
set_env SUPERVISOR_HOSTNAME "$(hostname)"

[[ -n "${SENSORSPHERE_URL:-}" ]] && set_env SENSORSPHERE_URL "$SENSORSPHERE_URL"
[[ -n "${SENSORSPHERE_AGENT_TOKEN:-}" ]] && set_env SENSORSPHERE_AGENT_TOKEN "$SENSORSPHERE_AGENT_TOKEN"
[[ -n "${SUPERVISOR_NAME:-}" ]] && set_env SUPERVISOR_NAME "$SUPERVISOR_NAME"
chmod 600 "$INSTALL_DIR/.env"

(
  cd "$INSTALL_DIR"
  docker compose --env-file .env config -q
  docker compose --env-file .env pull
  docker compose --env-file .env up -d
)

socket_path="$HOST_SOCKET_PATH"
for _ in $(seq 1 30); do
  [[ -S "$socket_path" ]] && { printf 'Supervisor socket ready: %s\n' "$socket_path"; exit 0; }
  sleep 1
done
fail "Supervisor socket did not appear: $socket_path"

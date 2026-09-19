#!/usr/bin/env sh
set -eu

VERSION="$(cat VERSION | tr -d '[:space:]')"
IMAGE_NAMESPACE="${IMAGE_NAMESPACE:-sensorsphere}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io}"
IMAGE_NAME="${IMAGE_NAME:-sensorsphere-supervisor-agent}"
IMAGE="${IMAGE_REGISTRY}/${IMAGE_NAMESPACE}/${IMAGE_NAME}"

echo "Publishing ${IMAGE}:${VERSION} and ${IMAGE}:latest"

docker buildx build \
  --platform linux/amd64,linux/arm64,linux/arm/v7 \
  --tag "${IMAGE}:${VERSION}" \
  --tag "${IMAGE}:latest" \
  --push \
  .

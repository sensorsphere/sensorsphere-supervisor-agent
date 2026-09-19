FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM alpine:3.22
ARG IMAGE_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/sensorsphere/sensorsphere-supervisor-agent" \
      org.opencontainers.image.title="SensorSphere Supervisor Agent" \
      org.opencontainers.image.description="SensorSphere host-local lifecycle supervisor for managed agents" \
      org.opencontainers.image.version="${IMAGE_VERSION}"
RUN apk add --no-cache nodejs docker-cli docker-cli-compose
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY VERSION ./VERSION
ENTRYPOINT ["node", "dist/index.js"]

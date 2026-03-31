# syntax=docker/dockerfile:1

# --- Build stage ---
FROM oven/bun:1.3 AS build

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY src/ src/
COPY config.toml tsconfig.json ./

# --- Runtime stage ---
FROM oven/bun:1.3-slim

WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/src src
COPY --from=build /app/config.toml /app/tsconfig.json /app/package.json ./

EXPOSE 8000

CMD ["bun", "run", "src/index.ts"]

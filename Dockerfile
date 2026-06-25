# Favro MCP HTTP server — container image for Cloud Run.
# Two-stage: build with dev deps (tsc), ship a slim prod-only runtime.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# mcp-server.js does require('../package.json') for its version string, so the
# manifest must be present at runtime alongside dist/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Cloud Run routes traffic to the container port; bind all interfaces. The
# platform's front layer is the only thing that can reach this port and it
# terminates TLS, satisfying the "TLS in front" requirement.
ENV FAVRO_MCP_HOST=0.0.0.0
EXPOSE 8080

# Drop root.
USER node

# Cloud Run injects $PORT (default 8080); the server reads FAVRO_MCP_PORT, so
# bridge the two at runtime. Falls back to 8080 outside Cloud Run.
CMD ["sh", "-c", "FAVRO_MCP_PORT=${PORT:-8080} node dist/mcp-http-server.js"]

# ---- Stage 1: Build ----
FROM node:24-slim AS build

WORKDIR /app

# Copy package files for dependency install
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY tsconfig.base.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY packages/server/ packages/server/
COPY packages/client/ packages/client/

# Build server (tsup) and client (vite)
RUN npm run build -w packages/server
RUN npm run build -w packages/client

# ---- Stage 2: Runtime ----
FROM node:24-slim

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev

# Install Playwright Chromium AND its system dependencies in one command.
# --with-deps handles apt package installation for whatever Debian/Ubuntu base we're on.
RUN npx -w packages/server playwright install --with-deps chromium

# Copy built artifacts from build stage
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist

# Copy tsconfig for any runtime needs
COPY tsconfig.base.json ./

# Create data directory
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3001
ENV DATA_DIR=/data
ENV CLIENT_DIST_PATH=/app/packages/client/dist

EXPOSE 3001

CMD ["node", "packages/server/dist/index.js"]

# Multi-stage build for Next.js + PocketBase monorepo
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat unzip curl
WORKDIR /app

# Install Yarn v4
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Copy package files — workspace path must match root package.json ("pocketbase")
COPY package.json yarn.lock .yarnrc.yml* ./
COPY webapp/package.json ./webapp/
COPY shared/package.json ./shared/
COPY pocketbase/package.json ./pocketbase/

# Install dependencies
RUN yarn install --immutable

# Download PocketBase binary. TARGETARCH is auto-set by buildx (amd64/arm64),
# matching PocketBase's release naming. POCKETBASE_ARCH override stays for
# manual `docker build` invocations that aren't using buildx.
ARG TARGETARCH
ARG POCKETBASE_VERSION=0.39.10
ARG POCKETBASE_ARCH
RUN PB_ARCH="${POCKETBASE_ARCH:-${TARGETARCH}}" && \
    mkdir -p /app/pocketbase && \
    curl -L "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_${PB_ARCH}.zip" \
    -o /tmp/pocketbase.zip && \
    unzip /tmp/pocketbase.zip -d /app/pocketbase && \
    chmod +x /app/pocketbase/pocketbase && \
    rm /tmp/pocketbase.zip

# Build stage
FROM base AS builder
WORKDIR /app

# Install Yarn v4
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.yarn ./.yarn
COPY --from=deps /app/pocketbase/pocketbase ./pb/pocketbase

# Copy workspace files
COPY package.json yarn.lock .yarnrc.yml* ./
COPY webapp ./webapp
COPY shared ./shared
# Source lives at pb/ at runtime; pocketbase/ stub satisfies yarn workspace resolution
COPY pocketbase ./pb
COPY pocketbase/package.json ./pocketbase/

# Build shared package first (required by webapp)
RUN yarn workspace @garage-ware/shared build

# Build Next.js application. NEXT_PUBLIC_* vars are inlined into the client
# bundle at build time, so they must be set here, not at runtime. Setting them
# on the runtime container (e.g. a k8s pod) has NO effect — rebuild the image
# with the right --build-arg values instead.
#
# The S3 gateway endpoint/region are intentionally NOT here: they are served at
# runtime by /next-api/config from GARAGE_S3_ENDPOINT / GARAGE_S3_REGION, so the
# same image can be pointed at any cluster via plain runtime env (no rebuild).
ARG NEXT_PUBLIC_POCKETBASE_URL=/
ENV NEXT_PUBLIC_POCKETBASE_URL=$NEXT_PUBLIC_POCKETBASE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN yarn workspace @garage-ware/webapp build

# Production stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install supervisor, nginx, and curl
RUN apk add --no-cache supervisor nginx curl

# Install Yarn v4
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    adduser nextjs nodejs

# Create directories for supervisor and nginx
RUN mkdir -p /var/log/supervisor /var/run /etc/supervisor/conf.d && \
    mkdir -p /var/log/nginx /var/cache/nginx /var/run/nginx && \
    chown -R nextjs:nodejs /var/log/supervisor /var/run && \
    chown -R nginx:nginx /var/log/nginx /var/cache/nginx /var/run/nginx

# Copy PocketBase binary
COPY --from=builder --chown=nextjs:nodejs /app/pb/pocketbase ./pb/pocketbase

# Copy PocketBase hooks and migrations
COPY --from=builder --chown=nextjs:nodejs /app/pb/pb_hooks ./pb/pb_hooks
COPY --from=builder --chown=nextjs:nodejs /app/pb/pb_migrations ./pb/pb_migrations

# Single /data volume holds all runtime state (PocketBase DB, file uploads,
# any future app-level dynamic storage). Bake the directory + ownership in so
# the image runs out-of-the-box without a host mount, and works with one when
# users supply -v $PWD/data:/data.
RUN mkdir -p /data/pb_data && chown -R nextjs:nodejs /data
VOLUME ["/data"]

# Copy package files for workspace resolution
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./
COPY --from=builder --chown=nextjs:nodejs /app/yarn.lock ./
COPY --from=builder --chown=nextjs:nodejs /app/.yarnrc.yml ./.yarnrc.yml
COPY --from=builder --chown=nextjs:nodejs /app/.yarn ./.yarn

# Copy workspace package.json files
COPY --from=builder --chown=nextjs:nodejs /app/webapp/package.json ./webapp/
COPY --from=builder --chown=nextjs:nodejs /app/shared/package.json ./shared/
COPY --from=builder --chown=nextjs:nodejs /app/pb/package.json ./pb/
# Root package.json declares workspace "pocketbase" — this stub satisfies Yarn's resolution
COPY --from=builder --chown=nextjs:nodejs /app/pocketbase/package.json ./pocketbase/

COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules


# Copy built application
COPY --from=builder --chown=nextjs:nodejs /app/webapp/.next ./webapp/.next
COPY --from=builder --chown=nextjs:nodejs /app/webapp/public ./webapp/public
COPY --from=builder --chown=nextjs:nodejs /app/webapp/next.config.ts ./webapp/next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/webapp/tsconfig.json ./webapp/tsconfig.json

# Copy shared package dist
COPY --from=builder --chown=nextjs:nodejs /app/shared/dist ./shared/dist

# Copy supervisor and nginx configs
COPY --chown=root:root docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY --chown=root:root docker/nginx.conf /etc/nginx/nginx.conf
COPY --chown=nextjs:nodejs docker/start.sh /app/start.sh

# Make startup script executable
RUN chmod +x /app/start.sh

# Create nginx user if it doesn't exist (it should from apk install)
# Ensure nginx can read the config
RUN chmod 644 /etc/nginx/nginx.conf

EXPOSE 80

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Run as root initially to start supervisor (which will manage processes as appropriate users)
CMD ["/app/start.sh"]

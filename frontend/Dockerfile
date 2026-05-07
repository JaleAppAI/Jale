# syntax=docker/dockerfile:1
#
# Jale Frontend — Production container
#
# This image works on BOTH Lambda (current) and EC2/ECS (future migration).
# AWS Lambda Web Adapter intercepts and translates Lambda invocations to HTTP.
# Outside Lambda, the adapter is dormant and the Node server runs directly.

# ─── Stage 1: Dependencies ────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Install full dependencies (including devDeps needed for build)
COPY package.json package-lock.json ./
RUN npm ci

# ─── Stage 2: Build ───────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 3: Runtime ─────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# AWS Lambda Web Adapter — listens on $PORT, translates Lambda → HTTP
# https://github.com/awslabs/aws-lambda-web-adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# Copy standalone build artifacts (small footprint, no devDeps)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]

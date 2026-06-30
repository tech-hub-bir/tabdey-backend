# wallet_payment/Dockerfile

# Stage 1: Prisma generator/root deps
FROM node:20-alpine AS prisma-builder

WORKDIR /app

RUN apk add --no-cache openssl

# Root package is used for Prisma packages + Prisma generate
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --include=dev

# Generate Prisma client from root prisma/schema.prisma
RUN npx prisma generate

# Keep only production deps after generate
RUN npm prune --omit=dev


# Stage 2: Wallet service dependencies
FROM node:20-alpine AS wallet-builder

WORKDIR /app

RUN apk add --no-cache openssl

# Install wallet_payment service dependencies
COPY wallet_payment/package*.json ./wallet_payment/

WORKDIR /app/wallet_payment

RUN npm ci --omit=dev

# Copy wallet service source and shared files
WORKDIR /app
COPY wallet_payment ./wallet_payment
COPY lib ./lib
COPY middlewares ./middlewares

# Optional safety: make lib available inside wallet_payment too
RUN mkdir -p /app/wallet_payment/lib && \
    cp -a /app/lib/. /app/wallet_payment/lib/


# Stage 3: Production
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Root Prisma runtime deps
# Needed by /app/generated/prisma/runtime/client.js
COPY --from=prisma-builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=prisma-builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=prisma-builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=prisma-builder --chown=nodejs:nodejs /app/package*.json ./

# Wallet service deps/source
COPY --from=wallet-builder --chown=nodejs:nodejs /app/wallet_payment ./wallet_payment

# Shared logger and middleware
COPY --from=wallet-builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=wallet-builder --chown=nodejs:nodejs /app/middlewares ./middlewares

USER nodejs

WORKDIR /app/wallet_payment

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)}).on('error', () => process.exit(1))"

EXPOSE 3000

CMD ["node", "server.js"]
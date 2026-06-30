# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy root package files and root Prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install ALL root dependencies including dev dependencies
RUN npm ci --include=dev

# Generate Prisma Client
RUN npx prisma generate

# Copy the user merchant chat service and shared files
COPY user_merchant_chat ./user_merchant_chat
COPY lib ./lib
COPY middlewares ./middlewares

# Optional safety: make root lib available inside service folder too
RUN mkdir -p /app/user_merchant_chat/lib && \
    cp -a /app/lib/. /app/user_merchant_chat/lib/

# Prune dev dependencies for production
RUN npm prune --production


# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create uploads directory for chat images
RUN mkdir -p /app/user_merchant_chat/uploads/chat && \
    chown -R nodejs:nodejs /app/user_merchant_chat/uploads

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=builder --chown=nodejs:nodejs /app/middlewares ./middlewares
COPY --from=builder --chown=nodejs:nodejs /app/user_merchant_chat ./user_merchant_chat

# Switch to non-root user
USER nodejs

# Set working directory to chat service
WORKDIR /app/user_merchant_chat

# Environment variables
ENV NODE_ENV=production
ENV PORT=4010
ENV UPLOAD_ROOT=/app/user_merchant_chat/uploads

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:4010/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)}).on('error', () => process.exit(1))"

EXPOSE 4010

# Start the application
CMD ["node", "server.js"]
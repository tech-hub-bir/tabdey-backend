# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy root package files
COPY package*.json ./
COPY prisma ./prisma/

# Install ALL dependencies including dev
RUN npm ci --include=dev

# Generate Prisma Client
RUN npx prisma generate

# Copy shared and service files
COPY order_management ./order_management
COPY lib ./lib
COPY middlewares ./middlewares

# Prune dev dependencies for production
RUN npm prune --production

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create uploads directory within the app directory
RUN mkdir -p /app/order_management/uploads/order_delivery_photos && \
    chown -R nodejs:nodejs /app/order_management/uploads

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/order_management ./order_management
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=builder --chown=nodejs:nodejs /app/middlewares ./middlewares
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

# Switch to non-root user
USER nodejs

# Set working directory to order_management service
WORKDIR /app/order_management

# Environment variables
ENV NODE_ENV=production
ENV PORT=1001
ENV UPLOAD_ROOT=/app/order_management/uploads

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:1001/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

EXPOSE 1001

# Start the application
CMD ["node", "server.js"]
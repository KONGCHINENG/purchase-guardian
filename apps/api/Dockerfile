# syntax=docker/dockerfile:1
# Build from the repo root:  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/policy-engine/package.json packages/policy-engine/
COPY packages/paypal-client/package.json packages/paypal-client/
RUN npm ci --workspace @guardian/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN npm run build -w @guardian/api && npm prune --omit=dev --workspace @guardian/api --include-workspace-root

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT:-4000}/health || exit 1
CMD ["node", "dist/main.js"]

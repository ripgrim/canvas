FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/sync-room-core ./apps/sync-room-core
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @canvas/sync-room-core... build
RUN pnpm --filter @canvas/sync-room-core deploy --prod --legacy /runtime

FROM node:24-bookworm-slim
WORKDIR /runtime
ENV NODE_ENV=production
COPY --from=build /runtime ./
EXPOSE 4325
CMD ["node", "dist/dev-host.js"]

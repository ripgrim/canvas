FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/thumbnail-jobs ./apps/thumbnail-jobs
COPY packages/repo-engine ./packages/repo-engine
COPY packages/thumbnail-capture ./packages/thumbnail-capture
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @canvas/thumbnail-jobs... build
RUN pnpm --filter @canvas/thumbnail-jobs deploy --prod --legacy /runtime

FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /runtime
ENV NODE_ENV=production
COPY --from=build /runtime ./
EXPOSE 4324
CMD ["node", "dist/serve.js"]

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /validator
COPY infra/hosted-docs-validator/package.json infra/hosted-docs-validator/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --production
RUN mkdir -p node_modules/@trycompai \
  && ln -s /validator/repository/packages/design-system node_modules/@trycompai/design-system \
  && ln -s /validator/repository/packages/tsconfig node_modules/@trycompai/tsconfig
COPY infra/hosted-docs-validator/validate.mjs ./validate.mjs

USER 65532:65532
ENTRYPOINT ["bun", "/validator/validate.mjs"]

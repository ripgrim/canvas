FROM node:22.22.0-alpine3.23@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34

WORKDIR /builder
COPY infra/hosted-preview-builder/package.json infra/hosted-preview-builder/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force
COPY infra/hosted-preview-builder/build.mjs infra/hosted-preview-builder/contract.mjs ./

USER 65532:65532
ENTRYPOINT ["node", "/builder/build.mjs"]

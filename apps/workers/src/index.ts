import {
  FileAssetService,
  ThumbnailGarbageCollector,
  UploadIntentSigner,
} from "@canvas/files"
import { createR2BindingAssetStore } from "@canvas/files/r2"
import { createHostedPreviewArtifactAssetStorage } from "@canvas/files/hosted-preview"
import {
  createFileAssetsHandler,
  createHostedFileAccessAuthority,
  createHostedThumbnailCommitResolver,
  createHostedThumbnailServiceAuthority,
} from "@canvas/files/worker"

import { trustedMediaDecoder } from "./media-decoder.js"
import { runScheduledThumbnailGarbageCollection } from "./scheduled-maintenance.js"

interface Env {
  FILE_ASSETS: object
  API_ORIGIN: string
  API_SERVICE_TOKEN: string
  UPLOAD_INTENT_SECRET: string
  HOSTED_PREVIEW_WRITE_SECRET: string
  ASSETS_ORIGIN: string
  ALLOWED_ORIGINS?: string
}

function createHandler(env: Env) {
  const store = createR2BindingAssetStore({ binding: env.FILE_ASSETS })
  const service = new FileAssetService({
    store,
    signer: new UploadIntentSigner({ secret: env.UPLOAD_INTENT_SECRET }),
    mediaDecoder: trustedMediaDecoder,
  })
  const accessAuthority = createHostedFileAccessAuthority({
    apiOrigin: env.API_ORIGIN,
    serviceToken: env.API_SERVICE_TOKEN,
  })
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  const thumbnailServiceAuthority = createHostedThumbnailServiceAuthority({
    apiOrigin: env.API_ORIGIN,
    serviceToken: env.API_SERVICE_TOKEN,
  })
  return createFileAssetsHandler({
    service,
    accessAuthority,
    thumbnailServiceAuthority,
    serviceToken: env.API_SERVICE_TOKEN,
    hostedPreviewStorage: createHostedPreviewArtifactAssetStorage({ store }),
    hostedPreviewWriteSecret: env.HOSTED_PREVIEW_WRITE_SECRET,
    hostedPreviewAssetsOrigin: env.ASSETS_ORIGIN,
    allowedOrigins,
  })
}

const MAX_GARBAGE_COLLECTION_PAGES = 12

async function collectThumbnailGarbage(env: Env): Promise<void> {
  const store = createR2BindingAssetStore({ binding: env.FILE_ASSETS })
  const collector = new ThumbnailGarbageCollector({
    store,
    committed: createHostedThumbnailCommitResolver({
      apiOrigin: env.API_ORIGIN,
      serviceToken: env.API_SERVICE_TOKEN,
    }),
  })
  await runScheduledThumbnailGarbageCollection({
    store,
    collector,
    maxPages: MAX_GARBAGE_COLLECTION_PAGES,
  })
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createHandler(env)(request)
  },
  scheduled(
    _controller: unknown,
    env: Env,
    context: Readonly<{ waitUntil(promise: Promise<unknown>): void }>,
  ): void {
    context.waitUntil(collectThumbnailGarbage(env))
  },
}

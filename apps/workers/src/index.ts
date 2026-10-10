import { UploadIntentSigner, FileAssetService } from "@canvas/files"
import { createR2BindingAssetStore } from "@canvas/files/r2"
import {
  createFileAssetsHandler,
  createHostedFileAccessAuthority,
} from "@canvas/files/worker"

interface Env {
  FILE_ASSETS: object
  API_ORIGIN: string
  API_SERVICE_TOKEN: string
  UPLOAD_INTENT_SECRET: string
  ALLOWED_ORIGINS?: string
}

function createHandler(env: Env) {
  const service = new FileAssetService({
    store: createR2BindingAssetStore({ binding: env.FILE_ASSETS }),
    signer: new UploadIntentSigner({ secret: env.UPLOAD_INTENT_SECRET }),
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
  return createFileAssetsHandler({ service, accessAuthority, allowedOrigins })
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return createHandler(env)(request)
  },
}

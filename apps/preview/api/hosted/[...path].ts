import { createHostedPreviewGateway } from "../../hosted-gateway.js"

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value || /[\r\n]/.test(value)) throw new Error(`Missing ${name}.`)
  return value
}

function handler(): (request: Request) => Promise<Response> {
  return createHostedPreviewGateway({
    previewOrigin: required("HOSTED_PREVIEW_ORIGIN"),
    assetsOrigin: required("ASSETS_ORIGIN"),
    editorOrigins: required("HOSTED_PREVIEW_EDITOR_ORIGINS").split(",").map(value => value.trim()).filter(Boolean),
    serviceToken: required("API_SERVICE_TOKEN"),
    capabilitySecret: required("HOSTED_PREVIEW_CAPABILITY_SECRET"),
  })
}

export default {
  fetch(request: Request): Promise<Response> {
    return handler()(request)
  },
}

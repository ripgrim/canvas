const flowersUrl = new URL('../assets/flowers.webp', import.meta.url).href

export async function loadDefaultImage(request: typeof fetch = globalThis.fetch): Promise<File> {
  const response = await request(flowersUrl, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('Default image unavailable')
  return new File([await response.blob()], 'flowers.webp', { type: 'image/webp' })
}

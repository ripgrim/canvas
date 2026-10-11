async function run() {
  const api = window.designEditor
  if (!api) throw new Error('Actual preload did not expose the design editor API.')
  const before = await api.getAuthSession()
  const after = before.status === 'signed-out' ? await api.signInWithGitHub() : before
  const report = {
    phase: before.status === 'signed-out' ? 'first' : 'reload',
    before,
    after,
    surface: Object.keys(api).sort(),
    globals: {
      requireType: typeof window.require,
      authClientType: typeof api.authClient,
      cookieType: typeof api.cookie,
    },
  }
  console.log(`AUTH_RENDERER_REPORT ${JSON.stringify(report)}`)
}

void run().catch(error => console.error(`AUTH_RENDERER_FAILURE ${error instanceof Error ? error.message : String(error)}`))

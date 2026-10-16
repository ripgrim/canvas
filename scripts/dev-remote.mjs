import { execFileSync } from 'node:child_process'

const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }))
const host = status?.Self?.DNSName?.trim().replace(/\.$/, '')
if (status?.BackendState !== 'Running' || status?.Self?.Online !== true || !host?.endsWith('.ts.net')) throw new Error('Tailscale must be online with MagicDNS enabled.')
process.env.CANVAS_REMOTE_DEV_HOST = host
const { remoteDevPorts } = await import('./local-services.mjs')
const localPorts = Object.freeze({ web: 4317, preview: 4318, login: 4319, api: 4320, sync: 4321, assets: 4322 })
for (const [name, remotePort] of Object.entries(remoteDevPorts)) {
  execFileSync('tailscale', ['serve', '--bg', '--yes', `--https=${remotePort}`, `http://127.0.0.1:${localPorts[name]}`], { stdio: 'ignore' })
}
await import('./dev-cloud.mjs')

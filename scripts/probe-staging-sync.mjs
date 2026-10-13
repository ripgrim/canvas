import { randomBytes, randomUUID } from 'node:crypto'
import { connect } from 'node:tls'
import { collaborationWebSocketProtocol } from '../packages/sync-protocol/dist/index.js'

const host = 'sync-staging.canvas.ripgrim.com'
const origin = 'https://staging.canvas.ripgrim.com'
const path = `/sync/${randomUUID()}?tabId=deployment-probe-${randomBytes(8).toString('hex')}`
const key = randomBytes(16).toString('base64')

const response = await new Promise((resolve, reject) => {
  const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: true })
  let source = ''
  const timeout = setTimeout(() => socket.destroy(new Error('Staging sync probe timed out.')), 15_000)
  socket.setEncoding('utf8')
  socket.once('secureConnect', () => {
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Protocol: ${collaborationWebSocketProtocol}`,
      `Origin: ${origin}`,
      '',
      '',
    ].join('\r\n'))
  })
  socket.on('data', chunk => {
    source += chunk
    if (!source.includes('\r\n\r\n')) return
    clearTimeout(timeout)
    socket.end()
    resolve(source)
  })
  socket.once('error', error => { clearTimeout(timeout); reject(error) })
  socket.once('end', () => {
    clearTimeout(timeout)
    if (!source.includes('\r\n\r\n')) reject(new Error('Staging sync probe returned an incomplete response.'))
  })
})

const statusLine = response.split('\r\n', 1)[0]
const status = Number(/^HTTP\/1\.1 ([0-9]{3}) /.exec(statusLine)?.[1])
if (status !== 404) throw new Error(`Staging sync rejected ${collaborationWebSocketProtocol} with ${statusLine}.`)
process.stdout.write(`STAGING_SYNC_EVIDENCE ${JSON.stringify({ host, protocol: collaborationWebSocketProtocol, status })}\n`)

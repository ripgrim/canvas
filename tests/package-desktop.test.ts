import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createPackageEnvironment } from '../scripts/package-desktop.mjs'

const publicProductionConfiguration = {
  VITE_APP_URL: 'https://canvas.example.test',
  VITE_SYNC_ORIGIN: 'wss://sync.example.test',
  VITE_COLLABORATION_BUILD_ID: 'release-test-build',
  DESIGN_EDITOR_AUTH_URL: 'https://api.example.test',
  DESIGN_EDITOR_LOGIN_URL: 'https://login.example.test',
  DESIGN_EDITOR_PREVIEW_URL: 'https://preview.example.test',
  DESIGN_EDITOR_ASSETS_URL: 'https://assets.example.test',
  DESIGN_EDITOR_UPDATE_URL: 'https://updates.example.test/windows/x64',
}

describe('AT-PACKAGE-ENV-001 desktop packaging environment', () => {
  it('inherits only required Windows and toolchain values plus configured public origins', () => {
    const environment = createPackageEnvironment({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      npm_execpath: 'C:\\pnpm\\pnpm.cjs',
      SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent',
      GOOGLE_APPLICATION_CREDENTIALS: 'C:\\credentials\\google.json',
      UNRELATED_SHELL_VALUE: 'not-for-the-packager',
      DESIGN_EDITOR_AUTH_URL: 'https://ambient.example.test',
    }, publicProductionConfiguration, 'production')

    expect(environment).toMatchObject({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      npm_execpath: 'C:\\pnpm\\pnpm.cjs',
      ...publicProductionConfiguration,
      DESIGN_EDITOR_PACKAGE_MODE: 'production',
      NODE_ENV: 'production',
    })
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(environment).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS')
    expect(environment).not.toHaveProperty('UNRELATED_SHELL_VALUE')
    expect(environment.DESIGN_EDITOR_AUTH_URL).toBe(publicProductionConfiguration.DESIGN_EDITOR_AUTH_URL)

    const child = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify({ ssh: process.env.SSH_AUTH_SOCK, google: process.env.GOOGLE_APPLICATION_CREDENTIALS }))"], {
      encoding: 'utf8',
      env: environment,
    })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({})
  })
})

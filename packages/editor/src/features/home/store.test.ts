import { afterEach, describe, expect, it } from 'vitest'
import { homeStore } from './store'

afterEach(() => homeStore.dispose())

describe('home store', () => {
  it('shows an empty files home when file listing is unavailable', () => {
    homeStore.configure(undefined)
    homeStore.start()
    expect(homeStore.getSnapshot()).toMatchObject({ files: [], status: { kind: 'ready' } })
    expect(homeStore.getSnapshot()).not.toHaveProperty('screen')
  })
})

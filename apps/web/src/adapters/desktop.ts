import type { EditorCapabilities, EditorProjectApi } from '@canvas/editor/capabilities'

export type DesktopBridge = Omit<EditorProjectApi, 'openProject' | 'capabilities'> & { inspectFixture: EditorProjectApi['openProject'] }
export const desktopCapabilities: EditorCapabilities = {
  runtime: 'desktop', openLabel: 'Open fixture',
  files: {
    list: { available: false, reason: 'Local file listing is not available in the desktop fixture adapter.' },
    create: { available: false, reason: 'Local file creation is not available in the desktop fixture adapter.' },
    open: { available: false, reason: 'Open the trusted fixture from the editor.' },
  },
  localRepository: { available: true, reason: 'The trusted local fixture is connected.' },
  sourceWrites: { available: true, reason: 'Reviewed changes can be saved to the trusted local fixture.' },
  hostedExecution: { available: false, reason: 'Hosted repository execution is not connected.' },
  git: { available: false, reason: 'Git operations are not available yet.' },
  mcp: { available: false, reason: 'MCP is deferred.' },
  hostedProjects: { available: false, reason: 'Hosted projects are not connected.' },
}
export function createDesktopAdapter(bridge: DesktopBridge): EditorProjectApi {
  return {
    capabilities: desktopCapabilities,
    openProject: () => bridge.inspectFixture(), refresh: () => bridge.refresh(),
    saveFile: (file, revision) => bridge.saveFile(file, revision),
    prepareLabelPadding: value => bridge.prepareLabelPadding(value), prepareToken: value => bridge.prepareToken(value),
    preparePromotion: name => bridge.preparePromotion(name), prepareUndo: id => bridge.prepareUndo(id), prepareRedo: id => bridge.prepareRedo(id),
    savePrepared: (id, digest) => bridge.savePrepared(id, digest),
  }
}

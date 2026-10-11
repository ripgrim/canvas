/** The editor's own light or dark appearance. A user preference for application chrome only; it never reaches the design preview. */
export type EditorAppearance = 'light' | 'dark'
export const appearanceKey = 'design-editor.appearance.v1'
type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>
const storage = (): AppearanceStorage | null => { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }

export function readAppearance(source: AppearanceStorage | null = storage()): EditorAppearance {
  try { return source?.getItem(appearanceKey) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

export function writeAppearance(mode: EditorAppearance, source: AppearanceStorage | null = storage()): void {
  try { source?.setItem(appearanceKey, mode) }
  catch (error) { console.warn('The appearance preference could not be stored for the next session.', error) }
}

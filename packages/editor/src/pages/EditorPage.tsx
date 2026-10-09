import { HomeScreen } from '../features/application/HomeScreen'

/** Router-less entry: the home screen opens files in place. Routed apps use HomePage and FilePage instead. */
export function EditorPage() { return <HomeScreen onOpenFile={() => undefined} onCreateFile={() => undefined} /> }

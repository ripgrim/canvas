import { createDocument } from '@canvas/repo-engine/document'
import { browserSampleAtoms, browserSampleComposition } from '../src/adapters/browser'
import { startPreview } from '@canvas/preview-runtime/browser'
import { PreviewLogin } from '../../../tests/fixtures/component-repo-seed/src/PreviewLogin'
import { Button } from '../../../tests/fixtures/component-repo-seed/src/atoms/Button'
import { Card } from '../../../tests/fixtures/component-repo-seed/src/atoms/Card'
import { Input } from '../../../tests/fixtures/component-repo-seed/src/atoms/Input'
import { Label } from '../../../tests/fixtures/component-repo-seed/src/atoms/Label'
import '../../../tests/fixtures/component-repo-seed/src/globals.css'

const editorOrigin = new URLSearchParams(window.location.search).get('editorOrigin')
const compositionMode = new URLSearchParams(window.location.search).get('mode') === 'composition'
if (!editorOrigin || !/^https?:\/\//.test(editorOrigin) || new URL(editorOrigin).origin !== editorOrigin || editorOrigin === window.location.origin) throw new Error('A separate editor origin is required.')
const registry = [{ componentId: 'sample-button', Component: Button }, { componentId: 'sample-card', Component: Card }, { componentId: 'sample-input', Component: Input }, { componentId: 'sample-label', Component: Label }].map(binding => ({ ...binding, exportName: binding.Component.name }))
startPreview({ Component: compositionMode ? () => null : PreviewLogin, initialProps: {}, generation: 1, editorOrigin, componentId: 'bundled-sample', registry, sourceDocument: compositionMode ? null : createDocument(browserSampleAtoms, browserSampleComposition) })

import { useRef, useState, useSyncExternalStore } from 'react'
import { Button, Disclosure, Layout, Text } from '../../design-system/atoms'
import { CodeInput, CodeOutput } from '../../design-system/code-atoms'
import { convertCssDeclarations, serializeComponentUsage } from './code-output'
import { codeToolsCopy as copy } from './code-tools-copy'
import { legacyPageDocument } from '@canvas/repo-engine/file-document'
import { documentStore } from './document-store'

export function CodeTools() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const [css, setCss] = useState('')
  const [notice, setNotice] = useState('')
  const styleRef = useRef<HTMLTextAreaElement | null>(null)
  const usageRef = useRef<HTMLTextAreaElement | null>(null)
  const retainedRef = useRef<HTMLTextAreaElement | null>(null)
  const output = convertCssDeclarations(css)
  let usage = ''
  let reason = copy.noDocument as string
  const pageDocument = state.file && state.pageId ? legacyPageDocument(state.file, state.pageId) : null
  if (pageDocument) {
    const paths = Object.fromEntries(state.atoms.filter(atom => /\.(?:tsx?|jsx?)$/.test(atom.path) && !atom.path.includes('..') && !atom.path.includes('\\')).map(atom => [atom.componentId, './' + atom.path.replace(/\.(?:tsx?|jsx?)$/, '')]))
    try {
      const selected = state.selection.filter(id => Object.hasOwn(pageDocument.nodes, id))
      usage = serializeComponentUsage(pageDocument, state.atoms, { moduleSpecifiers: paths, rootIds: selected.length ? selected : pageDocument.rootIds }).code
    } catch (error) { reason = error instanceof Error ? error.message : copy.noSource }
  }
  const copyText = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(copy.copied) }
    catch { setNotice(copy.denied) }
  }
  const select = (field: HTMLTextAreaElement | null) => { field?.focus(); field?.select(); setNotice(copy.selected) }
  return <Disclosure title={copy.title} open={false}>
    <Disclosure title={copy.convert} open={false}><CodeInput label={copy.css} value={css} onChange={value => { setCss(value); setNotice('') }} /><CodeOutput label={copy.style} value={output.styleCode} fieldRef={styleRef} /><Layout roleName="code-tool-actions"><Button variant="outline" onClick={() => void copyText(output.styleCode)}>{copy.copy}</Button><Button onClick={() => select(styleRef.current)}>{copy.select}</Button></Layout>{output.retainedCss && <CodeOutput label={copy.retained} value={output.retainedCss} fieldRef={retainedRef} />}{output.diagnostics.map((diagnostic, index) => <Text key={index} roleName="muted">{diagnostic.message}</Text>)}</Disclosure>
    <Disclosure title={copy.usage} open={false}>{usage ? <><Text roleName="muted">{copy.draft}</Text><Text roleName="muted">{copy.imports}</Text><CodeOutput label={copy.usage} value={usage} fieldRef={usageRef} /><Layout roleName="code-tool-actions"><Button variant="outline" onClick={() => void copyText(usage)}>{copy.copy}</Button><Button onClick={() => select(usageRef.current)}>{copy.select}</Button></Layout></> : <Text roleName="muted">{reason}</Text>}</Disclosure>
    {notice && <Layout roleName="code-tool-notice" aria-live="polite"><Text>{notice}</Text></Layout>}
  </Disclosure>
}

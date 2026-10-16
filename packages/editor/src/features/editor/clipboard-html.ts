const blockElements = new Set(['blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'pre'])

const appendBreak = (parts: string[]) => {
  if (parts.length && !parts.at(-1)!.endsWith('\n')) parts.push('\n')
}

/** Converts the already allowlisted clipboard HTML profile into one honest text node. */
export function clipboardHtmlToText(source: string): string {
  const body = new DOMParser().parseFromString(source, 'text/html').body
  const parts: string[] = []
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
      return
    }
    if (!(node instanceof Element)) return
    const name = node.localName.toLowerCase()
    if (name === 'br') {
      appendBreak(parts)
      return
    }
    if (name === 'li') parts.push(node.parentElement?.localName.toLowerCase() === 'ol' ? `${[...node.parentElement.children].indexOf(node) + 1}. ` : '• ')
    for (const child of node.childNodes) visit(child)
    if (blockElements.has(name)) appendBreak(parts)
  }
  for (const child of body.childNodes) visit(child)
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

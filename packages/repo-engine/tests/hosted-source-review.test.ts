import { describe, expect, it } from 'vitest'
import { hostedDocsReview, parseHostedDocsReviewBundle } from '../src/hosted-source-review.js'

const input = () => ({
  version: 1,
  projectId: 'project-1',
  fileId: '00000000-0000-4000-8000-000000000001',
  fileRevision: 12,
  fileDocumentSha256: '1'.repeat(64),
  scanJobId: '00000000-0000-4000-8000-000000000002',
  installationId: '2001',
  repositoryId: '4001',
  repositoryGrantId: 'grant-1',
  repositoryLinkedAt: 1_800_000_000_000,
  baseRef: 'refs/heads/main',
  baseCommitSha: 'a'.repeat(40),
  baseTreeSha: 'b'.repeat(40),
  adapter: {
    version: 1,
    renderer: 'blume',
    layout: { docsDirectory: 'apps/docs/content/docs/components', examplesDirectory: 'apps/docs/registry/comp', metaPath: 'apps/docs/content/docs/components/meta.ts', manifestPath: 'apps/docs/registry/comp/components.json' },
    components: [{ componentId: 'button', slug: 'button', importSpecifier: '@comp/ui/button', examplePath: 'button' }],
  },
  files: [{ path: 'apps/docs/content/docs/components/button.mdx', beforeSha256: null, after: '# Button\n', diff: '+# Button\n' }],
  omissions: [],
  validation: [{ name: 'Blume documentation build', detail: 'Validated the staged output.' }],
})

const invalidCases: readonly [string, (value: ReturnType<typeof input>) => void][] = [
  ['a traversal path', value => { value.files[0]!.path = '../secret' }],
  ['a duplicate output path', value => { value.files.push({ ...value.files[0]!, path: value.files[0]!.path.toUpperCase() }) }],
  ['an unvalidated review', value => { value.validation = [] }],
  ['an unknown field', value => { Object.assign(value, { command: 'pnpm build' }) }],
  ['a branch outside heads', value => { value.baseRef = 'refs/tags/main' }],
]

describe('hosted documentation review', () => {
  it('COMP-V2-DOCS-004 creates one stable approval digest for the exact reviewed inputs', () => {
    const first = hostedDocsReview(input())
    const second = hostedDocsReview(structuredClone(input()))

    expect(first).toEqual(second)
    expect(first.approvalDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(first.bundle.files)).toBe(true)
  })

  it('COMP-V2-DOCS-NEG-002 invalidates approval when any reviewed byte changes', () => {
    const original = hostedDocsReview(input())
    const changed = input()
    changed.files[0]!.after = '# Changed\n'

    expect(hostedDocsReview(changed).approvalDigest).not.toBe(original.approvalDigest)
  })

  it.each(invalidCases)('COMP-V2-DOCS-NEG-002 rejects %s', (_label, mutate) => {
    const value = input()
    mutate(value)
    expect(() => parseHostedDocsReviewBundle(value)).toThrow('Invalid hosted documentation review')
  })
})

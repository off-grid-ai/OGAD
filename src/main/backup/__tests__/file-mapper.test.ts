import { describe, expect, it } from 'vitest'
import { BundleError } from '@offgrid/sync/portable'
import { DesktopBackupFileMapper, isSafeBackupKey } from '../file-mapper'
import type {
  DesktopBackupData,
  DesktopBackupDocument,
  DesktopBackupProject
} from '../types'

/**
 * How a project's documents travel inside a backup bundle, and why the keys are not their paths.
 *
 * A backup carries files that came from anywhere on the user's disk, and restoring it writes files back
 * out. Both halves are attack surface: two documents can share a basename, a name can contain anything
 * the filesystem allowed, and a bundle can arrive from somewhere other than this app. So documents are
 * addressed by a key this mapper mints, and every key is checked before it is used to write.
 *
 * Pure module, no boundary to fake - the assertions are on the keys and the errors.
 */

const document = (overrides: Partial<DesktopBackupDocument> = {}): DesktopBackupDocument => ({
  name: 'Contract.pdf',
  path: '/Users/someone/Documents/Contract.pdf',
  size: 12_345,
  kind: 'pdf',
  enabled: true,
  createdAt: '2026-01-01T09:00:00.000Z',
  chunks: [],
  ...overrides
})

const project = (overrides: Partial<DesktopBackupProject> = {}): DesktopBackupProject => ({
  id: 'project-alpha',
  name: 'Project Alpha',
  description: '',
  systemPrompt: '',
  includeMemory: false,
  createdAt: '2026-01-01T09:00:00.000Z',
  updatedAt: '2026-01-01T09:00:00.000Z',
  documents: [document()],
  ...overrides
})

const backup = (projects: DesktopBackupProject[]): DesktopBackupData => ({
  surface: 'offgrid-desktop',
  projects,
  conversations: []
})

describe('addressing a backup‑s documents by key rather than by path', () => {
  it('replaces each document path with a key under files/, and reports where to read it from', () => {
    const source = '/Users/someone/Documents/Contract.pdf'
    const { files, keyed } = new DesktopBackupFileMapper().extract(
      backup([project({ documents: [document({ path: source })] })])
    )

    // The bundle must not carry the user's directory layout - that leaks where they keep things, and
    // means nothing on the machine restoring it. What travels is a key; the source path stays behind as
    // an instruction to the writer.
    const key = keyed.projects[0]!.documents[0]!.path
    expect(key).toMatch(/^files\/documents\/project-alpha\/0-[0-9a-f]{16}-Contract\.pdf$/)
    expect(files).toEqual([{ key, sourcePath: source }])
  })

  it('keeps everything else about the document intact', () => {
    const original = document({ name: 'Contract.pdf', size: 999, kind: 'pdf', enabled: false })
    const { keyed } = new DesktopBackupFileMapper().extract(
      backup([project({ documents: [original] })])
    )

    const { path: _replaced, ...rest } = keyed.projects[0]!.documents[0]!
    const { path: _original, ...expected } = original
    expect(rest).toEqual(expected)
  })

  it('gives two documents with the same file name different keys', () => {
    const { files } = new DesktopBackupFileMapper().extract(
      backup([
        project({
          documents: [
            document({ path: '/a/Report.pdf', size: 1 }),
            document({ path: '/b/Report.pdf', size: 2 })
          ]
        })
      ])
    )

    // Same basename, different files. Colliding keys would silently restore one document twice and lose
    // the other - the index and the content hash are what keep them apart.
    expect(files[0]!.key).not.toBe(files[1]!.key)
    expect(new Set(files.map(({ key }) => key)).size).toBe(2)
  })

  it('gives the same document the same key every time, so re-exporting is stable', () => {
    const documents = [document()]
    const first = new DesktopBackupFileMapper().extract(backup([project({ documents })]))
    const second = new DesktopBackupFileMapper().extract(backup([project({ documents })]))

    expect(first.files[0]!.key).toBe(second.files[0]!.key)
  })

  it('changes the key when the document changes, so a stale entry cannot masquerade as the new one', () => {
    const mapper = new DesktopBackupFileMapper()
    const before = mapper.extract(backup([project({ documents: [document({ size: 10 })] })]))
    const after = mapper.extract(backup([project({ documents: [document({ size: 11 })] })]))

    expect(before.files[0]!.key).not.toBe(after.files[0]!.key)
  })

  it('scrubs whatever the file name and project id happened to contain', () => {
    const { keyed } = new DesktopBackupFileMapper().extract(
      backup([
        project({
          id: '../../etc',
          documents: [document({ path: '/tmp/..%2F..%2Fpasswd', name: 'x' })]
        })
      ])
    )

    // A project id and a file name are user data, and both land in a path when the bundle is written.
    // Anything outside [a-zA-Z0-9._-] becomes an underscore and leading/trailing dots are dropped, so
    // '..' cannot survive into a segment - which is what stops a crafted name from escaping the
    // extraction directory.
    const key = keyed.projects[0]!.documents[0]!.path
    expect(isSafeBackupKey(key)).toBe(true)
    expect(key.split('/')).not.toContain('..')
  })

  it('still produces a usable segment when a name scrubs away to nothing', () => {
    const { keyed } = new DesktopBackupFileMapper().extract(
      backup([project({ id: '...', documents: [document({ path: '...', name: '...' })] })])
    )

    // '...' is all dots: normalising leaves an empty segment, and an empty segment is an unsafe key. The
    // fallback keeps the key well-formed instead of producing 'files/documents//0-abc-'.
    const key = keyed.projects[0]!.documents[0]!.path
    expect(isSafeBackupKey(key)).toBe(true)
    expect(key).toContain('/file/')
  })

  it('treats visually identical names written in different unicode forms as the same name', () => {
    // Written as escapes on purpose: as literal characters these two lines are indistinguishable in
    // the source, so the test would compare a string with itself and pass whatever the code did.
    const composed = 'Caf\u00E9.pdf' // \u00E9 is a single code point
    const decomposed = 'Cafe\u0301.pdf' // e followed by a combining acute
    expect(composed).not.toBe(decomposed)
    const mapper = new DesktopBackupFileMapper()

    const a = mapper.extract(backup([project({ documents: [document({ path: composed })] })]))
    const b = mapper.extract(backup([project({ documents: [document({ path: decomposed })] })]))

    // NFKC first, so the same name does not produce two different keys depending on which normalisation
    // the source filesystem used - macOS and Linux disagree about this.
    expect(a.keyed.projects[0]!.documents[0]!.path.split('-').at(-1)).toBe(
      b.keyed.projects[0]!.documents[0]!.path.split('-').at(-1)
    )
  })
})

describe('judging whether a key from a bundle is safe to write', () => {
  it('accepts a key this app minted', () => {
    expect(isSafeBackupKey('files/documents/project-alpha/0-abcdef0123456789-Contract.pdf')).toBe(
      true
    )
  })

  it.each([
    ['outside the files/ tree', 'documents/Contract.pdf'],
    ['an absolute path', '/etc/passwd'],
    ['a parent-directory escape', 'files/../../etc/passwd'],
    ['a bare parent segment', 'files/../secret'],
    ['a current-directory segment', 'files/./Contract.pdf'],
    ['an empty segment', 'files//Contract.pdf'],
    ['a windows separator', 'files\\documents\\Contract.pdf'],
    ['an embedded NUL', 'files/documents/Contract.pdf\0.exe'],
    ['nothing at all', '']
  ])('refuses %s', (_why, key) => {
    // Each of these is a way to write outside the extraction directory, or to confuse the writer about
    // where the file goes. A bundle is untrusted input even when it looks like ours.
    expect(isSafeBackupKey(key)).toBe(false)
  })
})

describe('listing the keys a bundle claims to contain', () => {
  it('returns every document key across every project', () => {
    const keys = new DesktopBackupFileMapper().listKeys(
      backup([
        project({ id: 'p1', documents: [document({ path: 'files/documents/p1/0-aaa-a.pdf' })] }),
        project({ id: 'p2', documents: [document({ path: 'files/documents/p2/0-bbb-b.pdf' })] })
      ])
    )

    expect(keys).toEqual(['files/documents/p1/0-aaa-a.pdf', 'files/documents/p2/0-bbb-b.pdf'])
  })

  it('has nothing to list for a backup with no documents', () => {
    expect(new DesktopBackupFileMapper().listKeys(backup([project({ documents: [] })]))).toEqual([])
    expect(new DesktopBackupFileMapper().listKeys(backup([]))).toEqual([])
  })

  it('refuses the whole bundle when any key would escape, before a single file is written', () => {
    const mapper = new DesktopBackupFileMapper()
    const data = backup([
      project({ id: 'p1', documents: [document({ path: 'files/documents/p1/0-aaa-a.pdf' })] }),
      project({ id: 'p2', documents: [document({ path: 'files/../../../etc/cron.d/evil' })] })
    ])

    // All-or-nothing, and checked here rather than per file at write time: a bundle with one bad key is
    // not partially restorable, and half a restore is worse than none.
    expect(() => mapper.listKeys(data)).toThrow(BundleError)
    expect(() => mapper.listKeys(data)).toThrow('This backup contains an unsafe file path.')
  })
})

describe('putting the extracted files back where they now live', () => {
  it('rewrites every key to the path the extraction wrote', () => {
    const restored = new DesktopBackupFileMapper().restore(
      backup([
        project({
          documents: [
            document({ path: 'files/documents/p1/0-aaa-a.pdf', name: 'a.pdf' }),
            document({ path: 'files/documents/p1/1-bbb-b.pdf', name: 'b.pdf' })
          ]
        })
      ]),
      {
        'files/documents/p1/0-aaa-a.pdf': '/restored/a.pdf',
        'files/documents/p1/1-bbb-b.pdf': '/restored/b.pdf'
      }
    )

    expect(restored.projects[0]!.documents.map(({ name, path }) => [name, path])).toEqual([
      ['a.pdf', '/restored/a.pdf'],
      ['b.pdf', '/restored/b.pdf']
    ])
  })

  it('names the file that is missing rather than restoring a project pointing at a key', () => {
    const mapper = new DesktopBackupFileMapper()

    // A truncated bundle, or one whose manifest and payload disagree. Leaving the key in place would put
    // a project in the user's library whose document silently fails to open later; naming it tells them
    // which file did not survive.
    expect(() =>
      mapper.restore(
        backup([project({ documents: [document({ path: 'files/documents/p1/0-aaa-a.pdf' })] })]),
        {}
      )
    ).toThrow('This backup is missing files/documents/p1/0-aaa-a.pdf.')
  })

  it('carries the rest of the backup through untouched', () => {
    const data = backup([project({ documents: [] })])
    const restored = new DesktopBackupFileMapper().restore(data, {})

    expect(restored).toEqual(data)
    expect(restored).not.toBe(data)
  })

  it('survives the whole round trip: extract, list, restore', () => {
    const mapper = new DesktopBackupFileMapper()
    const original = backup([
      project({
        documents: [document({ path: '/Users/someone/A.pdf' }), document({ path: '/tmp/B.pdf' })]
      })
    ])

    const { files, keyed } = mapper.extract(original)
    const keys = mapper.listKeys(keyed)
    expect(keys).toEqual(files.map(({ key }) => key))

    // What a real restore does: each key was written somewhere, and the map says where.
    const written = Object.fromEntries(files.map(({ key }, index) => [key, `/extracted/${index}`]))
    const restored = mapper.restore(keyed, written)

    expect(restored.projects[0]!.documents.map(({ path }) => path)).toEqual([
      '/extracted/0',
      '/extracted/1'
    ])
  })
})

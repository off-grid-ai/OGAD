import { describe, expect, it } from 'vitest'
import { BundleError } from '@offgrid/sync/portable'
import { validateDesktopBackupData } from '../types'
import type {
  DesktopBackupChunk,
  DesktopBackupConversation,
  DesktopBackupData,
  DesktopBackupDocument,
  DesktopBackupMessage,
  DesktopBackupProject
} from '../types'

/**
 * What the restore side accepts as Off Grid AI Desktop data, and what it refuses.
 *
 * A backup bundle can come from another version, another surface, or a hand-edited file. The
 * product contract is: a bundle either IS valid Desktop data - every project, document, chunk,
 * conversation and message of the exact shape the restore writes to SQLite - or the restore refuses
 * it with ONE user-facing BundleError, before anything is written. Each field's guard is exercised
 * with a valid, missing, wrong-type and (where numeric) boundary value so the refusal is proven by
 * the guard and not by a coincidental sibling.
 *
 * Pure module, no boundary to fake.
 */

const chunk = (overrides: Partial<DesktopBackupChunk> = {}): DesktopBackupChunk => ({
  content: 'Clause 1. The parties agree.',
  position: 0,
  ...overrides
})

const document = (overrides: Partial<DesktopBackupDocument> = {}): DesktopBackupDocument => ({
  name: 'Contract.pdf',
  path: '/Users/someone/Documents/Contract.pdf',
  size: 12_345,
  kind: 'pdf',
  enabled: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  chunks: [chunk(), chunk({ position: 1 })],
  ...overrides
})

const project = (overrides: Partial<DesktopBackupProject> = {}): DesktopBackupProject => ({
  id: 'project-1',
  name: 'Legal',
  description: 'Contracts',
  systemPrompt: 'You are a careful lawyer.',
  includeMemory: true,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-02T10:00:00.000Z',
  documents: [document()],
  ...overrides
})

const message = (overrides: Partial<DesktopBackupMessage> = {}): DesktopBackupMessage => ({
  role: 'user',
  content: 'Summarise the contract.',
  createdAt: '2026-09-02T10:00:00.000Z',
  ...overrides
})

const conversation = (
  overrides: Partial<DesktopBackupConversation> = {}
): DesktopBackupConversation => ({
  id: 'conversation-1',
  title: 'Contract review',
  projectId: 'project-1',
  createdAt: '2026-09-02T10:00:00.000Z',
  updatedAt: '2026-09-02T10:05:00.000Z',
  messages: [message(), message({ role: 'assistant', content: 'Here is a summary.' })],
  ...overrides
})

const backup = (overrides: Partial<DesktopBackupData> = {}): DesktopBackupData => ({
  surface: 'offgrid-desktop',
  projects: [project()],
  conversations: [conversation()],
  ...overrides
})

/** Drop one key so the guard sees `undefined`, not a wrong-typed value. */
const without = <T extends object>(value: T, key: keyof T): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  delete copy[key as string]
  return copy
}

const REFUSAL = 'This backup does not contain valid Off Grid AI Desktop data.'

const expectRefused = (value: unknown): void => {
  expect(() => validateDesktopBackupData(value)).toThrowError(BundleError)
  expect(() => validateDesktopBackupData(value)).toThrowError(REFUSAL)
}

describe('validateDesktopBackupData', () => {
  it('accepts a complete Desktop backup and hands the same object back', () => {
    const data = backup()
    expect(validateDesktopBackupData(data)).toBe(data)
  })

  it('accepts the optional and nullable shapes the restore writes', () => {
    const data = backup({
      projects: [project({ icon: 'scale', documents: [] })],
      conversations: [
        conversation({ title: null, projectId: null, messages: [] }),
        conversation({ id: 'conversation-2', messages: [message({ context: { any: 'thing' } })] })
      ]
    })
    expect(validateDesktopBackupData(data)).toBe(data)
  })

  it('accepts the numeric boundaries: a zero-byte document and a chunk at position 0', () => {
    const data = backup({
      projects: [project({ documents: [document({ size: 0, chunks: [chunk({ position: 0 })] })] })]
    })
    expect(validateDesktopBackupData(data)).toBe(data)
  })

  describe('the envelope', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'offgrid-desktop'],
      ['a number', 42],
      ['an array', [backup()]]
    ])('refuses %s in place of the record', (_label, value) => {
      expectRefused(value)
    })

    it('refuses another surface, a missing surface, and a wrong-typed surface', () => {
      expectRefused(backup({ surface: 'offgrid-mobile' as never }))
      expectRefused(without(backup(), 'surface'))
      expectRefused({ ...backup(), surface: 1 })
    })

    it('refuses projects that are missing or not a list', () => {
      expectRefused(without(backup(), 'projects'))
      expectRefused({ ...backup(), projects: {} })
      expectRefused({ ...backup(), projects: 'none' })
    })

    it('refuses conversations that are missing or not a list', () => {
      expectRefused(without(backup(), 'conversations'))
      expectRefused({ ...backup(), conversations: {} })
      expectRefused({ ...backup(), conversations: null })
    })

    it('accepts empty project and conversation lists', () => {
      const data = backup({ projects: [], conversations: [] })
      expect(validateDesktopBackupData(data)).toBe(data)
    })
  })

  describe('a project', () => {
    const withProject = (value: unknown): unknown => ({ ...backup(), projects: [project(), value] })

    it('refuses a non-record project', () => {
      expectRefused(withProject(null))
      expectRefused(withProject('project-2'))
      expectRefused(withProject([project()]))
    })

    it.each(['id', 'name', 'description', 'systemPrompt', 'createdAt', 'updatedAt'] as const)(
      'refuses a project whose %s is missing or not a string',
      (key) => {
        expectRefused(withProject(without(project(), key)))
        expectRefused(withProject({ ...project(), [key]: 7 }))
        expectRefused(withProject({ ...project(), [key]: null }))
      }
    )

    it('refuses an icon that is present but not a string', () => {
      expectRefused(withProject({ ...project(), icon: 3 }))
      expectRefused(withProject({ ...project(), icon: null }))
    })

    it('refuses includeMemory that is missing or not a boolean', () => {
      expectRefused(withProject(without(project(), 'includeMemory')))
      expectRefused(withProject({ ...project(), includeMemory: 'yes' }))
      expectRefused(withProject({ ...project(), includeMemory: 1 }))
    })

    it('refuses documents that are missing or not a list', () => {
      expectRefused(withProject(without(project(), 'documents')))
      expectRefused(withProject({ ...project(), documents: {} }))
    })
  })

  describe('a document', () => {
    const withDocument = (value: unknown): unknown => ({
      ...backup(),
      projects: [project({ documents: [document(), value as DesktopBackupDocument] })]
    })

    it('refuses a non-record document', () => {
      expectRefused(withDocument(undefined))
      expectRefused(withDocument('Contract.pdf'))
    })

    it.each(['name', 'path', 'kind', 'createdAt'] as const)(
      'refuses a document whose %s is missing or not a string',
      (key) => {
        expectRefused(withDocument(without(document(), key)))
        expectRefused(withDocument({ ...document(), [key]: 0 }))
      }
    )

    it('refuses a size that is missing, not a number, not finite, or negative', () => {
      expectRefused(withDocument(without(document(), 'size')))
      expectRefused(withDocument({ ...document(), size: '12345' }))
      expectRefused(withDocument({ ...document(), size: Number.NaN }))
      expectRefused(withDocument({ ...document(), size: Number.POSITIVE_INFINITY }))
      expectRefused(withDocument({ ...document(), size: -1 }))
    })

    it('accepts a fractional size, since only sign and finiteness are contractual', () => {
      const data = withDocument(document({ size: 0.5 }))
      expect(validateDesktopBackupData(data)).toBe(data)
    })

    it('refuses enabled that is missing or not a boolean', () => {
      expectRefused(withDocument(without(document(), 'enabled')))
      expectRefused(withDocument({ ...document(), enabled: 'true' }))
    })

    it('refuses chunks that are missing or not a list', () => {
      expectRefused(withDocument(without(document(), 'chunks')))
      expectRefused(withDocument({ ...document(), chunks: { 0: chunk() } }))
    })
  })

  describe('a chunk', () => {
    const withChunk = (value: unknown): unknown => ({
      ...backup(),
      projects: [project({ documents: [document({ chunks: [chunk(), value as DesktopBackupChunk] })] })]
    })

    it('refuses a non-record chunk', () => {
      expectRefused(withChunk(null))
      expectRefused(withChunk('text'))
    })

    it('refuses content that is missing or not a string', () => {
      expectRefused(withChunk(without(chunk(), 'content')))
      expectRefused(withChunk({ ...chunk(), content: ['text'] }))
    })

    it('refuses a position that is missing, non-integer, or negative', () => {
      expectRefused(withChunk(without(chunk(), 'position')))
      expectRefused(withChunk({ ...chunk(), position: '1' }))
      expectRefused(withChunk({ ...chunk(), position: 1.5 }))
      expectRefused(withChunk({ ...chunk(), position: Number.NaN }))
      expectRefused(withChunk({ ...chunk(), position: -1 }))
    })
  })

  describe('a conversation', () => {
    const withConversation = (value: unknown): unknown => ({
      ...backup(),
      conversations: [conversation(), value]
    })

    it('refuses a non-record conversation', () => {
      expectRefused(withConversation(null))
      expectRefused(withConversation(1))
    })

    it.each(['id', 'createdAt', 'updatedAt'] as const)(
      'refuses a conversation whose %s is missing or not a string',
      (key) => {
        expectRefused(withConversation(without(conversation(), key)))
        expectRefused(withConversation({ ...conversation(), [key]: null }))
        expectRefused(withConversation({ ...conversation(), [key]: 9 }))
      }
    )

    it.each(['title', 'projectId'] as const)(
      'refuses a %s that is missing or neither a string nor null',
      (key) => {
        expectRefused(withConversation(without(conversation(), key)))
        expectRefused(withConversation({ ...conversation(), [key]: 9 }))
        expectRefused(withConversation({ ...conversation(), [key]: {} }))
      }
    )

    it('refuses messages that are missing or not a list', () => {
      expectRefused(withConversation(without(conversation(), 'messages')))
      expectRefused(withConversation({ ...conversation(), messages: 'hello' }))
    })
  })

  describe('a message', () => {
    const withMessage = (value: unknown): unknown => ({
      ...backup(),
      conversations: [conversation({ messages: [message(), value as DesktopBackupMessage] })]
    })

    it('refuses a non-record message', () => {
      expectRefused(withMessage(null))
      expectRefused(withMessage('hi'))
    })

    it('refuses a role that is missing or outside user/assistant', () => {
      expectRefused(withMessage(without(message(), 'role')))
      expectRefused(withMessage({ ...message(), role: 'system' }))
      expectRefused(withMessage({ ...message(), role: 'tool' }))
      expectRefused(withMessage({ ...message(), role: 1 }))
    })

    it('accepts both roles the restore knows', () => {
      const data = withMessage(message({ role: 'assistant' }))
      expect(validateDesktopBackupData(data)).toBe(data)
    })

    it.each(['content', 'createdAt'] as const)(
      'refuses a message whose %s is missing or not a string',
      (key) => {
        expectRefused(withMessage(without(message(), key)))
        expectRefused(withMessage({ ...message(), [key]: 5 }))
      }
    )
  })
})

/**
 * Real Desktop image bytes and sidecars through the shared generated-image wire contract. The
 * temporary filesystem is real; no Off Grid module, store, or composition owner is replaced.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  describeGeneratedImageEnsuringIdentity,
  describeOwnGeneratedImage,
  noteGeneratedImageMessage,
  shareGeneratedImage
} from '../generated-image-share'
import { readGeneratedImageSidecar, writeGeneratedImageSidecar } from '../gallery-sidecar'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-generated-image-share-'))

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('Desktop generated-image share adapter', () => {
  it('projects persisted image facts through the shared wire contract and keeps one identity', () => {
    const imagePath = path.join(root, 'result.png')
    fs.writeFileSync(imagePath, Buffer.from('image-bytes'))
    writeGeneratedImageSidecar(imagePath, {
      syncId: '11111111-1111-4111-8111-111111111111',
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createdAt: '2026-09-05T12:00:00.000Z',
      width: 1024,
      height: 768,
      metadataJson: JSON.stringify({ prompt: 'A private forest', steps: 8, model: 'legacy-model' })
    })

    expect(
      describeOwnGeneratedImage(imagePath, {
        conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      })
    ).toMatchObject({
      syncId: '11111111-1111-4111-8111-111111111111',
      kind: 'generated_media',
      name: 'result.png',
      mimeType: 'image/png',
      fileSize: 11,
      createdAt: '2026-09-05T12:00:00.000Z',
      conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      width: 1024,
      height: 768,
      metadataJson: JSON.stringify({
        modelId: 'legacy-model',
        prompt: 'A private forest',
        steps: 8
      })
    })

    const legacyPath = path.join(root, 'legacy.png')
    fs.writeFileSync(legacyPath, Buffer.from('legacy'))
    writeGeneratedImageSidecar(legacyPath, {
      conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })
    const first = describeGeneratedImageEnsuringIdentity(legacyPath)
    const second = describeGeneratedImageEnsuringIdentity(legacyPath)
    expect(first?.syncId).toMatch(/^[0-9a-f-]{36}$/)
    expect(second?.syncId).toBe(first?.syncId)
    expect(readGeneratedImageSidecar(legacyPath)).toMatchObject({
      syncId: first?.syncId,
      conversationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    })
  })

  it('reports undescribable files and preserves an already-linked message without re-emitting', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const missingPath = path.join(root, 'missing.png')
    expect(shareGeneratedImage(missingPath)).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not-describable'))

    writeGeneratedImageSidecar(missingPath, { syncId: '22222222-2222-4222-8222-222222222222' })
    expect(shareGeneratedImage(missingPath)).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('describe-threw'))

    const linkedPath = path.join(root, 'linked.png')
    fs.writeFileSync(linkedPath, Buffer.from('linked'))
    writeGeneratedImageSidecar(linkedPath, {
      syncId: '33333333-3333-4333-8333-333333333333',
      conversationId: '44444444-4444-4444-8444-444444444444',
      messageId: '55555555-5555-4555-8555-555555555555'
    })
    expect(
      noteGeneratedImageMessage({
        imagePath: linkedPath,
        conversationId: '44444444-4444-4444-8444-444444444444',
        messageId: '55555555-5555-4555-8555-555555555555'
      })
    ).toBe(true)
    expect(readGeneratedImageSidecar(linkedPath)).toMatchObject({
      syncId: '33333333-3333-4333-8333-333333333333',
      conversationId: '44444444-4444-4444-8444-444444444444',
      messageId: '55555555-5555-4555-8555-555555555555'
    })
    error.mockRestore()
  })
})

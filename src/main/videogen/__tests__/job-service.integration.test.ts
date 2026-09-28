import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoGenerationOutputContract, VideoGenerationUpdateContract } from '../../../shared/video-generation-contract'
const ports = vi.hoisted(() => ({ generate: vi.fn(), cancel: vi.fn(), share: vi.fn() }))
vi.mock('../../videogen', () => ({ generateVideo: ports.generate, cancelVideoGen: ports.cancel }))
vi.mock('../../sync-shared-file', () => ({ emitSharedFileMutation: ports.share }))
import { VideoGenerationJobService } from '../job-service'
import { readGeneratedVideoSidecar } from '../gallery-sidecar'
import { readGeneratedVideoMetadata } from '@offgrid/sync'
let root: string
let finish: (output: VideoGenerationOutputContract) => void
let fail: (error: Error) => void
let update: (value: VideoGenerationUpdateContract) => void
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-video-job-'))
  ports.generate.mockReset().mockImplementation((_request, onUpdate) => {
    update = onUpdate
    return new Promise<VideoGenerationOutputContract>((resolve, reject) => { finish = resolve; fail = reject })
  })
  ports.cancel.mockReset().mockImplementation(() => { fail(new Error('Video generation stopped.')); return true })
  ports.share.mockReset()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function output(): VideoGenerationOutputContract {
  const file = path.join(root, 'clip.mp4')
  fs.writeFileSync(file, 'fixture')
  return { path: file, prompt: 'A moving lake', negativePrompt: 'blur', model: 'wan', width: 320, height: 192, frames: 17, fps: 8, steps: 20, guidance: 6, seed: 42, durationSeconds: 17 / 8 }
}
describe('video job ownership and persistence', () => {
  it('survives observer detachment and links the completed file to its own chat', async () => {
    const jobs = new VideoGenerationJobService()
    const observer = vi.fn()
    const off = jobs.onChange(observer)
    const pending = jobs.start({ prompt: 'lake', conversationId: '11111111-1111-4111-8111-111111111111', projectId: 'project-a' })
    await expect(jobs.start({ prompt: 'second' })).rejects.toThrow('already generating')
    update({ stage: 'generating', progress: { step: 2, total: 20 } })
    off()
    const result = output()
    finish(result)
    const saved = await pending
    expect(jobs.status()).toMatchObject({ phase: 'succeeded', conversationId: '11111111-1111-4111-8111-111111111111', outputPath: result.path })
    expect(observer.mock.calls.at(-1)![0].phase).toBe('running')
    expect(readGeneratedVideoMetadata(readGeneratedVideoSidecar(result.path).metadataJson)).toMatchObject({ negativePrompt: 'blur', seed: 42, fps: 8 })
    expect(jobs.acknowledgeConversation('chat-b', 'message-b')).toBe(false)
    const changed = vi.fn()
    jobs.onConversationUpdated(changed)
    expect(jobs.acknowledgeConversation('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')).toBe(true)
    expect(readGeneratedVideoSidecar(result.path)).toMatchObject({ syncId: saved.syncId, messageId: '22222222-2222-4222-8222-222222222222', projectId: 'project-a' })
    expect(ports.share.mock.calls.at(-1)![0].file).toMatchObject({ kind: 'generated_media', mimeType: 'video/mp4', conversationId: '11111111-1111-4111-8111-111111111111', messageId: '22222222-2222-4222-8222-222222222222' })
    expect(changed).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111')
  })
  it('records cancellation and allows a later job', async () => {
    const jobs = new VideoGenerationJobService()
    const pending = jobs.start({ prompt: 'lake' })
    const rejected = expect(pending).rejects.toThrow('stopped')
    expect(jobs.cancel()).toBe(true)
    await rejected
    expect(jobs.status().phase).toBe('cancelled')
    expect(jobs.cancel()).toBe(false)
    const next = jobs.start({ prompt: 'retry' })
    finish(output())
    await expect(next).resolves.toMatchObject({ prompt: 'A moving lake' })
  })
  it('records a runtime failure without publishing a file', async () => {
    const jobs = new VideoGenerationJobService()
    const pending = jobs.start({ prompt: 'lake' })
    fail(new Error('Out of memory'))
    await expect(pending).rejects.toThrow('Out of memory')
    expect(jobs.status()).toMatchObject({ phase: 'failed', error: 'Out of memory', outputPath: null })
    expect(ports.share).not.toHaveBeenCalled()
  })
})

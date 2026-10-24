import { randomUUID } from 'node:crypto'
import {
  endedVideoJob,
  idleVideoJob,
  startedVideoJob,
  succeededVideoJob,
  updatedVideoJob
} from '@offgrid/models'
import { generatedVideoMetadataJson } from '@offgrid/sync'
import type { ChatHome } from '@offgrid/sync'
import type {
  VideoGenerationJobContract,
  VideoGenerationRequestContract,
  VideoGenerationResultContract,
  VideoGenerationUpdateContract
} from '../../shared/video-generation-contract'
import { cancelVideoGen, generateVideo } from '../videogen'
import { writeGeneratedVideoSidecar } from './gallery-sidecar'
import { noteGeneratedVideoMessage, shareGeneratedVideo } from './generated-video-share'

export type VideoJobRequest = VideoGenerationRequestContract & {
  localOnly?: boolean
  conversationId?: string
  messageId?: string
  projectId?: string | null
}

type JobListener = (snapshot: VideoGenerationJobContract) => void
type ConversationListener = (conversationId: string) => void

export class VideoGenerationJobService {
  private snapshot: VideoGenerationJobContract = idleVideoJob()
  private active = false
  private messageId: string | null = null
  private listeners = new Set<JobListener>()
  private conversationListeners = new Set<ConversationListener>()

  status(): VideoGenerationJobContract {
    return { ...this.snapshot, progress: this.snapshot.progress && { ...this.snapshot.progress } }
  }

  onChange(listener: JobListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onConversationUpdated(listener: ConversationListener): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }

  assertCanStart(): void {
    if (this.active) throw new Error('A video is already generating.')
  }

  async start(request: VideoJobRequest): Promise<VideoGenerationResultContract> {
    this.assertCanStart()
    this.active = true
    this.messageId = request.messageId ?? null
    const id = randomUUID()
    this.snapshot = startedVideoJob(id, request, Date.now())
    this.publish()
    try {
      const output = await generateVideo(request, (update) => this.update(id, update), {
        localOnly: request.localOnly
      })
      const durationMs = Date.now() - (this.snapshot.startedAt ?? Date.now())
      writeGeneratedVideoSidecar(output.path, {
        syncId: id,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
        ...(this.messageId ? { messageId: this.messageId } : {}),
        createdAt: new Date().toISOString(),
        width: output.width,
        height: output.height,
        durationSeconds: output.durationSeconds,
        metadataJson: generatedVideoMetadataJson({
          prompt: output.prompt,
          negativePrompt: output.negativePrompt,
          steps: output.steps,
          guidance: output.guidance,
          seed: output.seed,
          modelId: output.model,
          fps: output.fps,
          frames: output.frames
        })
      })
      // The MP4 and its metadata are committed locally. Optional replication
      // must not hide a completed clip when it exceeds the transfer limit.
      shareGeneratedVideo(output.path)
      this.snapshot = succeededVideoJob(this.snapshot, output.path, Date.now())
      this.publish()
      return { ...output, syncId: id, durationMs }
    } catch (error) {
      this.snapshot = endedVideoJob(this.snapshot, error, Date.now())
      this.publish()
      throw error
    } finally {
      this.active = false
    }
  }

  cancel(): boolean {
    if (!this.active) return false
    return cancelVideoGen()
  }

  acknowledgeConversation(conversationId: string, messageId?: string): boolean {
    if (conversationId !== this.snapshot.conversationId || !this.snapshot.outputPath) return false
    const resolvedMessageId = messageId ?? this.messageId
    if (!resolvedMessageId) return false
    const home: ChatHome = { conversationId, messageId: resolvedMessageId }
    const linked = noteGeneratedVideoMessage({ ...home, videoPath: this.snapshot.outputPath })
    if (linked) this.conversationListeners.forEach((listener) => listener(conversationId))
    return linked
  }

  private update(id: string, update: VideoGenerationUpdateContract): void {
    const next = updatedVideoJob(this.snapshot, id, update)
    if (next === this.snapshot) return
    this.snapshot = next
    this.publish()
  }

  private publish(): void {
    const snapshot = this.status()
    this.listeners.forEach((listener) => {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('[video-job] Status listener failed', error)
      }
    })
  }
}

export const videoGenerationJobs = new VideoGenerationJobService()

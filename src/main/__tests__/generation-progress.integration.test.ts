import { describe, expect, it } from 'vitest'
import type { DownloadProgress } from '@offgrid/executorch-speech'
import type { ImageGenerationPipelineUpdateContract } from '../../shared/image-generation-contract'
import {
  registerDesktopImageProgress,
  registerDesktopVoiceProgress,
  reportDesktopImageProgress,
  reportDesktopVoiceProgress
} from '../generation-progress'

describe('Desktop generation progress composition', () => {
  it('keeps replacement image observers active until their own release', () => {
    const firstUpdates: ImageGenerationPipelineUpdateContract[] = []
    const activeUpdates: ImageGenerationPipelineUpdateContract[] = []
    const releaseFirst = registerDesktopImageProgress('image-turn', (update) => {
      firstUpdates.push(update)
    })
    const releaseActive = registerDesktopImageProgress('image-turn', (update) => {
      activeUpdates.push(update)
    })
    const update: ImageGenerationPipelineUpdateContract = {
      stage: 'generating',
      progress: { step: 4, total: 20, secPerStep: 1.5 }
    }

    releaseFirst()
    reportDesktopImageProgress('image-turn', update)
    releaseActive()
    reportDesktopImageProgress('image-turn', { stage: 'decoding' })

    expect(firstUpdates).toEqual([])
    expect(activeUpdates).toEqual([update])
  })

  it('delivers voice progress only while its observer owns the turn', () => {
    const replaced: DownloadProgress[] = []
    const received: DownloadProgress[] = []
    const releaseReplaced = registerDesktopVoiceProgress('voice-turn', (progress) => {
      replaced.push(progress)
    })
    const release = registerDesktopVoiceProgress('voice-turn', (progress) => {
      received.push(progress)
    })
    const progress: DownloadProgress = {
      voiceId: 'af_heart',
      downloadedBytes: 512,
      totalBytes: 1024,
      percentage: 50,
      currentAsset: 'voice.bin'
    }

    releaseReplaced()
    reportDesktopVoiceProgress('voice-turn', progress)
    release()
    reportDesktopVoiceProgress('voice-turn', { ...progress, percentage: 100 })

    expect(replaced).toEqual([])
    expect(received).toEqual([progress])
  })
})

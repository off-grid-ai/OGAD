import { describe, expect, it } from 'vitest'
import { buildGatewayModalities } from '../health'

describe('buildGatewayModalities', () => {
  it('reports unavailable runtimes as not installed', () => {
    expect(
      buildGatewayModalities({
        chat: false,
        vision: false,
        embeddings: true,
        transcription: false,
        speech: false,
        image: false
      })
    ).toEqual({
      text: 'not_installed',
      vision_understanding: 'not_installed',
      embeddings: 'ready',
      transcription: 'not_installed',
      speech: 'not_installed',
      image_generation: 'not_installed',
      image_edit: 'not_installed',
      video_generation: 'not_installed'
    })
  })

  it('reports every runtime from its own capability fact', () => {
    expect(
      buildGatewayModalities({
        chat: true,
        vision: false,
        embeddings: false,
        transcription: true,
        speech: true,
        image: true,
        video: true
      })
    ).toEqual({
      text: 'ready',
      vision_understanding: 'not_installed',
      embeddings: 'not_installed',
      transcription: 'ready',
      speech: 'ready',
      image_generation: 'ready',
      image_edit: 'ready',
      video_generation: 'ready'
    })
  })
})

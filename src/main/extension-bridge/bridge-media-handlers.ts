import type {
  AudioSpeakResponse,
  AudioTranscribeResponse,
  AudioVoicesResponse,
  ModelsActivateResponse,
  ModelsInventoryResponse
} from './bridge-media-protocol'
import { readModelInventory, activateBridgeModel } from './bridge-models'
import { readAudioVoices, speakBridgeAudio, transcribeBridgeAudio } from './bridge-audio'

export interface BridgeMediaData {
  modelInventory(): Promise<ModelsInventoryResponse>
  activateModel(params: Record<string, unknown>): Promise<ModelsActivateResponse>
  audioVoices(): Promise<AudioVoicesResponse>
  transcribeAudio(params: Record<string, unknown>): Promise<AudioTranscribeResponse>
  speakAudio(params: Record<string, unknown>): Promise<AudioSpeakResponse>
}

export const bridgeMediaData: BridgeMediaData = {
  modelInventory: readModelInventory,
  activateModel: activateBridgeModel,
  audioVoices: readAudioVoices,
  transcribeAudio: transcribeBridgeAudio,
  speakAudio: speakBridgeAudio
}

export function mediaHandlers(
  data: Partial<BridgeMediaData>
): Record<
  'models.inventory' | 'models.activate' | 'audio.voices' | 'audio.transcribe' | 'audio.speak',
  (params: Record<string, unknown>) => Promise<unknown>
> {
  const empty = (params: Record<string, unknown>): void => {
    if (Object.keys(params).length) {
      throw new Error('invalid')
    }
  }
  return {
    'models.inventory': async (p) => {
      empty(p)
      if (!data.modelInventory) {
        throw new Error('models_unavailable')
      }
      return data.modelInventory()
    },
    'models.activate': async (p) => {
      if (!data.activateModel) {
        throw new Error('models_unavailable')
      }
      return data.activateModel(p)
    },
    'audio.voices': async (p) => {
      empty(p)
      if (!data.audioVoices) {
        throw new Error('audio_unavailable')
      }
      return data.audioVoices()
    },
    'audio.transcribe': async (p) => {
      if (!data.transcribeAudio) {
        throw new Error('audio_unavailable')
      }
      return data.transcribeAudio(p)
    },
    'audio.speak': async (p) => {
      if (!data.speakAudio) {
        throw new Error('audio_unavailable')
      }
      return data.speakAudio(p)
    }
  }
}

import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { SpeechLanguage } from '@offgrid/application'
import { modelControlClient } from '@renderer/lib/model-control-client'
import { resolveModelName } from '@renderer/lib/model-summary'
import type { LlmSettings } from './settings-model-budget'

export interface TranscriptionInfo {
  engine: 'whisper' | 'parakeet' | 'whisper-resident'
  modelId: string | null
  label: string
  language: string
  languages: SpeechLanguage[]
  options: { id: string | null; name: string; active: boolean }[]
}

interface SettingsLoadTargets {
  setSettings: Dispatch<SetStateAction<LlmSettings>>
  setTranscriptionInfo: Dispatch<SetStateAction<TranscriptionInfo | null>>
  setTools: Dispatch<SetStateAction<{ name: string; description: string; enabled?: boolean }[]>>
  setActiveModelName: Dispatch<SetStateAction<string | null>>
  setShowGenerationDetails: Dispatch<SetStateAction<boolean>>
  refreshConnectors: () => void
}

export function useInitialSettings(targets: SettingsLoadTargets): void {
  const {
    setSettings,
    setTranscriptionInfo,
    setTools,
    setActiveModelName,
    setShowGenerationDetails,
    refreshConnectors
  } = targets
  useEffect(() => {
    window.api
      .getLlmSettings()
      .then((value: LlmSettings) => setSettings(value))
      .catch(() => {})
    void modelControlClient
      .projection()
      .then((projection) =>
        setActiveModelName(resolveModelName(projection.models, projection.active.text.modelId))
      )
      .catch(() => setActiveModelName(null))
    window.api
      .getTranscriptionInfo()
      .then((info: TranscriptionInfo) => setTranscriptionInfo(info))
      .catch(() => setTranscriptionInfo(null))
    window.api
      .getSettings()
      .then((settings) => setShowGenerationDetails(settings.showGenerationDetails === true))
      .catch(() => {})
    window.api
      .listTools()
      .then((nextTools: { name: string; description: string }[]) => setTools(nextTools))
      .catch(() => {})
    refreshConnectors()
  }, [
    refreshConnectors,
    setActiveModelName,
    setSettings,
    setShowGenerationDetails,
    setTools,
    setTranscriptionInfo
  ])
}

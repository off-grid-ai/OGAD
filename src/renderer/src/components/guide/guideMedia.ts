// The picture or clip for each guide topic. Stills come from the website's feature shots
// (headline cropped off) in a dark and a light take; Scribe and Notes are short clips.
import actionsDark from '@renderer/assets/guide/actions-dark.webp'
import actionsLight from '@renderer/assets/guide/actions-light.webp'
import chatDark from '@renderer/assets/guide/chat-dark.webp'
import chatLight from '@renderer/assets/guide/chat-light.webp'
import clipboardDark from '@renderer/assets/guide/clipboard-dark.webp'
import clipboardLight from '@renderer/assets/guide/clipboard-light.webp'
import connectorsDark from '@renderer/assets/guide/connectors-dark.webp'
import connectorsLight from '@renderer/assets/guide/connectors-light.webp'
import dayDark from '@renderer/assets/guide/day-dark.webp'
import dayLight from '@renderer/assets/guide/day-light.webp'
import devicesDark from '@renderer/assets/guide/devices-dark.webp'
import devicesLight from '@renderer/assets/guide/devices-light.webp'
import entitiesDark from '@renderer/assets/guide/entities-dark.webp'
import entitiesLight from '@renderer/assets/guide/entities-light.webp'
import exploreDark from '@renderer/assets/guide/explore-dark.webp'
import exploreLight from '@renderer/assets/guide/explore-light.webp'
import extensionDark from '@renderer/assets/guide/extension-dark.webp'
import extensionLight from '@renderer/assets/guide/extension-light.webp'
import extensionVaultDark from '@renderer/assets/guide/extension-vault-dark.webp'
import extensionVaultLight from '@renderer/assets/guide/extension-vault-light.webp'
import imagesDark from '@renderer/assets/guide/images-dark.webp'
import imagesLight from '@renderer/assets/guide/images-light.webp'
import meetingsDark from '@renderer/assets/guide/meetings-dark.webp'
import meetingsLight from '@renderer/assets/guide/meetings-light.webp'
import modelsDark from '@renderer/assets/guide/models-dark.webp'
import modelsLight from '@renderer/assets/guide/models-light.webp'
import notesClip from '@renderer/assets/guide/notes.mp4'
import phoneDark from '@renderer/assets/guide/phone-dark.webp'
import phoneLight from '@renderer/assets/guide/phone-light.webp'
import phoneVideoDark from '@renderer/assets/guide/phone-video-dark.webp'
import phoneVideoLight from '@renderer/assets/guide/phone-video-light.webp'
import phoneVoiceDark from '@renderer/assets/guide/phone-voice-dark.webp'
import phoneVoiceLight from '@renderer/assets/guide/phone-voice-light.webp'
import projectsDark from '@renderer/assets/guide/projects-dark.webp'
import projectsLight from '@renderer/assets/guide/projects-light.webp'
import reflectDark from '@renderer/assets/guide/reflect-dark.webp'
import reflectLight from '@renderer/assets/guide/reflect-light.webp'
import replayDark from '@renderer/assets/guide/replay-dark.webp'
import replayLight from '@renderer/assets/guide/replay-light.webp'
import scribeClip from '@renderer/assets/guide/scribe.mp4'
import searchDark from '@renderer/assets/guide/search-dark.webp'
import searchLight from '@renderer/assets/guide/search-light.webp'
import tasksDark from '@renderer/assets/guide/tasks-dark.webp'
import tasksLight from '@renderer/assets/guide/tasks-light.webp'
import vaultDark from '@renderer/assets/guide/vault-dark.webp'
import vaultLight from '@renderer/assets/guide/vault-light.webp'
import videoDark from '@renderer/assets/guide/video-dark.webp'
import videoLight from '@renderer/assets/guide/video-light.webp'
import voiceDark from '@renderer/assets/guide/voice-dark.webp'
import voiceLight from '@renderer/assets/guide/voice-light.webp'

export type GuideMedia =
  { kind: 'still'; dark: string; light: string; tall?: boolean } | { kind: 'clip'; src: string }

const still = (dark: string, light: string, tall = false): GuideMedia => ({
  kind: 'still',
  dark,
  light,
  tall
})

export const GUIDE_MEDIA: Record<string, GuideMedia> = {
  actions: still(actionsDark, actionsLight),
  chat: still(chatDark, chatLight),
  clipboard: still(clipboardDark, clipboardLight),
  connectors: still(connectorsDark, connectorsLight),
  day: still(dayDark, dayLight),
  devices: still(devicesDark, devicesLight),
  entities: still(entitiesDark, entitiesLight),
  explore: still(exploreDark, exploreLight),
  extension: still(extensionDark, extensionLight),
  'extension-vault': still(extensionVaultDark, extensionVaultLight),
  images: still(imagesDark, imagesLight),
  meetings: still(meetingsDark, meetingsLight),
  models: still(modelsDark, modelsLight),
  notes: { kind: 'clip', src: notesClip },
  phone: still(phoneDark, phoneLight, true),
  'phone-video': still(phoneVideoDark, phoneVideoLight, true),
  'phone-voice': still(phoneVoiceDark, phoneVoiceLight, true),
  projects: still(projectsDark, projectsLight),
  reflect: still(reflectDark, reflectLight),
  replay: still(replayDark, replayLight),
  scribe: { kind: 'clip', src: scribeClip },
  search: still(searchDark, searchLight),
  tasks: still(tasksDark, tasksLight),
  vault: still(vaultDark, vaultLight),
  video: still(videoDark, videoLight),
  voice: still(voiceDark, voiceLight)
}

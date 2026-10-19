// Team gateway mode's transcription lanes: resident whisper-servers, each with its model loaded,
// instead of a whisper-cli process per request (each loads the model again, ~3 s). Lane 0 is the
// app's own resident server; more lanes start on free ports as concurrent requests need them, up
// to the count the RAM rule allows (mediaWorkerCount in @offgrid/models). Each lane stops itself
// after five idle minutes, as the resident server always has.

import { mayStartMediaWorker } from '@offgrid/models'
import { isPortFree, pickFreePort } from '../free-port'
import { measuredAvailableMB } from '../runtime-manager'
import { filesMB } from '../model-footprint'
import { WhisperServerService, whisperServer } from './whisper-server'
import { WhisperServerTranscription } from './whisper-server-transcription'
import { whisperModel } from './whisper-cli'
import { getTeamLaneTranscription, registerExtraTranscriptionLanes } from './select'
import type { Transcript, TranscribeOptions } from './types'

/** Where extra lanes look for a free port (past the fixed engine ports). */
const LANE_PORT_START = 18441

interface Lane {
  server: WhisperServerService
  service: WhisperServerTranscription
  inFlight: number
}

const lanes: Lane[] = [
  { server: whisperServer, service: new WhisperServerTranscription(whisperServer), inFlight: 0 }
]
let adding: Promise<Lane> | null = null

async function addLane(): Promise<Lane> {
  const port = await pickFreePort(LANE_PORT_START + lanes.length, (p) => isPortFree(p))
  if (port === null) throw new Error('No free port for another transcription lane.')
  const server = new WhisperServerService(port)
  const lane = { server, service: new WhisperServerTranscription(server), inFlight: 0 }
  lanes.push(lane)
  return lane
}

/** What one more lane would hold: the model it loads and a small decode allowance, in MB. */
function laneMB(): number {
  return whisperServer.residentMB() || filesMB([whisperModel()]) + 200
}

/** The least busy lane, opening another while every lane is busy, `wanted` allows and live memory
 *  holds one more model copy; otherwise the request shares the least busy lane. */
async function pickLane(wanted: number): Promise<Lane> {
  const idle = lanes.reduce(
    (best, lane) => (lane.inFlight < best.inFlight ? lane : best),
    lanes[0]!
  )
  if (idle.inFlight === 0 || lanes.length >= wanted) return idle
  if (!adding && !mayStartMediaWorker(measuredAvailableMB(), laneMB())) return idle
  adding ??= addLane().finally(() => {
    adding = null
  })
  return adding
}

/**
 * Transcribe on a resident lane, or null when lanes do not apply (the active engine is not Whisper,
 * a remote server is chosen, or whisper-server is not installed): the caller then uses today's
 * path. `wanted`: how many lanes may run at once.
 */
export async function transcribeOnTeamLane(
  input: { path: string },
  opts: TranscribeOptions,
  wanted: number
): Promise<Transcript | null> {
  if (!getTeamLaneTranscription(lanes[0]!.service)) return null
  const lane = await pickLane(wanted)
  const service = getTeamLaneTranscription(lane.service)
  if (!service) return null
  lane.inFlight += 1
  try {
    return await service.transcribe(input, opts)
  } finally {
    lane.inFlight -= 1
  }
}

/** Stop the extra lanes (the app's own resident server keeps its own lifecycle). */
export function stopTeamLanes(): void {
  for (const lane of lanes.splice(1)) lane.server.stop()
}

// The memory planner counts the extra lanes with the resident server and frees them with it. Each
// lane also stops itself after five idle minutes, as the resident server does.
registerExtraTranscriptionLanes({
  residentMB: () => lanes.slice(1).reduce((sum, lane) => sum + lane.server.residentMB(), 0),
  stop: stopTeamLanes
})

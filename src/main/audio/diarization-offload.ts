/**
 * Speaker diarization + voiceprints for the gateway's /v1/audio/diarize and /v1/audio/embed routes.
 *
 * Now Python-free: this delegates to the in-process native runtime (sherpa-onnx-node) in
 * ./diarization-native. Kept as a thin re-export so the model-server import site is stable and any
 * older callers keep working.
 */
export type { DiarizedTurn } from './diarization-native'
export { diarizeRecording, embedClip, diarizationStatus } from './diarization-native'

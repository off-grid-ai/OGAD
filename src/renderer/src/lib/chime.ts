// The app's ding: two soft rising notes, made with Web Audio so there is no sound file to ship.
// One sound for "I heard you" (Ares hears its name, a voice turn starts) and "here is the reply"
// (an answer or a reaction arrives, in Chat and God). Short and quiet, so a mic that opens next
// does not take it for speech.

/** The two notes (Hz) and how long each rings (s). */
const NOTES = [880, 1318.5] as const
const NOTE_S = 0.12
const GAP_S = 0.07
const VOLUME = 0.18

let context: AudioContext | null = null

/** Play the ding. Never throws: a ding that cannot play is not worth an error. */
export function playChime(): void {
  try {
    context ??= new AudioContext()
    const ctx = context
    void ctx.resume()
    const start = ctx.currentTime + 0.01
    NOTES.forEach((frequency, i) => {
      const at = start + i * (NOTE_S + GAP_S) * 0.6
      const tone = ctx.createOscillator()
      const level = ctx.createGain()
      tone.type = 'sine'
      tone.frequency.value = frequency
      // A quick rise and a soft tail, so it rings like a bell instead of clicking.
      level.gain.setValueAtTime(0, at)
      level.gain.linearRampToValueAtTime(VOLUME, at + 0.012)
      level.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_S + 0.18)
      tone.connect(level).connect(ctx.destination)
      tone.start(at)
      tone.stop(at + NOTE_S + 0.2)
    })
  } catch {
    // No audio output (or a test environment without Web Audio): stay silent.
  }
}

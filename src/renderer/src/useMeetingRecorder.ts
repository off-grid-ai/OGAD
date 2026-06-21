import { useRef, useState, useCallback } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api;

export interface MeetingRecorder {
  recording: boolean;
  busy: boolean; // transcribing after stop
  elapsed: number;
  error: string;
  start: (platform?: string) => Promise<void>;
  stop: () => void;
}

/**
 * Meeting recorder. The actual capture runs in the MAIN process via a native
 * Swift binary (ScreenCaptureKit + AVFoundation): screen video + SYSTEM AUDIO
 * (the remote participants, captured before the audio hits any output device, so
 * it works on speakers / wired / Bluetooth alike) + microphone. This hook just
 * starts/stops it and tracks UI state. Lives once at the app root so a detected
 * meeting can auto-start it and a floating indicator can show recording state.
 */
export function useMeetingRecorder(): MeetingRecorder {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = useCallback((): void => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const start = useCallback(async (platform?: string): Promise<void> => {
    if (recording) return;
    setError('');
    try {
      const res = await api.meetingStart?.(platform);
      if (res?.error) { setError(res.error); return; }
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording');
    }
  }, [recording]);

  const stop = useCallback((): void => {
    if (!recording) return;
    stopTimer();
    setRecording(false);
    setBusy(true);
    // Main finalizes the files, muxes far-side + mic, transcribes, and stores.
    void (async () => {
      try {
        const res = await api.meetingStop?.();
        if (res?.error) setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save recording');
      } finally {
        setBusy(false);
      }
    })();
  }, [recording, stopTimer]);

  return { recording, busy, elapsed, error, start, stop };
}

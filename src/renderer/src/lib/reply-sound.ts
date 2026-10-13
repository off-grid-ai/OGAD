// Whether the ding plays when a reply arrives. One saved setting, shown in Chat's settings and in
// God's: every toggle reads and writes it through useReplySound, and each hears the others' changes.

import { useCallback, useEffect, useState } from 'react'

export const REPLY_SOUND_SETTING = 'replySound'
const CHANGED = 'offgrid:reply-sound-changed'

/** On unless turned off. */
export function readReplySound(settings: Record<string, unknown>): boolean {
  return settings[REPLY_SOUND_SETTING] !== false
}

/** The saved choice, kept current wherever it changes, and the way to change it. */
export function useReplySound(): readonly [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true)
  useEffect(() => {
    let live = true
    void window.api
      .getSettings()
      .then((s) => {
        if (live) setOn(readReplySound(s as Record<string, unknown>))
      })
      .catch(() => undefined)
    const heard = (event: Event): void => setOn((event as CustomEvent<boolean>).detail)
    window.addEventListener(CHANGED, heard)
    return () => {
      live = false
      window.removeEventListener(CHANGED, heard)
    }
  }, [])
  const change = useCallback((next: boolean): void => {
    setOn(next)
    void Promise.resolve(window.api.saveSetting(REPLY_SOUND_SETTING, next))
      .then(() => window.dispatchEvent(new CustomEvent<boolean>(CHANGED, { detail: next })))
      .catch(() => setOn(!next))
  }, [])
  return [on, change] as const
}

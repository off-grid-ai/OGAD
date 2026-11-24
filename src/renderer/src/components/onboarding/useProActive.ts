import { useEffect, useState } from 'react'
import { useRendererEntitlement } from '@renderer/bootstrap/useRendererEntitlement'

/**
 * Whether Pro is active, kept current while onboarding is open. Onboarding renders before the
 * app's entitlement provider, so a key entered here would otherwise not show until a restart.
 */
export function useProActive(): boolean {
  const { isPro } = useRendererEntitlement()
  const [active, setActive] = useState(isPro)
  useEffect(() => {
    const license = window.api.license
    if (!license || typeof license.onChanged !== 'function') return
    let live = true
    const off = license.onChanged((info) => live && setActive(info.isPro))
    return () => {
      live = false
      off()
    }
  }, [])
  return active
}

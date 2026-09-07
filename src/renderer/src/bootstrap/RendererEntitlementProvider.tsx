import { useCallback, useMemo, useState, type ReactNode } from 'react'
import {
  getPreloadRendererIsPro,
  initializeRendererEntitlement,
  RendererEntitlementContext,
  setRendererIsPro
} from './entitlementRegistry'

export function RendererEntitlementProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const [isPro, setIsProState] = useState(() =>
    initializeRendererEntitlement(getPreloadRendererIsPro())
  )

  const setIsPro = useCallback((next: boolean): void => {
    setRendererIsPro(next)
    setIsProState(next)
  }, [])

  const value = useMemo(() => ({ isPro, setIsPro }), [isPro, setIsPro])
  return (
    <RendererEntitlementContext.Provider value={value}>
      {children}
    </RendererEntitlementContext.Provider>
  )
}

import { useEffect, useState } from 'react'
import { ANALYTICS_CONSENT_OFF, type AnalyticsConsent } from '../../../../shared/analytics'
import { analyticsBridge } from '@renderer/lib/analytics'

/** The device's analytics consent: read before the first paint, then kept current by main. */
export function useAnalyticsConsent(): [AnalyticsConsent, (next: AnalyticsConsent) => void] {
  const [consent, setConsent] = useState<AnalyticsConsent>(
    () => analyticsBridge()?.consent ?? ANALYTICS_CONSENT_OFF
  )
  useEffect(() => analyticsBridge()?.onConsentChanged?.(setConsent), [])
  return [consent, setConsent]
}

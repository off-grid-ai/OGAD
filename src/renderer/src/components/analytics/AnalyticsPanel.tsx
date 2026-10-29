import { useState } from 'react'
import { Bug, ListChecks } from '@phosphor-icons/react'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { SettingRow } from '@offgrid/operator-ui/operator/presence'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { Button } from '../ui/button'
import { useAnalyticsConsent } from './use-analytics-consent'
import { WhatWeShareDialog } from './WhatWeShareDialog'
import { ReportProblemDialog } from './ReportProblemDialog'

/**
 * Settings > Analytics: the two consent toggles for this computer, what each one shares, and
 * "Report a problem". Both toggles are off until you turn them on, and turning both off resets
 * the anonymous ID.
 */
export function AnalyticsPanel(): React.ReactElement {
  const [consent, setConsent] = useAnalyticsConsent()
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [reporting, setReporting] = useState(false)

  const change = async (patch: { usage?: boolean; crashes?: boolean }): Promise<void> => {
    const previous = consent
    setConsent({ ...consent, ...patch })
    setBusy(true)
    try {
      setConsent(await window.api.analytics.setConsent(patch))
    } catch {
      setConsent(previous)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section label="On this computer" className="font-mono">
      <div className="grid gap-x-6 sm:grid-cols-2">
        <SettingRow
          title="Usage data"
          description="Which screens and features you use, and how models perform. Helps us fix what is slow."
          className="pt-0"
        >
          <Switch
            aria-label="Usage data"
            checked={consent.usage}
            disabled={busy}
            onCheckedChange={(checked) => void change({ usage: checked === true })}
          />
        </SettingRow>
        <SettingRow
          title="Crash reports"
          description="What broke and where in the app, with file names and line numbers only."
          className="pt-0"
        >
          <Switch
            aria-label="Crash reports"
            checked={consent.crashes}
            disabled={busy}
            onCheckedChange={(checked) => void change({ crashes: checked === true })}
          />
        </SettingRow>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
          <ListChecks className="h-3.5 w-3.5" />
          What we share
        </Button>
        <Button size="sm" variant="outline" onClick={() => setReporting(true)}>
          <Bug className="h-3.5 w-3.5" />
          Report a problem
        </Button>
        <span className="text-meta text-muted-foreground">
          Your chats and files never leave your computer.
        </span>
      </div>
      <WhatWeShareDialog open={sharing} onOpenChange={setSharing} />
      {reporting ? <ReportProblemDialog open onOpenChange={setReporting} /> : null}
    </Section>
  )
}

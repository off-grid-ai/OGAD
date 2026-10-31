import { useEffect, useState } from 'react'
import type { AnalyticsPromptKind } from '../../../../shared/analytics'
import { analyticsBridge } from '@renderer/lib/analytics'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

const TITLES: Record<AnalyticsPromptKind, string> = {
  failure: 'Help us fix this?',
  first_chat: 'Help us fix what breaks'
}

const BODY = 'Send anonymous stats and crash reports. We never see your prompts, replies or files.'

/**
 * The consent prompt main asks for: after a failure (at most once in 30 days) or, for someone who
 * set up before analytics existed, once after their first reply. Main decides when; this only asks.
 */
export function AnalyticsPrompt(): React.ReactElement | null {
  const [kind, setKind] = useState<AnalyticsPromptKind | null>(null)

  useEffect(() => analyticsBridge()?.onPrompt?.(setKind), [])

  if (!kind) return null
  const answer = (share: boolean): void => {
    const current = kind
    setKind(null)
    if (share)
      void window.api.analytics.optIn(
        current === 'failure' ? 'failure_prompt' : 'first_chat_prompt'
      )
    else void window.api.analytics.dismissPrompt()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{TITLES[kind]}</DialogTitle>
          <DialogDescription className="leading-relaxed">{BODY}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)}>
            Not now
          </Button>
          <Button onClick={() => answer(true)}>Share</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

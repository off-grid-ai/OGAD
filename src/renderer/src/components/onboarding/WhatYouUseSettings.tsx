/** Settings → What you use: the onboarding picks, changed any time. Saves on every tap. */
import { useState, type JSX } from 'react'
import { WhatYouUse } from './PickSteps'
import { loadPicks, savePicks, togglePartAnywhere, type Picks } from './picks'

export function WhatYouUseSettings(): JSX.Element {
  const [picks, setPicks] = useState<Picks>(loadPicks)
  return (
    <WhatYouUse
      picks={picks}
      onToggle={(id) => {
        const next = togglePartAnywhere(picks, id)
        setPicks(next)
        savePicks(next)
      }}
    />
  )
}

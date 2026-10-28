import { useState } from 'react'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { SettingsRow } from './SettingsRow'
import { setUiAnimations, uiAnimationsOn } from '../ui-animations'

/** Settings > UI: how the app responds under the pointer. */
export function UiSettingsSection(): React.JSX.Element {
  const [animations, setAnimations] = useState(uiAnimationsOn)
  return (
    <SettingsRow
      label="Hover and click animations"
      hint="Buttons and cards lift, press in and glow as you use them."
      controlId="ui-animations"
      inline
    >
      <Switch
        id="ui-animations"
        checked={animations}
        onCheckedChange={(on) => {
          setAnimations(on)
          setUiAnimations(on)
        }}
      />
    </SettingsRow>
  )
}

import { FilmStrip } from '@phosphor-icons/react'
import { Button } from './ui/button'

/** Video is Pro. Free builds show this short line and open the upgrade screen. */
export function VideoProUpsell(props: { readonly onOpen?: () => void }): React.JSX.Element {
  return (
    <span className="flex items-center gap-3 text-xs text-neutral-500">
      <FilmStrip className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
      <span className="min-w-0 flex-1">Video needs Off Grid AI Pro.</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => {
          props.onOpen?.()
          window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'video' }))
        }}
      >
        See Pro
      </Button>
    </span>
  )
}

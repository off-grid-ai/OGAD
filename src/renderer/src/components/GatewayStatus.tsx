import { useCallback, useEffect, useState } from 'react'
import { ArrowClockwiseIcon, CircleNotchIcon } from '@phosphor-icons/react'
import { StatePill } from '@offgrid/operator-ui/operator/presence'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'

type GatewayState = 'checking' | 'running' | 'down'

/**
 * Whether the gateway answers, beside its URL: a copied URL that gets "connection refused" should
 * already show here as not running, with Restart one click away (the same row Settings > Setup &
 * health shows).
 */
export function GatewayStatus(): React.ReactElement {
  const [state, setState] = useState<GatewayState>('checking')
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const health = await window.api.systemHealth()
      const gateway = health.components.find((component) => component.id === 'gateway')
      setState(gateway?.status === 'ready' ? 'running' : 'down')
    } catch {
      setState('down')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const restart = async (): Promise<void> => {
    setRestarting(true)
    setError('')
    try {
      const result = await window.api.restartComponent('gateway')
      if (!result.success) setError(result.error || 'Could not restart the gateway.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not restart the gateway.')
    } finally {
      await refresh()
      setRestarting(false)
    }
  }

  return (
    <div className="flex items-center gap-2" title={error || undefined}>
      <StatePill
        tone={state === 'running' ? 'on' : state === 'checking' ? 'busy' : 'warn'}
        label={
          state === 'running' ? 'Running' : state === 'checking' ? 'Checking' : 'Not responding'
        }
      />
      {state !== 'checking' && (
        <IconTip label={error || 'Restart the gateway'}>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Restart the gateway"
            aria-busy={restarting || undefined}
            disabled={restarting}
            onClick={() => void restart()}
          >
            <GlyphSwap glyphKey={restarting ? 'busy' : 'idle'}>
              {restarting ? (
                <CircleNotchIcon className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowClockwiseIcon className="h-4 w-4" />
              )}
            </GlyphSwap>
          </Button>
        </IconTip>
      )}
    </div>
  )
}

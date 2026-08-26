import { type FormEvent, useEffect, useRef, useState } from 'react'
import { ArrowClockwise, ArrowLeft, ArrowRight, Plus, X } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import {
  nativeSurfaceIsOccluded,
  onNativeSurfaceOcclusion
} from '@renderer/lib/native-surface-occlusion'
import type {
  BrowserPointerEvent,
  BrowserSessionSnapshot
} from '../../../../../shared/browser-session'
import { fitWebUseDesktopSurface } from '../../../../../shared/browser-session'
import { BROWSER_POINTER_VISUAL } from '../../../../../shared/browser-pointer-visual'
import {
  inactiveWebSummary,
  statusTone,
  tabLabel,
  type TaskStatus,
  type TaskTab
} from './task-types'

export interface BrowserChromeProps {
  active: TaskTab
  activeStatus: TaskStatus
  journeyPages: BrowserSessionSnapshot[]
  manualTabs: TaskTab[]
  navigation: Pick<BrowserSessionSnapshot, 'canGoBack' | 'canGoForward' | 'isLoading'>
  address: string
  addressError: string
  pointer: BrowserPointerEvent | null
  onAddressChange: (value: string) => void
  onSubmitAddress: (event: FormEvent) => void
  onActivatePage: (sessionId: string) => void
  onActivateTab: (tab: TaskTab) => void
  onClosePage: (sessionId: string) => void
  onCloseTab: (tab: TaskTab) => void
  onNewTab: () => void
}

function BrowserTabs(props: BrowserChromeProps): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Web Use pages"
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border bg-background pl-0 pr-2 pt-1.5"
    >
      {props.journeyPages.map((page, index) => (
        <div
          key={page.sessionId}
          className={`flex min-w-[120px] max-w-[220px] items-center border border-b-0 px-2 py-1.5 text-[10px] ${page.sessionId === props.active.sessionId ? 'border-border bg-muted text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={page.sessionId === props.active.sessionId}
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => props.onActivatePage(page.sessionId)}
          >
            {page.title || `Page ${index + 1}`}
          </button>
          <button
            type="button"
            aria-label={`Close ${page.title || `Page ${index + 1}`}`}
            className="ml-2 grid h-5 w-5 shrink-0 place-items-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
            onClick={() => props.onClosePage(page.sessionId)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {props.manualTabs.map((tab, index) => (
        <div
          key={tab.taskId}
          data-testid={`browser-page-${tab.taskId}`}
          className={`flex min-w-[120px] max-w-[220px] items-center border border-b-0 px-2 py-1.5 text-[10px] ${tab.taskId === props.active.taskId ? 'border-border bg-muted text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.taskId === props.active.taskId}
            className="min-w-0 flex-1 truncate text-left"
            onClick={() => props.onActivateTab(tab)}
          >
            {tab.title || `Browser ${index + 1}`}
          </button>
          <button
            type="button"
            aria-label={`Close ${tab.title || `Browser ${index + 1}`}`}
            className="ml-2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => props.onCloseTab(tab)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="New browser tab"
        onClick={props.onNewTab}
        className="mb-1 h-7 w-7 shrink-0 rounded-sm"
      >
        <Plus size={14} />
      </Button>
    </div>
  )
}

function BrowserToolbar(props: BrowserChromeProps): React.JSX.Element {
  const control = (action: 'back' | 'forward' | 'reload' | 'stop'): void => {
    void window.api.browser?.control(action, props.active.sessionId)
  }
  return (
    <div className="border-b border-border bg-muted px-2 py-2">
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Go back"
          disabled={!props.active.sessionId || !props.navigation.canGoBack}
          onClick={() => control('back')}
          className="h-7 w-7 rounded-sm"
        >
          <ArrowLeft size={15} />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Go forward"
          disabled={!props.active.sessionId || !props.navigation.canGoForward}
          onClick={() => control('forward')}
          className="h-7 w-7 rounded-sm"
        >
          <ArrowRight size={15} />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={props.navigation.isLoading ? 'Stop loading' : 'Reload page'}
          disabled={!props.active.sessionId}
          onClick={() => control(props.navigation.isLoading ? 'stop' : 'reload')}
          className="h-7 w-7 rounded-sm"
        >
          {props.navigation.isLoading ? <X size={14} /> : <ArrowClockwise size={15} />}
        </Button>
        <form onSubmit={props.onSubmitAddress} className="min-w-0 flex-1">
          <input
            aria-label="Browser address"
            value={props.address}
            readOnly={!props.active.sessionId}
            onChange={(event) => props.onAddressChange(event.target.value)}
            className="h-7 w-full rounded-sm border border-input bg-background px-2 text-xs text-foreground outline-none transition-colors focus:border-green-500"
            placeholder="Enter a website or search"
            spellCheck={false}
          />
        </form>
      </div>
      {props.addressError ? (
        <p className="mt-1 text-[11px] text-red-500">{props.addressError}</p>
      ) : null}
    </div>
  )
}

function WebPageSurface({
  active,
  activeStatus,
  pointer
}: Pick<BrowserChromeProps, 'active' | 'activeStatus' | 'pointer'>): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  const [surfaceSize, setSurfaceSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const report = (): void => {
      const rect = container.getBoundingClientRect()
      setSurfaceSize(fitWebUseDesktopSurface(rect))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const setRegion = (
      window.api.browser as Partial<NonNullable<typeof window.api.browser>> | undefined
    )?.setRegion
    const element = regionRef.current
    if (!active.sessionId || !element) {
      setRegion?.(null)
      return
    }
    const report = (): void => {
      if (nativeSurfaceIsOccluded()) {
        setRegion?.(null)
        return
      }
      const rect = element.getBoundingClientRect()
      setRegion?.({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    const stopOcclusion = onNativeSurfaceOcclusion(report)
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)
    return () => {
      observer.disconnect()
      stopOcclusion()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
      setRegion?.(null)
    }
  }, [active.sessionId])

  if (!active.sessionId) {
    return (
      <div
        data-testid="watched-failure"
        className="flex min-h-0 flex-1 flex-col justify-center border-b border-border bg-muted p-5"
      >
        <p className={`text-xs uppercase tracking-wide ${statusTone(activeStatus)}`}>
          {tabLabel(active)} {activeStatus}
        </p>
        <p className="mt-2 text-sm text-foreground">{inactiveWebSummary(active, activeStatus)}</p>
        {active.lastUrl ? (
          <div className="mt-3">
            <Button size="sm" onClick={() => void window.api.browser?.reopen(active.taskId)}>
              Open last page
            </Button>
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <div
      ref={containerRef}
      data-testid="watched-web-container"
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden border-b border-border bg-muted"
    >
      <div
        ref={regionRef}
        data-testid="watched-web-region"
        className="relative shrink-0 overflow-hidden bg-muted"
        style={surfaceSize ?? { width: '100%', height: '100%' }}
      >
        {pointer?.sessionId === active.sessionId ? (
          <div
            data-testid="browser-agent-pointer"
            className="pointer-events-none absolute z-20"
            style={{
              left: pointer.x - BROWSER_POINTER_VISUAL.hotspotX,
              top: pointer.y - BROWSER_POINTER_VISUAL.hotspotY,
              filter: `drop-shadow(0 0 5px ${BROWSER_POINTER_VISUAL.glow}) drop-shadow(0 1px 1px rgb(0 0 0 / 50%))`
            }}
            aria-label="Off Grid AI pointer"
          >
            {pointer.phase === 'pressed' ? (
              <span
                className="absolute h-2 w-2 animate-ping rounded-full border"
                style={{
                  left: BROWSER_POINTER_VISUAL.hotspotX - 4,
                  top: BROWSER_POINTER_VISUAL.hotspotY - 4,
                  borderColor: BROWSER_POINTER_VISUAL.action
                }}
              />
            ) : null}
            <svg
              width={BROWSER_POINTER_VISUAL.width}
              height={BROWSER_POINTER_VISUAL.height}
              viewBox={BROWSER_POINTER_VISUAL.viewBox}
              aria-hidden="true"
            >
              {BROWSER_POINTER_VISUAL.paths.map((path) => (
                <path
                  key={path}
                  d={path}
                  fill={BROWSER_POINTER_VISUAL.fill}
                  stroke={BROWSER_POINTER_VISUAL.stroke}
                  strokeWidth={BROWSER_POINTER_VISUAL.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function BrowserChrome(props: BrowserChromeProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrowserTabs {...props} />
      <BrowserToolbar {...props} />
      <WebPageSurface
        active={props.active}
        activeStatus={props.activeStatus}
        pointer={props.pointer}
      />
    </div>
  )
}

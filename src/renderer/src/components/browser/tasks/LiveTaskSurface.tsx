import type { FormEvent } from 'react'
import { Button } from '@renderer/components/ui/button'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import type {
  BrowserPointerEvent,
  BrowserSessionSnapshot
} from '../../../../../shared/browser-session'
import { BrowserChrome } from './BrowserChrome'
import { statusTone, type TaskStatus, type TaskTab } from './task-types'

interface TakeoverRequest {
  taskId: string
  why: string
}

export interface LiveTaskSurfaceProps {
  active: TaskTab
  activeStatus: TaskStatus
  activeIsLive: boolean
  activeComputerIsLocal: boolean
  activeWebIsLocal: boolean
  activeEscNotice?: string
  controlError: string
  journeyPages: BrowserSessionSnapshot[]
  manualTabs: TaskTab[]
  navigation: Pick<BrowserSessionSnapshot, 'canGoBack' | 'canGoForward' | 'isLoading'>
  address: string
  addressError: string
  pointer: BrowserPointerEvent | null
  takeover: TakeoverRequest | null
  onAddressChange: (value: string) => void
  onSubmitAddress: (event: FormEvent) => void
  onActivatePage: (sessionId: string) => void
  onActivateTab: (tab: TaskTab) => void
  onClosePage: (sessionId: string) => void
  onCloseTab: (tab: TaskTab) => void
  onNewTab: () => void
  onStopWeb: () => void
  onComputerControl: (command: 'stop' | 'pause' | 'takeover' | 'resume') => void
  onResolveTakeover: (outcome: 'resumed' | 'cancelled') => void
}

function canStopWeb(props: LiveTaskSurfaceProps): boolean {
  return (
    props.active.kind === 'web_use' &&
    !props.active.manual &&
    props.activeWebIsLocal &&
    ['running', 'waiting', 'reconnecting'].includes(props.active.status)
  )
}

function canControlComputer(props: LiveTaskSurfaceProps): boolean {
  return (
    props.active.kind === 'computer_use' &&
    props.activeComputerIsLocal &&
    ['running', 'paused'].includes(props.active.status)
  )
}

function deviceStatus(props: LiveTaskSurfaceProps): string {
  const name = props.active.executionDeviceName
  if (!name) return ''
  if (!props.activeIsLive) return ` / Evidence from ${name}`
  return ` / ${props.activeComputerIsLocal || props.activeWebIsLocal ? 'This device' : `Running on ${name}`}`
}

function LiveHeader(props: LiveTaskSurfaceProps): React.JSX.Element {
  const active = props.active
  const webCanStop = canStopWeb(props)
  const computerCanControl = canControlComputer(props)
  return (
    <>
      <div
        data-testid="task-live-controls"
        className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-3 py-2"
      >
        <div className="min-w-0">
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Live task</p>
          <p className="truncate text-xs text-foreground">{active.title}</p>
          <p className="mt-0.5 truncate text-[9px] uppercase tracking-wide text-muted-foreground">
            <span className={statusTone(props.activeStatus)}>{props.activeStatus}</span>
            {deviceStatus(props)}
            {active.currentAction ? ` / ${active.currentAction}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {webCanStop ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-7 px-2 text-[10px]"
              onClick={props.onStopWeb}
            >
              Stop Web Use
            </Button>
          ) : null}
          {computerCanControl ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px]"
                onClick={() =>
                  props.onComputerControl(active.status === 'paused' ? 'resume' : 'pause')
                }
              >
                {active.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px]"
                onClick={() => props.onComputerControl('takeover')}
              >
                Take Over
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2 text-[10px]"
                onClick={() => props.onComputerControl('stop')}
              >
                Stop
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {props.controlError ? (
        <p role="alert" className="border-b border-red-500/30 px-3 py-2 text-[10px] text-red-500">
          {props.controlError}
        </p>
      ) : null}
    </>
  )
}

function computerStatusCopy(props: LiveTaskSurfaceProps): string {
  if (!props.activeIsLive)
    return `Execution evidence was recorded on ${props.active.executionDeviceName || 'the execution device'}. Device-local screenshots stay there.`
  if (!props.activeComputerIsLocal)
    return `This task is running on ${props.active.executionDeviceName || 'another device'}. Control it from that device.`
  if (props.activeEscNotice)
    return 'Off Grid AI is acting on your screen. Use the available task controls when you want control.'
  return 'Off Grid AI is acting on your screen. Use Pause, Stop, Take Over, or Esc when you want control.'
}

function ComputerSurface(props: LiveTaskSurfaceProps): React.JSX.Element {
  const active = props.active
  const statusCopy = computerStatusCopy(props)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm text-foreground">{active.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{statusCopy}</p>
        {active.phase || active.currentAction ? (
          <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            {active.phase ?? active.status}
            {active.currentStep !== undefined ? ` · Step ${active.currentStep}` : ''}
            {active.currentAction ? ` · ${active.currentAction}` : ''}
          </p>
        ) : null}
        {props.activeEscNotice ? (
          <p className="mt-2 border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-500">
            {props.activeEscNotice}
          </p>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 bg-muted p-3">
        {active.screenshotPath ? (
          <img
            src={captureUrlForPath(active.screenshotPath)}
            alt="Last screen from this Computer Use run"
            className="h-full w-full object-contain"
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {active.executionDeviceName
              ? `The screen image stays on ${active.executionDeviceName}.`
              : active.status === 'running'
                ? 'Waiting for the first screen update.'
                : 'No screen image was saved for this run.'}
          </p>
        )}
      </div>
    </div>
  )
}

function SavedWebSurface(props: LiveTaskSurfaceProps): React.JSX.Element {
  const active = props.active
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted">
      <div className="border-b border-border bg-background px-3 py-2">
        <p className="truncate text-[10px] text-muted-foreground">
          {active.lastUrl || 'Saved browser state'}
        </p>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <img
          src={captureUrlForPath(active.screenshotPath!)}
          alt="Last browser state from this Web Use run"
          className="h-full w-full object-contain"
        />
      </div>
    </div>
  )
}

function TakeoverPrompt({
  takeover,
  onResolve
}: {
  takeover: TakeoverRequest | null
  onResolve: (outcome: 'resumed' | 'cancelled') => void
}): React.JSX.Element | null {
  if (!takeover) return null
  return (
    <div className="border-b border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-amber-500">Your turn</p>
          <p className="mt-1 text-xs text-foreground">{takeover.why}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Complete this step in the page. Off Grid AI does not read your password or codes.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => onResolve('resumed')}>
            Resume
          </Button>
          <Button size="sm" variant="outline" onClick={() => onResolve('cancelled')}>
            Cancel task
          </Button>
        </div>
      </div>
    </div>
  )
}

export function LiveTaskSurface(props: LiveTaskSurfaceProps): React.JSX.Element {
  return (
    <div data-testid="task-live-pane" className="relative flex h-full min-h-0 flex-col">
      <LiveHeader {...props} />
      {props.active.kind === 'web_use' && !props.activeIsLive && props.active.screenshotPath ? (
        <SavedWebSurface {...props} />
      ) : props.active.kind === 'web_use' ? (
        <>
          <BrowserChrome
            active={props.active}
            activeStatus={props.activeStatus}
            journeyPages={props.journeyPages}
            manualTabs={props.manualTabs}
            navigation={props.navigation}
            address={props.address}
            addressError={props.addressError}
            pointer={props.pointer}
            onAddressChange={props.onAddressChange}
            onSubmitAddress={props.onSubmitAddress}
            onActivatePage={props.onActivatePage}
            onActivateTab={props.onActivateTab}
            onClosePage={props.onClosePage}
            onCloseTab={props.onCloseTab}
            onNewTab={props.onNewTab}
          />
          <TakeoverPrompt
            takeover={props.takeover?.taskId === props.active.taskId ? props.takeover : null}
            onResolve={props.onResolveTakeover}
          />
        </>
      ) : (
        <ComputerSurface {...props} />
      )}
    </div>
  )
}

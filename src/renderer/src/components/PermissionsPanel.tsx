import { ArrowsClockwise, Check, Eye, Shield, WifiHigh, X } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { Button } from './ui/button'
import { usePermissionController, type PermissionController } from './use-permission-controller'

interface PermissionCardProps {
  title: string
  description: string
  instructions?: string
  actionLabel?: string
  actionAriaLabel?: string
  icon: React.ReactNode
  state: 'checking' | 'granted' | 'denied'
  onOpenSettings: () => void
}

function PermissionCard({
  title,
  description,
  instructions,
  actionLabel = 'Open Settings',
  actionAriaLabel,
  icon,
  state,
  onOpenSettings
}: PermissionCardProps): React.ReactElement {
  const granted = state === 'granted'
  const checking = state === 'checking'
  return (
    <div
      role="status"
      aria-label={`${title} permission`}
      className={cn(
        'flex min-h-44 flex-col border p-4 transition-colors duration-150',
        granted ? 'border-neutral-700 bg-neutral-900/60' : 'border-neutral-800 bg-neutral-950/40'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-neutral-800 bg-neutral-900 text-neutral-400">
          {icon}
        </div>
        <span
          className={cn(
            'text-[10px] uppercase tracking-widest',
            granted ? 'text-emerald-500' : 'text-neutral-500'
          )}
        >
          {checking ? 'Checking' : granted ? 'Granted' : 'Permission needed'}
        </span>
      </div>
      <div className="mt-3 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm text-neutral-100">{title}</h3>
          <span
            className="flex h-4 w-4 items-center justify-center rounded-full bg-neutral-800"
            aria-hidden="true"
          >
            {granted ? (
              <Check className="h-2.5 w-2.5 text-neutral-300" />
            ) : (
              <X className="h-2.5 w-2.5 text-neutral-600" />
            )}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">{description}</p>
        {!granted && instructions ? (
          <p className="mt-2 text-[10px] leading-4 text-neutral-600">{instructions}</p>
        ) : null}
      </div>
      {!granted && !checking ? (
        <Button
          type="button"
          onClick={onOpenSettings}
          aria-label={actionAriaLabel ?? `Open ${title} settings`}
          variant="outline"
          size="sm"
          className="mt-3 w-full rounded-none border-neutral-700 bg-neutral-900 text-xs text-neutral-300 active:scale-95"
        >
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

function permissionState(value: boolean | undefined): PermissionCardProps['state'] {
  if (value === undefined) return 'checking'
  return value ? 'granted' : 'denied'
}

export function PermissionsPanel({
  controller
}: {
  controller: PermissionController
}): React.ReactElement {
  const permissions = controller
  const { status, checking, error, screenRecordingRestartRequired } = permissions

  return (
    <div className="font-mono">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <PermissionCard
          title="Accessibility"
          description="Read exact text, app names, and URLs when macOS exposes them."
          icon={<Eye className="h-5 w-5" />}
          state={permissionState(status?.accessibility)}
          onOpenSettings={() => void permissions.openAccessibility()}
        />
        <PermissionCard
          title="Screen Recording"
          description={
            screenRecordingRestartRequired
              ? 'Relaunch once to apply the access selected in System Settings.'
              : 'Capture screen frames for Replay and local vision analysis.'
          }
          instructions={
            screenRecordingRestartRequired
              ? 'If the toggle is on, relaunch once. If it is off, review System Settings first.'
              : undefined
          }
          actionLabel={
            screenRecordingRestartRequired
              ? 'Relaunch Off Grid AI Desktop'
              : 'Enable Screen Recording'
          }
          actionAriaLabel={
            screenRecordingRestartRequired
              ? 'Relaunch Off Grid AI Desktop for Screen Recording'
              : 'Enable Screen Recording'
          }
          icon={<Shield className="h-5 w-5" />}
          state={permissionState(status?.screenRecording)}
          onOpenSettings={() => void permissions.handleScreenRecording()}
        />
        <PermissionCard
          title="Local Network"
          description="Find and sync directly with your devices on this network."
          instructions="Enable Off Grid AI Desktop. Development builds appear as Electron. If it is already on but still reads denied, toggle it off and on once."
          actionLabel="Open Privacy & Security"
          actionAriaLabel="Open Privacy & Security for Local Network access"
          icon={<WifiHigh className="h-5 w-5" />}
          state={permissionState(status?.localNetwork)}
          onOpenSettings={() => void permissions.openLocalNetwork()}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-3 border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-neutral-800 pt-3">
        <span className="text-[10px] uppercase tracking-widest text-neutral-600" aria-live="polite">
          {screenRecordingRestartRequired
            ? 'Restart required'
            : checking
              ? 'Checking current grants'
              : 'Current macOS status'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void permissions.check()}
          disabled={checking}
          className="rounded-none border-neutral-700 active:scale-95"
        >
          <ArrowsClockwise className={cn('h-4 w-4', checking && 'animate-spin')} />
          {checking ? 'Checking' : 'Check permissions again'}
        </Button>
      </div>
    </div>
  )
}

export function SettingsPermissionsPanel(): React.ReactElement {
  const controller = usePermissionController()
  return <PermissionsPanel controller={controller} />
}

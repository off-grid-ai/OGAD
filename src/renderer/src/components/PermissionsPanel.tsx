import { AnimatePresence, motion } from 'motion/react'
import { ArrowsClockwise, Eye, Shield, WifiHigh } from '@phosphor-icons/react'
import { cn } from '@renderer/lib/utils'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import {
  AutoHeight,
  LiveStatus,
  SettingRow,
  StatePill,
  type StateTone
} from '@offgrid/operator-ui/operator/presence'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { IconTip } from './IconTip'
import { usePermissionController, type PermissionController } from './use-permission-controller'

const ease = [0.16, 1, 0.3, 1] as const

type PermissionState = 'checking' | 'granted' | 'denied'

interface PermissionRowProps {
  title: string
  description: string
  instructions?: string
  actionLabel?: string
  actionAriaLabel?: string
  icon: React.ReactNode
  state: PermissionState
  /** A saved grant that needs a relaunch reads amber instead of neutral. */
  pending?: boolean
  onOpenSettings: () => void
}

/** One permission as a quiet setting row: icon and words on the left, next step and state pill on the right. */
function PermissionRow({
  title,
  description,
  instructions,
  actionLabel = 'Open Settings',
  actionAriaLabel,
  icon,
  state,
  pending = false,
  onOpenSettings
}: PermissionRowProps): React.ReactElement {
  const granted = state === 'granted'
  const checking = state === 'checking'
  const tone: StateTone = granted ? 'on' : checking ? 'busy' : pending ? 'warn' : 'off'
  return (
    <div role="status" aria-label={`${title} permission`} aria-busy={checking || undefined}>
      <SettingRow
        icon={icon}
        title={title}
        description={
          <>
            {description}
            {!granted && instructions ? (
              <span className="mt-1 block text-[11px] text-muted-foreground/80">
                {instructions}
              </span>
            ) : null}
          </>
        }
      >
        <div className="flex shrink-0 items-center gap-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {!granted && !checking ? (
              <motion.span
                key="action"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.3, ease }}
              >
                <Button
                  type="button"
                  onClick={onOpenSettings}
                  aria-label={actionAriaLabel ?? `Open ${title} settings`}
                  variant="outline"
                  size="sm"
                >
                  {actionLabel}
                </Button>
              </motion.span>
            ) : null}
          </AnimatePresence>
          <StatePill
            tone={tone}
            label={
              checking
                ? 'Checking'
                : granted
                  ? 'Granted'
                  : pending
                    ? 'Relaunch needed'
                    : 'Permission needed'
            }
          />
        </div>
      </SettingRow>
    </div>
  )
}

function permissionState(value: boolean | undefined): PermissionState {
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
    <div>
      <AnimatedGroup preset="slide" className="divide-y divide-border/50">
        <PermissionRow
          title="Accessibility"
          description="Read exact text, app names, and URLs when macOS exposes them."
          icon={<Eye className="size-4" />}
          state={permissionState(status?.accessibility)}
          onOpenSettings={() => void permissions.openAccessibility()}
        />
        <PermissionRow
          title="Screen Recording"
          description={
            screenRecordingRestartRequired
              ? 'Turned it on in System Settings? Relaunch to apply it.'
              : 'Capture screen frames for Replay and local vision analysis.'
          }
          actionLabel={screenRecordingRestartRequired ? 'Relaunch' : 'Enable Screen Recording'}
          actionAriaLabel={
            screenRecordingRestartRequired
              ? 'Relaunch Off Grid AI Desktop for Screen Recording'
              : 'Enable Screen Recording'
          }
          icon={<Shield className="size-4" />}
          state={permissionState(status?.screenRecording)}
          pending={screenRecordingRestartRequired}
          onOpenSettings={() => void permissions.handleScreenRecording()}
        />
        <PermissionRow
          title="Local Network"
          description="Find and sync directly with your devices on this network."
          instructions="Enable Off Grid AI Desktop. Development builds appear as Electron. If it is already on but still reads denied, toggle it off and on once."
          actionLabel="Open Privacy & Security"
          actionAriaLabel="Open Privacy & Security for Local Network access"
          icon={<WifiHigh className="size-4" />}
          state={permissionState(status?.localNetwork)}
          onOpenSettings={() => void permissions.openLocalNetwork()}
        />
      </AnimatedGroup>

      <AutoHeight>
        <AnimatePresence initial={false}>
          {error ? (
            <motion.p
              key="error"
              role="alert"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease }}
              className="mt-3 rounded-xl px-3 py-2 text-xs text-red-300 shadow-[inset_0_0_0_1px_rgb(239_68_68/0.3)]"
            >
              {error}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </AutoHeight>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-4">
        <LiveStatus
          as="span"
          className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
        >
          {screenRecordingRestartRequired
            ? 'Restart required'
            : checking
              ? 'Checking current grants'
              : 'Current access status'}
        </LiveStatus>
        <IconTip label={checking ? 'Checking' : 'Check permissions again'}>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={checking ? 'Checking' : 'Check permissions again'}
            aria-busy={checking || undefined}
            onClick={() => void permissions.check()}
            disabled={checking}
          >
            <ArrowsClockwise className={cn('size-4', checking && 'animate-spin')} />
          </Button>
        </IconTip>
      </div>
    </div>
  )
}

export function SettingsPermissionsPanel(): React.ReactElement {
  const controller = usePermissionController()
  return <PermissionsPanel controller={controller} />
}

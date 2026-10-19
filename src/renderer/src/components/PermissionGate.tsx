import { replaceAppLocation } from '@renderer/lib/app-location'
import { modelDisplayName } from '@offgrid/models'
import { useState, useEffect, useCallback } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { X, Cpu, ArrowLeft } from '@phosphor-icons/react'
import {
  Progress,
  ProgressTrack,
  ProgressIndicator
} from '@offgrid/operator-ui/operator/coss/progress'
import { PageHeader, Section } from '@offgrid/operator-ui/operator/experience'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { Button } from './ui/button'
import { IconTip } from './IconTip'
import { SetupPanel } from './setup/SetupPanel'
import { deviceNoun } from '@renderer/lib/device'
import { PermissionsPanel } from './PermissionsPanel'
import { usePermissionController } from './use-permission-controller'
import { useRendererEntitlement } from '@renderer/bootstrap/useRendererEntitlement'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress, type ProgressLike } from '@offgrid/ui'
import { formatStorageBytes } from './setup/storage-format'
import { useTaskWorkspaceOpen } from '@renderer/lib/task-side-panel'
import { useModelDownloadProgress } from '@renderer/hooks/useModelDownloadProgress'

interface PermissionGateProps {
  children: React.ReactNode
}

type VisionIssue =
  | { kind: 'missing-projector'; modelId: string; modelName: string }
  | { kind: 'choose-vision-model'; modelId: string | null; modelName: string | null }

export function PermissionGate({ children }: PermissionGateProps): React.JSX.Element {
  const { isPro } = useRendererEntitlement()
  const [modelStatus, setModelStatus] = useState<{ downloaded: boolean; modelsDir: string } | null>(
    null
  )
  // Pro setup is NON-blocking: users go straight into the shell to look around.
  // The detailed setup screen opens on demand; a slim nudge can be dismissed.
  const [showSetup, setShowSetup] = useState(false)
  const [setupDismissed, setSetupDismissed] = useState(false)
  const [visionIssue, setVisionIssue] = useState<VisionIssue | null>(null)
  const [visionDownloadProgress, setVisionDownloadProgress] = useState<ProgressLike | null>(null)
  const [visionDownloadFailure, setVisionDownloadFailure] = useState<string | null>(null)
  const permissions = usePermissionController(isPro)
  const permissionStatus = permissions.status
  const isChecking = permissions.checking

  // Capture permissions (Accessibility + Screen Recording) are only needed by the
  // Pro "sees" layer. The free build runs chat/projects/models and gates on the
  // model alone.
  const permsOk = isPro ? (permissionStatus?.allGranted ?? false) : true

  const checkModelStatus = useCallback(async () => {
    try {
      const status = await window.api.checkModelStatus()
      console.log('Model status:', status)
      setModelStatus(status)
      return status.downloaded
    } catch (e) {
      console.error('Failed to check model status:', e)
      return false
    }
  }, [])

  const checkCaptureVision = useCallback(async () => {
    if (!isPro || !window.api.proInvoke) return
    try {
      const [activeId, statuses, capture, catalog] = await Promise.all([
        window.api.getActiveModel(),
        window.api.getModelVisionStatus(),
        window.api.proInvoke('capture:status'),
        window.api.getModelCatalog().catch(() => undefined)
      ])
      const status = capture as
        { running?: boolean; paused?: boolean; visionReady?: boolean } | undefined
      if (!status?.running || status.paused || status.visionReady) {
        setVisionIssue(null)
        return
      }
      const activeStatus = activeId ? statuses?.[activeId] : undefined
      const catalogModels = (
        catalog as { models?: Array<{ id: string; name?: string }> } | undefined
      )?.models
      const activeModelName = modelDisplayName(activeId, { catalog: catalogModels ?? [] })
      if (activeId && activeStatus?.supportsVision && !activeStatus.projectorInstalled) {
        setVisionIssue({
          kind: 'missing-projector',
          modelId: activeId,
          modelName: activeModelName ?? activeId
        })
        return
      }
      if (activeId && activeStatus?.supportsVision && activeStatus.projectorInstalled) {
        setVisionIssue(null)
        return
      }
      setVisionIssue({
        kind: 'choose-vision-model',
        modelId: activeId ?? null,
        modelName: activeModelName
      })
    } catch (error) {
      console.error('Failed to check capture vision readiness:', error)
    }
  }, [isPro])

  // Initial check
  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([checkModelStatus(), checkCaptureVision()]))
  }, [checkModelStatus, checkCaptureVision])

  useEffect(() => {
    if (!isPro) return
    const offCapture = window.api.proOn?.('capture:changed', () => void checkCaptureVision())
    return () => {
      if (typeof offCapture === 'function') offCapture()
    }
  }, [checkCaptureVision, isPro])

  useModelDownloadProgress((progress) => {
    if (progress.modelId !== visionIssue?.modelId) return
    if (progress.status === 'completed') {
      setVisionDownloadProgress(null)
      setVisionDownloadFailure(null)
      void checkCaptureVision()
    } else if (progress.status === 'failed') {
      setVisionDownloadProgress(null)
      setVisionDownloadFailure(
        'Vision support download failed. Check your connection and try again.'
      )
    } else if (progress.status === 'cancelled') {
      setVisionDownloadProgress(null)
    } else {
      setVisionDownloadProgress(progress)
    }
  }, isPro)

  // Permission polling is owned by usePermissionController. Keep model polling here
  // because model readiness is a separate setup boundary.
  useEffect(() => {
    if (modelStatus?.downloaded) return

    const interval = setInterval(() => {
      checkModelStatus()
    }, 2000)

    return () => clearInterval(interval)
  }, [modelStatus?.downloaded, checkModelStatus])

  const openModels = (): void => {
    window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'models' }))
    replaceAppLocation('/models')
  }

  const handleVisionAction = (): void => {
    if (visionIssue?.kind === 'missing-projector') {
      setVisionDownloadFailure(null)
      setVisionDownloadProgress({ percent: 0 })
      void window.api
        .downloadModel(visionIssue.modelId)
        .catch((error) => {
          console.error('Failed to download capture vision support:', error)
          setVisionDownloadFailure(
            'Vision support download failed. Check your connection and try again.'
          )
        })
        .finally(() => {
          setVisionDownloadProgress(null)
          void checkCaptureVision()
        })
      return
    }
    openModels()
  }

  // Loading state
  if (isChecking && !permissionStatus) {
    return (
      <div className="h-screen w-screen bg-neutral-950 flex items-center justify-center fixed inset-0">
        <motion.div
          initial={{ opacity: 0, filter: 'blur(10px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative z-10 text-center"
        >
          <div className="w-8 h-8 mx-auto mb-4 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin" />
          <TextShimmer as="p" className="text-sm">
            Checking permissions
          </TextShimmer>
        </motion.div>
      </div>
    )
  }

  // Both tiers flow through the same NON-blocking path. "Ready" = a model is
  // present (Pro also needs capture permissions). Free has permsOk=true, so for
  // free this is just "has a model". Either way it's a dismissible nudge, never a
  // wall — so free users also get the "Configure for me" prompt when they have no
  // model yet (the most useful first-run action).
  const ready = permsOk && !!modelStatus?.downloaded

  // Default (NON-blocking): drop straight into the shell so people can look around.
  // Show a slim, dismissible nudge when capture perms or a model are still missing.
  if (ready || !showSetup) {
    return (
      <>
        {children}
        <AnimatePresence>
          {!ready && !setupDismissed && (
            <SetupNudge
              key="setup-nudge"
              missingModel={!modelStatus?.downloaded}
              missingLocalNetwork={isPro && permissionStatus?.localNetwork === false}
              onOpen={() => setShowSetup(true)}
              onDismiss={() => setSetupDismissed(true)}
            />
          )}
          {ready && visionIssue && !setupDismissed && (
            <SetupNudge
              key="vision-nudge"
              issue={visionIssue.kind}
              modelName={visionIssue.modelName}
              progress={visionDownloadProgress}
              failure={visionDownloadFailure}
              onOpen={handleVisionAction}
              onDismiss={() => setSetupDismissed(true)}
            />
          )}
        </AnimatePresence>
      </>
    )
  }

  // Detailed setup screen — opened on demand from the nudge (no longer a hard wall).
  return (
    <div className="h-screen w-screen bg-neutral-950 fixed inset-0 overflow-hidden">
      <IconTip label="Back to app">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back to app"
          onClick={() => setShowSetup(false)}
          className="absolute left-4 top-4 z-20"
        >
          <ArrowLeft />
        </Button>
      </IconTip>

      <div className="relative z-10 h-full w-full flex flex-col items-center overflow-y-auto px-8 pb-12 pt-16">
        <div className="w-full max-w-3xl my-auto">
          <PageHeader
            eyebrow={
              <>
                <Cpu className="h-3 w-3" aria-hidden /> Local AI
              </>
            }
            title="Set up your local AI"
            description={
              isPro
                ? 'Grant permissions and download a model to get started. Everything runs locally on your device.'
                : 'Download a model to get started. Everything runs locally on your device — no cloud, no account.'
            }
          />

          <div className="space-y-12">
            {/* The model: one-click "Configure for me" + manual browse (shared with
                Settings). On success it flips modelStatus and the gate clears. */}
            <Section label="Model">
              <SetupPanel hideHealth onConfigured={checkModelStatus} />
              <div className="mt-4">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => {
                    // Drop into the real in-app Models screen (with the left nav). The
                    // app shell (already mounted behind this gate) listens for og:navigate
                    // and switches view — replaceState alone wouldn't re-derive it. Keep
                    // the URL in sync, then dismiss the gate.
                    openModels()
                    setSetupDismissed(true)
                    setShowSetup(false)
                  }}
                  className="px-0 text-xs text-neutral-500 hover:text-neutral-300"
                >
                  or browse &amp; pick a model yourself
                </Button>
              </div>
            </Section>

            {/* What you get — gives the screen substance and sells the local stack. */}
            <Section
              label="On your device"
              description="One app · every open model · all on your device"
            >
              <AnimatedGroup
                preset="blur-slide"
                className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-400"
              >
                {['Chat', 'Vision', 'Images', 'Voice', 'Speech'].map((c) => (
                  <span key={c} className="flex items-center gap-1.5">
                    <span className="h-1 w-1 rounded-full bg-green-500" />
                    {c}
                  </span>
                ))}
              </AnimatedGroup>
            </Section>

            {/* System permissions - Pro only. The same panel is always reachable in Settings. */}
            {isPro && (
              <Section label="System permissions">
                <PermissionsPanel controller={permissions} />
              </Section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Slim, dismissible setup nudge shown over the shell when Pro setup is incomplete.
// Non-blocking: people can explore the whole app and finish setup whenever.
function SetupNudge({
  missingModel,
  missingLocalNetwork,
  issue,
  modelName,
  progress,
  failure,
  onOpen,
  onDismiss
}: {
  missingModel?: boolean
  missingLocalNetwork?: boolean
  issue?: VisionIssue['kind']
  modelName?: string | null
  progress?: ProgressLike | null
  failure?: string | null
  onOpen: () => void
  onDismiss: () => void
}): React.JSX.Element | null {
  const taskWorkspaceOpen = useTaskWorkspaceOpen()
  const reduceMotion = useReducedMotion()
  const [taskLeft, setTaskLeft] = useState<number | null>(null)

  useEffect(() => {
    if (!taskWorkspaceOpen) {
      return
    }
    const taskPane = document.querySelector<HTMLElement>('[data-testid="task-side-panel"]')
    if (!taskPane) return
    const measure = (): void => setTaskLeft(taskPane.getBoundingClientRect().left)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(taskPane)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [taskWorkspaceOpen])

  // Model-first wording. Missing a model is the thing that actually blocks you, and
  // "Configure for me" handles it in one click — so lead with that for both tiers.
  // Capture permissions (Pro-only) are the secondary, optional step.
  const title =
    issue === 'missing-projector'
      ? 'Capture needs vision support'
      : issue === 'choose-vision-model'
        ? 'Capture needs a vision model'
        : missingModel
          ? 'Set up your local AI'
          : missingLocalNetwork
            ? 'Allow Local Network access'
            : 'Finish setting up capture'
  const detail =
    issue === 'missing-projector'
      ? `${modelName ?? 'The active model'} can read images after its vision projector is downloaded.`
      : issue === 'choose-vision-model'
        ? `${modelName ?? 'The active model'} cannot analyze Replay frames. Choose a vision-capable chat model.`
        : missingModel
          ? `Pick a model yourself, or let Off Grid AI configure one for your ${deviceNoun()}.`
          : missingLocalNetwork
            ? `Allow this ${deviceNoun()} to find and sync directly with your devices.`
            : 'Grant screen and accessibility access so Off Grid AI can see and remember.'
  const presentedProgress = progress ? projectProgress(progress) : null
  const cta =
    progress != null
      ? presentedProgress?.determinate
        ? `Downloading ${Math.round(presentedProgress.percentage ?? 0)}%`
        : 'Downloading'
      : issue === 'missing-projector'
        ? 'Download vision support'
        : issue === 'choose-vision-model'
          ? 'Choose model'
          : missingModel
            ? 'Configure'
            : 'Set up'
  // When Tasks consumes the whole usable workspace, defer this non-blocking
  // prompt. In split mode, keep it wholly inside Chat and away from native
  // browser content.
  const currentTaskLeft = taskWorkspaceOpen ? taskLeft : null
  if (currentTaskLeft !== null && currentTaskLeft < 520) return null

  const ease = [0.16, 1, 0.3, 1] as const
  const percent = presentedProgress?.determinate ? (presentedProgress.percentage ?? 0) : null

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 16, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, filter: 'blur(6px)' }}
      transition={{ duration: reduceMotion ? 0 : 0.4, ease }}
      className="fixed bottom-14 z-50 flex max-w-[min(560px,calc(100vw-2rem))] items-center gap-4 rounded-xl border border-green-500/30 bg-background/95 px-5 py-4 text-foreground shadow-xl backdrop-blur-xl"
      style={{ right: currentTaskLeft === null ? 16 : window.innerWidth - currentTaskLeft + 16 }}
    >
      <Cpu className="h-4 w-4 shrink-0 text-green-500" />
      <div className="min-w-0 flex-1 text-xs leading-snug">
        <div className="font-medium text-foreground">{title}</div>
        <div className="mt-0.5 text-muted-foreground">{detail}</div>
        <AnimatePresence initial={false}>
          {failure ? (
            <motion.div
              key="failure"
              role="status"
              className="mt-1 text-red-400"
              initial={reduceMotion ? false : { opacity: 0, y: 4, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease }}
            >
              {failure}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {presentedProgress ? (
            <motion.div
              key="progress"
              className="overflow-hidden"
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.4, ease }}
            >
              <Progress
                aria-label="Vision support download progress"
                value={percent}
                className="mt-2"
              >
                <ProgressTrack>
                  <ProgressIndicator />
                </ProgressTrack>
              </Progress>
              <div className="mt-1.5 tabular-nums text-muted-foreground">
                {presentedProgress.totalBytes !== undefined
                  ? `${formatStorageBytes(presentedProgress.currentBytes)} / ${formatStorageBytes(presentedProgress.totalBytes)}`
                  : 'Total size unavailable'}
                {presentedProgress.bytesPerSecond !== undefined
                  ? ` · ${formatTransferSpeed(presentedProgress.bytesPerSecond)}`
                  : ''}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onOpen}
        disabled={progress != null}
        className="shrink-0 whitespace-nowrap"
      >
        <TextMorph as="span">{cta}</TextMorph>
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </motion.div>
  )
}

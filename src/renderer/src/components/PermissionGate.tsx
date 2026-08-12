import { useState, useEffect, useCallback } from 'react'
import { motion } from 'motion/react'
import { GridBackdrop } from './ui/grid-backdrop'
import { X, Cpu } from '@phosphor-icons/react'
import { SetupPanel } from './setup/SetupPanel'
import { deviceNoun } from '@renderer/lib/device'
import { PermissionsPanel } from './PermissionsPanel'
import { usePermissionController } from './use-permission-controller'

interface PermissionGateProps {
  children: React.ReactNode
}

type VisionIssue =
  | { kind: 'missing-projector'; modelId: string; modelName: string }
  | { kind: 'choose-vision-model'; modelId: string | null; modelName: string | null }

export function PermissionGate({ children }: PermissionGateProps) {
  const isPro = window.api.isPro === true
  const [modelStatus, setModelStatus] = useState<{ downloaded: boolean; modelsDir: string } | null>(
    null
  )
  // Pro setup is NON-blocking: users go straight into the shell to look around.
  // The detailed setup screen opens on demand; a slim nudge can be dismissed.
  const [showSetup, setShowSetup] = useState(false)
  const [setupDismissed, setSetupDismissed] = useState(false)
  const [visionIssue, setVisionIssue] = useState<VisionIssue | null>(null)
  const [visionDownloadPercent, setVisionDownloadPercent] = useState<number | null>(null)
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
      const [activeId, statuses, capture] = await Promise.all([
        window.api.getActiveModel?.(),
        window.api.getModelVisionStatus?.(),
        window.api.proInvoke('capture:status')
      ])
      const status = capture as
        | { running?: boolean; paused?: boolean; visionReady?: boolean }
        | undefined
      if (!status?.running || status.paused || status.visionReady) {
        setVisionIssue(null)
        return
      }
      const activeStatus = activeId ? statuses?.[activeId] : undefined
      if (activeId && activeStatus?.supportsVision && !activeStatus.projectorInstalled) {
        setVisionIssue({
          kind: 'missing-projector',
          modelId: activeId,
          modelName: activeId.split('/').pop() ?? activeId
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
        modelName: activeId ? (activeId.split('/').pop() ?? activeId) : null
      })
    } catch (error) {
      console.error('Failed to check capture vision readiness:', error)
    }
  }, [isPro])

  // Initial check
  useEffect(() => {
    checkModelStatus()
    void checkCaptureVision()
  }, [checkModelStatus, checkCaptureVision])

  useEffect(() => {
    if (!isPro) return
    const offCapture = window.api.proOn?.('capture:changed', () => void checkCaptureVision())
    const offProgress = window.api.onModelProgress?.((progress) => {
      if (progress.modelId !== visionIssue?.modelId) return
      if (progress.status === 'completed') {
        setVisionDownloadPercent(null)
        void checkCaptureVision()
      } else if (progress.status === 'failed' || progress.status === 'cancelled') {
        setVisionDownloadPercent(null)
      } else if (progress.percent != null) {
        setVisionDownloadPercent(progress.percent)
      }
    })
    return () => {
      if (typeof offCapture === 'function') offCapture()
      if (typeof offProgress === 'function') offProgress()
    }
  }, [checkCaptureVision, isPro, visionIssue?.modelId])

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
    window.history.replaceState(null, '', '/models')
  }

  const handleVisionAction = (): void => {
    if (visionIssue?.kind === 'missing-projector') {
      setVisionDownloadPercent(0)
      void window.api
        .downloadModel?.(visionIssue.modelId)
        .catch((error) => console.error('Failed to download capture vision support:', error))
        .finally(() => {
          setVisionDownloadPercent(null)
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
        <GridBackdrop className="z-0" />
        <motion.div
          initial={{ opacity: 0, filter: 'blur(10px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="relative z-10 text-center"
        >
          <div className="w-8 h-8 mx-auto mb-4 border-2 border-neutral-700 border-t-neutral-400 rounded-full animate-spin" />
          <p className="text-neutral-500 text-sm">Checking permissions</p>
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
        {!ready && !setupDismissed && (
          <SetupNudge
            missingModel={!modelStatus?.downloaded}
            missingLocalNetwork={isPro && permissionStatus?.localNetwork === false}
            onOpen={() => setShowSetup(true)}
            onDismiss={() => setSetupDismissed(true)}
          />
        )}
        {ready && visionIssue && !setupDismissed && (
          <SetupNudge
            issue={visionIssue.kind}
            modelName={visionIssue.modelName}
            progress={visionDownloadPercent}
            onOpen={handleVisionAction}
            onDismiss={() => setSetupDismissed(true)}
          />
        )}
      </>
    )
  }

  // Detailed setup screen — opened on demand from the nudge (no longer a hard wall).
  return (
    <div className="h-screen w-screen bg-neutral-950 fixed inset-0 overflow-hidden">
      <GridBackdrop className="z-0" />
      <button
        onClick={() => setShowSetup(false)}
        className="absolute left-4 top-4 z-20 flex items-center gap-1 text-sm text-neutral-400 transition-colors hover:text-white"
      >
        ← Back to app
      </button>

      <div className="relative z-10 h-full w-full flex flex-col items-center overflow-y-auto py-12 px-8">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="w-full max-w-3xl my-auto"
        >
          {/* Icon */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="flex justify-center mb-8"
          >
            <div className="w-16 h-16 rounded-2xl bg-neutral-900/80 border border-neutral-800 flex items-center justify-center backdrop-blur-xl">
              <Cpu className="w-7 h-7 text-green-500" />
            </div>
          </motion.div>

          {/* Title */}
          <h1 className="text-center text-3xl md:text-4xl font-light tracking-tight text-white mb-3">
            Set up your local AI
          </h1>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="text-center text-neutral-500 text-sm mb-10 max-w-xs mx-auto leading-relaxed"
          >
            {isPro
              ? 'Grant permissions and download a model to get started. Everything runs locally on your device.'
              : 'Download a model to get started. Everything runs locally on your device — no cloud, no account.'}
          </motion.p>

          {/* The model: one-click "Configure for me" + manual browse (shared with
              Settings). On success it flips modelStatus and the gate clears. */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="mb-8"
          >
            <SetupPanel hideHealth onConfigured={checkModelStatus} />
            <div className="mt-3 text-center">
              <button
                onClick={() => {
                  // Drop into the real in-app Models screen (with the left nav). The
                  // app shell (already mounted behind this gate) listens for og:navigate
                  // and switches view — replaceState alone wouldn't re-derive it. Keep
                  // the URL in sync, then dismiss the gate.
                  openModels()
                  setSetupDismissed(true)
                  setShowSetup(false)
                }}
                className="text-xs text-neutral-500 underline-offset-2 transition-colors hover:text-neutral-300 hover:underline"
              >
                or browse &amp; pick a model yourself
              </button>
            </div>
          </motion.div>

          {/* What you get — gives the screen substance and sells the local stack. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.75, duration: 0.4 }}
            className="mb-2 flex flex-col items-center gap-2"
          >
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-neutral-400">
              {['Chat', 'Vision', 'Images', 'Voice', 'Speech'].map((c) => (
                <span key={c} className="flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-green-500" />
                  {c}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-neutral-600">
              One app · every open model · all on your device
            </p>
          </motion.div>

          {/* System permissions - Pro only. The same panel is always reachable in Settings. */}
          {isPro && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8, duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="mb-8"
            >
              <div className="mb-3 text-[10px] font-medium uppercase tracking-widest text-neutral-600">
                System permissions
              </div>
              <PermissionsPanel controller={permissions} />
            </motion.div>
          )}
        </motion.div>
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
  onOpen,
  onDismiss
}: {
  missingModel?: boolean
  missingLocalNetwork?: boolean
  issue?: VisionIssue['kind']
  modelName?: string | null
  progress?: number | null
  onOpen: () => void
  onDismiss: () => void
}) {
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
          ? `Pick a model yourself, or let Off Grid configure one for your ${deviceNoun()}.`
          : missingLocalNetwork
            ? 'Allow this Mac to find and sync directly with your devices.'
            : 'Grant screen and accessibility access so Off Grid can see and remember.'
  const cta =
    progress != null
      ? `Downloading ${String(progress)}%`
      : issue === 'missing-projector'
        ? 'Download vision support'
        : issue === 'choose-vision-model'
          ? 'Choose model'
          : missingModel
            ? 'Configure'
            : 'Set up'
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
      className="fixed bottom-14 right-4 z-50 flex items-center gap-3 rounded-xl border border-green-500/30 bg-neutral-900/95 px-4 py-3 shadow-xl backdrop-blur-xl"
    >
      <Cpu className="h-4 w-4 shrink-0 text-green-500" />
      <div className="text-xs leading-tight">
        <div className="font-medium text-white">{title}</div>
        <div className="text-neutral-500">{detail}</div>
      </div>
      <button
        onClick={onOpen}
        disabled={progress != null}
        className="ml-1 whitespace-nowrap rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
      >
        {cta}
      </button>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="rounded-md p-1 text-neutral-500 transition-colors hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  )
}

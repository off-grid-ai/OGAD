import { useEffect, useState } from 'react'
import { persistToggle } from '@renderer/lib/persist-toggle'
import { ArrowsClockwise, ClockCounterClockwise, DownloadSimple } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { IconTip } from './IconTip'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { formatStorageBytes } from './setup/storage-format'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { LiveStatus, SettingRow } from '@offgrid/operator-ui/operator/presence'
import {
  Progress,
  ProgressIndicator,
  ProgressTrack
} from '@offgrid/operator-ui/operator/coss/progress'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { Skeleton } from '@offgrid/operator-ui/operator/coss/skeleton'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { AnimatePresence, motion } from 'motion/react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

interface PreviousVersion {
  version: string
  channel: 'stable' | 'nightly'
  publishedAt: string | null
}

interface UpdateProgress {
  transferred: number
  total: number
  bytesPerSecond: number
  percent: number
  status: 'downloading' | 'completed' | 'failed'
  version: string | null
  error?: string
}

function releaseDate(value: string | null): string {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

type PreviousVersionsPanelProps = Readonly<{
  loading: boolean
  error: string
  releases: PreviousVersion[]
  onSelect: (release: PreviousVersion) => void
}>

function PreviousVersionsPanel({
  loading,
  error,
  releases,
  onSelect
}: PreviousVersionsPanelProps): React.ReactElement {
  return (
    <Section className="mt-3" label="Signed releases for this device">
      {loading ? (
        <div className="space-y-2 px-3 py-3" aria-busy="true">
          <p className="sr-only">Loading...</p>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : null}
      {error ? <p className="px-3 py-3 text-xs text-red-400">{error}</p> : null}
      {!loading && !error && releases.length === 0 ? (
        <p className="px-3 py-3 text-xs text-neutral-500">
          No compatible previous versions were found.
        </p>
      ) : null}
      <div className="max-h-52 divide-y divide-neutral-900 overflow-y-auto">
        <AnimatePresence initial={false}>
          {releases.map((release) => (
            <motion.div
              key={release.version}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <ListRow
                title={`v${release.version}`}
                description={`${release.channel === 'nightly' ? 'Nightly' : 'Stable'} · ${releaseDate(release.publishedAt)}`}
                actions={
                  <IconTip label={`Use v${release.version}`}>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Use v${release.version}`}
                      onClick={() => onSelect(release)}
                    >
                      <DownloadSimple />
                    </Button>
                  </IconTip>
                }
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Section>
  )
}

type RollbackDialogProps = Readonly<{
  currentVersion: string
  selected: PreviousVersion | null
  downloading: boolean
  onClose: () => void
  onDownload: () => void
}>

function RollbackDialog({
  currentVersion,
  selected,
  downloading,
  onClose,
  onDownload
}: RollbackDialogProps): React.ReactElement {
  return (
    <Dialog open={selected !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="rounded-none border-neutral-700 bg-neutral-950 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Install v{selected?.version}?</DialogTitle>
          <DialogDescription className="leading-relaxed">
            This changes the app version, not your data. Data written by v{currentVersion} may not
            open correctly in v{selected?.version}. Automatic updates will be turned off so this
            version stays installed. The download waits for you to restart.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={onDownload} disabled={downloading}>
            <TextMorph as="span">
              {downloading ? 'Starting download...' : `Download v${selected?.version}`}
            </TextMorph>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SoftwareUpdateSection(): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).api
  const [auto, setAuto] = useState(true)
  const [beta, setBeta] = useState(false)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [status, setStatus] = useState('')
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [skippedVersion, setSkippedVersion] = useState<string | null>(null)
  const [historyVisible, setHistoryVisible] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [history, setHistory] = useState<PreviousVersion[]>([])
  const [historyError, setHistoryError] = useState('')
  const [selectedVersion, setSelectedVersion] = useState<PreviousVersion | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<UpdateProgress | null>(null)

  useEffect(() => {
    api
      .updateGetPrefs?.()
      .then(
        (prefs: {
          currentVersion?: string
          auto?: boolean
          channel?: string
          skippedVersion?: string | null
        }) => {
          setVersion(prefs.currentVersion ?? '')
          setAuto(prefs.auto !== false)
          setBeta(prefs.channel === 'beta')
          setSkippedVersion(prefs.skippedVersion ?? null)
        }
      )
      .catch(() => {})
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  useEffect(() => {
    void api.updateDownloadProgress?.().then((progress: UpdateProgress | null) => {
      if (progress) setDownloadProgress(progress)
    })
    const stop = api.onUpdateDownloadProgress?.((progress: UpdateProgress) => {
      setDownloadProgress(progress)
    })
    return () => {
      if (typeof stop === 'function') stop()
    }
  }, [api])

  const toggle = (): void => {
    const next = !auto
    void persistToggle(next, auto, setAuto, (value) => api.updateSetAuto?.(value))
    setStatus(
      next
        ? 'Automatic updates on. New versions download in the background and install when you quit.'
        : 'Automatic updates off. Nothing downloads or installs until you choose it.'
    )
  }

  const toggleBeta = (): void => {
    const next = !beta
    void persistToggle(next, beta, setBeta, () => api.updateSetChannel?.(next ? 'beta' : 'stable'))
    setStatus(
      next
        ? 'Switched to nightly builds. These ship on every change and are pre-release. Turn this off to return to stable.'
        : 'Back on stable builds. You will move to the latest stable version on the next check.'
    )
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    setAvailableVersion(null)
    setStatus('Checking for updates...')
    try {
      const result = await api.checkForUpdates?.()
      if (!result) setStatus('Could not check right now.')
      else if (result.status === 'available') {
        setAvailableVersion(result.downloadStarted ? null : result.version)
        setStatus(
          result.downloadStarted
            ? `Update ${result.version} found. Downloading in the background.`
            : `Update ${result.version} is available.`
        )
      } else if (result.status === 'not-available')
        setStatus(`You're on the latest version (v${result.version}).`)
      else if (result.status === 'skipped') setStatus(`Skipped v${result.version}.`)
      else setStatus(`Could not check: ${result.error}`)
    } catch {
      setStatus('Could not check right now.')
    } finally {
      setChecking(false)
    }
  }

  const download = async (): Promise<void> => {
    if (!availableVersion) return
    setDownloading(true)
    try {
      await api.updateDownload?.(availableVersion)
      setStatus(`Downloading ${availableVersion} in the background.`)
      setAvailableVersion(null)
      setSkippedVersion(null)
    } catch {
      setStatus('Could not start the download. Check again and retry.')
    } finally {
      setDownloading(false)
    }
  }

  const skip = async (): Promise<void> => {
    if (!availableVersion) return
    try {
      const skipped = await api.updateSkipVersion?.(availableVersion)
      setSkippedVersion(skipped ?? availableVersion)
      setStatus(`Skipped v${availableVersion}.`)
      setAvailableVersion(null)
    } catch {
      setStatus('Could not skip this version.')
    }
  }

  const clearSkipped = async (): Promise<void> => {
    await api.updateClearSkippedVersion?.()
    setSkippedVersion(null)
    setStatus('Skipped version cleared. Check again when you are ready.')
  }

  const toggleHistory = async (): Promise<void> => {
    if (historyVisible) {
      setHistoryVisible(false)
      return
    }
    setHistoryVisible(true)
    setHistoryLoading(true)
    setHistoryError('')
    try {
      setHistory((await api.updateListVersions?.()) ?? [])
    } catch {
      setHistoryError('Could not load previous versions. Check your connection and retry.')
    } finally {
      setHistoryLoading(false)
    }
  }

  const downloadPrevious = async (): Promise<void> => {
    if (!selectedVersion) return
    setDownloading(true)
    try {
      await api.updateDownloadVersion?.(selectedVersion.version)
      setAuto(false)
      setAvailableVersion(null)
      setStatus(`Downloading v${selectedVersion.version}. Restart when the update banner appears.`)
      setSelectedVersion(null)
    } catch {
      setStatus('Could not start that version download. Reload the list and retry.')
    } finally {
      setDownloading(false)
    }
  }

  const presentedProgress = downloadProgress
    ? projectProgress({
        currentBytes: downloadProgress.transferred,
        totalBytes: downloadProgress.total,
        bytesPerSecond: downloadProgress.bytesPerSecond,
        percent: downloadProgress.percent,
        status: downloadProgress.status
      })
    : null

  return (
    <div>
      <div className="divide-y divide-neutral-800">
        <SettingRow
          title="Automatic updates"
          description="Off Grid AI Desktop checks for updates in the background and installs them when you quit. Turn this off to update only when you choose."
          className="pt-0"
          toggle={<Switch aria-label="Automatic updates" checked={auto} onCheckedChange={toggle} />}
        />
        <SettingRow
          title="Nightly builds"
          description="Get nightly builds. New features land here first, on every change, before they reach stable. These are pre-release - expect rough edges. Off by default."
          toggle={
            <Switch aria-label="Nightly builds" checked={beta} onCheckedChange={toggleBeta} />
          }
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <IconTip label={checking ? 'Checking...' : 'Check for updates'}>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={checking ? 'Checking...' : 'Check for updates'}
            aria-busy={checking || undefined}
            onClick={() => void check()}
            disabled={checking}
          >
            <ArrowsClockwise className={checking ? 'animate-spin' : undefined} />
          </Button>
        </IconTip>
        <IconTip label={historyVisible ? 'Hide previous versions' : 'Previous versions'}>
          <Button
            size="icon-xs"
            variant={historyVisible ? 'secondary' : 'ghost'}
            aria-label={historyVisible ? 'Hide previous versions' : 'Previous versions'}
            aria-expanded={historyVisible}
            onClick={() => void toggleHistory()}
          >
            <ClockCounterClockwise />
          </Button>
        </IconTip>
        {version && <span className="text-xs text-neutral-600">Current: v{version}</span>}
      </div>
      {availableVersion ? (
        <div className="mt-3 flex items-center gap-2">
          <Button size="xs" onClick={() => void download()} disabled={downloading}>
            <TextMorph as="span">
              {downloading ? 'Starting download...' : `Download ${availableVersion}`}
            </TextMorph>
          </Button>
          <Button size="xs" variant="outline" onClick={() => void skip()}>
            Skip {availableVersion}
          </Button>
        </div>
      ) : null}
      {skippedVersion ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500">
          <span>Skipped v{skippedVersion}</span>
          <Button size="xs" variant="ghost" onClick={() => void clearSkipped()}>
            Allow again
          </Button>
        </div>
      ) : null}
      {historyVisible ? (
        <PreviousVersionsPanel
          loading={historyLoading}
          error={historyError}
          releases={history}
          onSelect={setSelectedVersion}
        />
      ) : null}
      {status && <LiveStatus className="mt-2 text-xs text-neutral-500">{status}</LiveStatus>}
      {downloadProgress && downloadProgress.status !== 'failed' ? (
        <div className="mt-3 border border-neutral-800 bg-neutral-950/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-xs text-neutral-400">
            <span>
              {downloadProgress.status === 'completed'
                ? `v${downloadProgress.version ?? ''} ready to install`
                : `Downloading v${downloadProgress.version ?? ''}`}
            </span>
            <span className="tabular-nums">
              {presentedProgress?.determinate ? (
                <>
                  <AnimatedNumber value={Math.round(presentedProgress.percentage ?? 0)} />%
                </>
              ) : (
                <TextShimmer as="span">Downloading</TextShimmer>
              )}
            </span>
          </div>
          <Progress
            aria-label="Update download progress"
            value={presentedProgress?.percentage ?? 0}
            className="mt-2"
          >
            <ProgressTrack className="h-1 rounded-none bg-neutral-800">
              <ProgressIndicator className="bg-emerald-500 duration-150" />
            </ProgressTrack>
          </Progress>
          <div className="mt-1.5 text-[11px] tabular-nums text-neutral-600">
            {presentedProgress?.totalBytes !== undefined
              ? `${formatStorageBytes(presentedProgress.currentBytes)} / ${formatStorageBytes(presentedProgress.totalBytes)}`
              : 'Total size unavailable'}
            {presentedProgress?.bytesPerSecond !== undefined
              ? ` · ${formatTransferSpeed(presentedProgress.bytesPerSecond)}`
              : ''}
          </div>
        </div>
      ) : downloadProgress?.status === 'failed' ? (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {downloadProgress.error ?? 'The update download failed. Check your connection and retry.'}
        </p>
      ) : null}

      <RollbackDialog
        currentVersion={version}
        selected={selectedVersion}
        downloading={downloading}
        onClose={() => setSelectedVersion(null)}
        onDownload={() => void downloadPrevious()}
      />
    </div>
  )
}

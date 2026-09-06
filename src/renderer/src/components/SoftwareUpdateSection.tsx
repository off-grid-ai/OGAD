import { useEffect, useState } from 'react'
import { persistToggle } from '@renderer/lib/persist-toggle'
import { Button } from './ui/button'
import { projectProgress } from '@offgrid/ui'
import { downloadProgressSummary } from '@renderer/lib/download-progress'
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
    <div className="mt-3 border border-neutral-800 bg-neutral-950/40">
      <div className="border-b border-neutral-800 px-3 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
        Signed releases for this device
      </div>
      {loading ? <p className="px-3 py-3 text-xs text-neutral-500">Loading...</p> : null}
      {error ? <p className="px-3 py-3 text-xs text-red-400">{error}</p> : null}
      {!loading && !error && releases.length === 0 ? (
        <p className="px-3 py-3 text-xs text-neutral-500">
          No compatible previous versions were found.
        </p>
      ) : null}
      <div className="max-h-52 overflow-y-auto divide-y divide-neutral-800">
        {releases.map((release) => (
          <div
            key={release.version}
            className="flex items-center justify-between gap-4 px-3 py-2 transition-colors duration-150 hover:bg-neutral-900/70"
          >
            <div className="min-w-0">
              <div className="text-xs text-neutral-200">v{release.version}</div>
              <div className="text-[11px] text-neutral-600">
                {release.channel === 'nightly' ? 'Nightly' : 'Stable'} ·{' '}
                {releaseDate(release.publishedAt)}
              </div>
            </div>
            <Button size="xs" variant="outline" onClick={() => onSelect(release)}>
              Use v{release.version}
            </Button>
          </div>
        ))}
      </div>
    </div>
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
            {downloading ? 'Starting download...' : `Download v${selected?.version}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SoftwareUpdateSection(): React.ReactElement {
  const api = window.api
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
      .updateGetPrefs()
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
    void api.updateDownloadProgress().then((progress: UpdateProgress | null) => {
      if (progress) setDownloadProgress(progress)
    })
    const stop = api.onUpdateDownloadProgress((progress: UpdateProgress) => {
      setDownloadProgress(progress)
    })
    return () => {
      if (typeof stop === 'function') stop()
    }
  }, [api])

  const toggle = (): void => {
    const next = !auto
    void persistToggle(next, auto, setAuto, (value) => api.updateSetAuto(value))
    setStatus(
      next
        ? 'Automatic updates on. New versions download in the background and install when you quit.'
        : 'Automatic updates off. Nothing downloads or installs until you choose it.'
    )
  }

  const toggleBeta = (): void => {
    const next = !beta
    void persistToggle(next, beta, setBeta, () => api.updateSetChannel(next ? 'beta' : 'stable'))
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
      const result = await api.checkForUpdates()
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
      await api.updateDownload(availableVersion)
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
      const skipped = await api.updateSkipVersion(availableVersion)
      setSkippedVersion(skipped ?? availableVersion)
      setStatus(`Skipped v${availableVersion}.`)
      setAvailableVersion(null)
    } catch {
      setStatus('Could not skip this version.')
    }
  }

  const clearSkipped = async (): Promise<void> => {
    await api.updateClearSkippedVersion()
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
      setHistory((await api.updateListVersions()) ?? [])
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
      await api.updateDownloadVersion(selectedVersion.version)
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
  const progressSummary = presentedProgress ? downloadProgressSummary(presentedProgress) : null

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-neutral-500">
          Off Grid AI Desktop checks for updates in the background and installs them when you quit.
          Turn this off to update only when you choose.
        </p>
        <button
          type="button"
          onClick={toggle}
          role="switch"
          aria-label="Automatic updates"
          aria-checked={auto}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${auto ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${auto ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <div className="mt-4 flex items-start justify-between gap-4 border-t border-neutral-800 pt-4">
        <p className="text-sm text-neutral-500">
          Get nightly builds. New features land here first, on every change, before they reach
          stable. These are pre-release - expect rough edges. Off by default.
        </p>
        <button
          type="button"
          onClick={toggleBeta}
          role="switch"
          aria-label="Nightly builds"
          aria-checked={beta}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${beta ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${beta ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" onClick={() => void check()} disabled={checking}>
          {checking ? 'Checking...' : 'Check for updates'}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void toggleHistory()}>
          {historyVisible ? 'Hide previous versions' : 'Previous versions'}
        </Button>
        {version && <span className="text-xs text-neutral-600">Current: v{version}</span>}
      </div>
      {availableVersion ? (
        <div className="mt-3 flex items-center gap-2">
          <Button size="xs" onClick={() => void download()} disabled={downloading}>
            {downloading ? 'Starting download...' : `Download ${availableVersion}`}
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
      {status && (
        <p className="mt-2 text-xs text-neutral-500" aria-live="polite">
          {status}
        </p>
      )}
      {downloadProgress && downloadProgress.status !== 'failed' ? (
        <div className="mt-3 border border-neutral-800 bg-neutral-950/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3 text-xs text-neutral-400">
            <span>
              {downloadProgress.status === 'completed'
                ? `v${downloadProgress.version ?? ''} ready to install`
                : `Downloading v${downloadProgress.version ?? ''}`}
            </span>
            <span className="tabular-nums">
              {presentedProgress?.determinate
                ? `${Math.round(presentedProgress.percentage ?? 0)}%`
                : 'Downloading'}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden bg-neutral-800">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${presentedProgress?.percentage ?? 0}%` }}
            />
          </div>
          <div className="mt-1.5 text-[11px] tabular-nums text-neutral-600">
            {progressSummary ? `${progressSummary.bytes} · ${progressSummary.rate}` : null}
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

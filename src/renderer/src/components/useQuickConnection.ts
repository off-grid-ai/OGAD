import { useCallback, useEffect, useRef, useState } from 'react'

export const CONNECTIONS_CHANGED_EVENT = 'offgrid:connections-changed'

export interface QuickConnectionEntry {
  id: string
  name: string
  url: string
  /** Create a separate account instead of reusing a provider connection. */
  newAccount?: boolean
}

export interface QuickConnectionRecord {
  id: number
  name: string
  url: string | null
  status: string
  enabled: number
}

interface Attempt {
  cancelled: boolean
  id?: number
  created: boolean
}

/** Owns user-initiated sign-in and cleans up incomplete connections. */
interface QuickConnectionState {
  items: QuickConnectionRecord[]
  loading: boolean
  busy: string | null
  errors: Record<string, string>
  connect: (
    entry: QuickConnectionEntry,
    prepare?: (id: number, created: boolean) => Promise<void>,
    finish?: (id: number) => Promise<number>
  ) => Promise<void>
  cancel: () => Promise<void>
  reload: () => Promise<void>
  recordFor: (entry: QuickConnectionEntry) => QuickConnectionRecord | undefined
}
const wasCancelled = (attempt: Attempt): boolean => attempt.cancelled

export function useQuickConnection(onBusyChange?: (busy: boolean) => void): QuickConnectionState {
  const [items, setItems] = useState<QuickConnectionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const active = useRef<Attempt | null>(null)
  const mounted = useRef(false)
  const onBusy = useRef(onBusyChange)
  onBusy.current = onBusyChange

  const reload = useCallback(async () => {
    try {
      const rows = (await window.api.mcpList()) as QuickConnectionRecord[]
      if (mounted.current) {
        setItems(rows)
        setErrors((previous) => ({ ...previous, load: '' }))
      }
    } catch {
      if (mounted.current)
        setErrors((previous) => ({ ...previous, load: 'Could not load connections. Try again.' }))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  const cancel = useCallback(async () => {
    const attempt = active.current
    if (!attempt) return
    attempt.cancelled = true
    if (attempt.id != null) {
      await window.api.mcpCancel(attempt.id)
      if (attempt.created) await window.api.mcpRemove(attempt.id)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void reload()
    const changed = (): void => {
      void reload()
    }
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, changed)
    return () => {
      mounted.current = false
      window.removeEventListener(CONNECTIONS_CHANGED_EVENT, changed)
      void cancel().catch(() => {})
      onBusy.current?.(false)
    }
  }, [reload, cancel])

  const connect = async (
    entry: QuickConnectionEntry,
    prepare?: (id: number, created: boolean) => Promise<void>,
    finish?: (id: number) => Promise<number>
  ): Promise<void> => {
    if (active.current) return
    const attempt: Attempt = { cancelled: false, created: false }
    active.current = attempt
    setBusy(entry.id)
    onBusy.current?.(true)
    setErrors((previous) => ({ ...previous, [entry.id]: '' }))
    try {
      // Read current state rather than a stale rendered list before creating a record.
      const current = (await window.api.mcpList()) as QuickConnectionRecord[]
      const existing = entry.newAccount ? undefined : current.find((item) => item.url === entry.url)
      if (wasCancelled(attempt)) return
      attempt.id =
        existing?.id ??
        (await window.api.mcpAdd({
          name: entry.name,
          transport: 'http',
          url: entry.url,
          liveOnly: true
        }))
      attempt.created = !existing
      if (!Number.isInteger(attempt.id) || !attempt.id || attempt.id < 1)
        throw new Error('Could not create the connection. Try again.')
      if (wasCancelled(attempt)) return
      await prepare?.(attempt.id!, attempt.created)
      if (wasCancelled(attempt)) return
      const result = (await window.api.mcpTest(attempt.id!)) as { ok: boolean; error?: string }
      if (wasCancelled(attempt)) return
      if (!result.ok) throw new Error(result.error || 'Could not connect. Try again.')
      if (finish) {
        attempt.id = await finish(attempt.id!)
        attempt.created = false
      }
      await window.api.mcpSetEnabled(attempt.id!, true)
      attempt.created = false
    } catch (error) {
      if (!attempt.cancelled && mounted.current) {
        setErrors((previous) => ({
          ...previous,
          [entry.id]: error instanceof Error ? error.message : 'Could not connect. Try again.'
        }))
      }
    } finally {
      if (attempt.created && attempt.id != null)
        await window.api.mcpRemove(attempt.id).catch(() => {})
      active.current = null
      if (mounted.current) setBusy(null)
      onBusy.current?.(false)
      window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT))
    }
  }

  const recordFor = (entry: QuickConnectionEntry): QuickConnectionRecord | undefined =>
    items.find((item) => item.url === entry.url)
  return { items, loading, busy, errors, connect, cancel, reload, recordFor }
}

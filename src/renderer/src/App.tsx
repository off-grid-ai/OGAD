import { ChatList } from './components/ChatList'
import { ChatDetail } from './components/ChatDetail'
import { CommandPalette } from './components/CommandPalette'
import logo from './assets/logo.png'
import { useMeetingRecorder } from './useMeetingRecorder'
import { MemoryChat } from './components/MemoryChat'
import { ExploreScreen } from './components/explore/ExploreScreen'
import type { DemoPreset } from './components/explore/presetCatalog'
import { Settings, SETTINGS_DESTINATIONS } from './components/Settings'
import { SettingsPanel } from './components/SettingsPanel'
import { ModelsScreen } from './components/ModelsScreen'
import { ProjectsScreen } from './components/ProjectsScreen'
import { ConnectorsScreen } from './components/ConnectorsScreen'
import { GatewayScreen } from './components/GatewayScreen'
import { Onboarding } from './components/Onboarding'
import { PermissionGate } from './components/PermissionGate'
import type { SearchHit } from './types'
// Open-core: pro screens live in the private pro package and render through the
// pro view-router; the free build shows the UpgradeScreen for those tabs.
import {
  clearProFeaturesRenderer,
  loadProFeaturesRenderer,
  type ProRendererActivation
} from './bootstrap/loadProFeaturesRenderer'
import { RendererEntitlementProvider } from './bootstrap/RendererEntitlementProvider'
import { shouldRemovePaidRendererAccess } from './bootstrap/entitlementRegistry'
import { useRendererEntitlement } from './bootstrap/useRendererEntitlement'
import { renderProView, type ProViewContext } from './bootstrap/proView'
import { UpgradeScreen } from './components/pro/UpgradeScreen'
import { getProFeature, proFeatureComingSoon } from './components/pro/proCatalog'
import { currentPlatform, isMac } from './lib/device'
import { NotificationProvider } from './hooks/NotificationProvider'
import { useNotifications } from './hooks/useNotifications'
import { ToastProvider } from './hooks/ToastProvider'
import { ReprocessingProvider, useReprocessing } from './hooks/useReprocessing'
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { GridBackdrop } from './components/ui/grid-backdrop'
import { StarfieldBackdrop } from './components/ui/starfield-backdrop'
import { Sidebar, SidebarBody } from './components/ui/sidebar'
import { NavThemeToggle } from './components/ThemeToggle'
import { motion, AnimatePresence } from 'motion/react'
import {
  IconMessageCircle,
  IconCompass,
  IconSettings,
  IconDownload,
  IconFolders,
  IconPlug,
  IconServer2,
  IconLock,
  IconLoader2,
  IconArrowLeft,
  IconArrowRight,
  IconActivityHeartbeat,
  IconDeviceMobile,
  IconListCheck,
  IconExternalLink,
  IconSparkles,
  IconBriefcase,
  IconShieldLock,
  IconTool
} from '@tabler/icons-react'
import { OFF_GRID_MOBILE_URL, openExternal } from './constants/links'
import { cn } from './lib/utils'
import { normalizeProNavigationIntent, type ProNavigationIntent } from './lib/pro-navigation'
import { navigateSearchHit } from './lib/search-navigation'
import { internalTabPaletteScreens } from './lib/paletteScreens'
import { getSlot, SLOTS } from './bootstrap/slotRegistry'
import { SidebarNavigationMenu } from './components/navigation/SidebarNavigationMenu'
import { CHAT_VIEW, setCurrentView } from './lib/current-view'
import {
  OPEN_MODEL_SETTINGS_PANEL_EVENT,
  type ModelSettingsPanelTab
} from './lib/model-settings-panel'
import { callHook } from './bootstrap/hookRegistry'
import { internalTabLocation, internalTabPath, isInternalTabView } from './lib/internal-tab-route'
import {
  NOTIFICATION_OPEN_TARGET_CHANNEL,
  NOTIFICATION_RESOLVE_TARGET_HOOK,
  NOTIFICATION_SUBSCRIBE_EXTERNAL_ITEMS_HOOK,
  NOTIFICATION_SUBSCRIBE_EXTERNAL_UNREAD_HOOK,
  type NotificationExternalItemSubscriber,
  type NotificationExternalUnreadSubscriber
} from './lib/notification-hooks'

type ViewMode =
  | 'dashboard'
  | 'explore'
  | 'day'
  | 'replay'
  | 'reflect'
  | 'actions'
  | 'connectors'
  | 'meetings'
  | 'chats'
  | 'memories'
  | 'entities'
  | 'memory-chat'
  | 'tasks'
  | 'models'
  | 'gateway'
  | 'projects'
  | 'notifications'
  | 'settings'
  | 'search'
  | 'clipboard'
  | 'voice'
  | 'vault'
  | 'devices'

interface NavigationIntent {
  view: ViewMode
  section?: string
  subroute?: string
  conversationId?: string
  draftPrompt?: string
}

// Navigation state type for history tracking
interface NavigationState {
  viewMode: ViewMode
  subroute: string | null
  settingsSection: string | null
  selectedSessionId: string | null
  selectedMemoryId: number | null
  selectedEntityId: number | null
  selectedProjectId: string | null
}

function ReprocessingBanner() {
  const { reprocessing, progress } = useReprocessing()
  if (!reprocessing) return null

  const pct =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-neutral-900/90 backdrop-blur-sm border-b border-neutral-800 px-4 py-2 flex items-center gap-3"
    >
      <motion.div
        className="w-3.5 h-3.5 border-2 border-neutral-400 border-t-transparent rounded-full shrink-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      />
      <span className="text-sm text-neutral-400 flex-1 min-w-0 truncate">
        {progress?.phase === 'cleared'
          ? 'Data cleared. Rebuilding memories and entities...'
          : progress
            ? `Reprocessing session ${progress.processed} of ${progress.total}...`
            : 'Reprocessing sessions...'}
      </span>
      {progress && progress.total > 0 && (
        <div className="w-24 h-1.5 bg-neutral-800 rounded-full overflow-hidden shrink-0">
          <motion.div
            className="h-full bg-neutral-500 rounded-full"
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      )}
      {progress && progress.total > 0 && (
        <span className="text-xs text-neutral-600 shrink-0">{pct}%</span>
      )}
    </motion.div>
  )
}

// One rule for the look of EVERY sidebar row - nav items, the model-status row, the mobile-app
// link. The Tailwind palette is remapped onto the theme-aware --og-* tokens in assets/main.css,
// so these classes already flip with data-theme and no `dark:` variant belongs here: `dark:` is
// Tailwind's own prefers-color-scheme media query, a SECOND source of truth for the theme that
// disagrees with data-theme whenever the app theme and the OS theme differ.
// The tell that made this visible: neutral-900 is a SURFACE token here (#f5f5f5 in light), not a
// text token, so `hover:text-neutral-900` painted the label near-white on a near-white row.
const navRowClass = (expanded: boolean, active = false): string =>
  cn(
    'group/nav relative flex items-center gap-3 rounded-lg py-2 text-sm transition-colors',
    expanded ? 'px-3' : 'justify-center px-0',
    active
      ? 'bg-green-500/10 text-emerald-400'
      : 'text-neutral-400 hover:bg-neutral-500/10 hover:text-white'
  )

// Model-server health dot for the sidebar. Uses the same authoritative chat probe
// as the full System Health panel, through a narrow IPC projection that does not
// re-check permissions, the gateway, image generation, and native helpers every
// five seconds. Green = running, amber = starting, red = stopped.
type ChatHealth = 'ready' | 'starting' | 'down' | null
function ModelStatusDot({
  open,
  onClick
}: {
  open: boolean
  onClick: () => void
}): React.ReactElement {
  const [status, setStatus] = useState<ChatHealth>(null)
  useEffect(() => {
    let live = true
    let refreshInFlight: Promise<void> | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    const applyHealth = (chat: { status?: string } | null | undefined): void => {
      const next: ChatHealth =
        chat?.status === 'ready' ? 'ready' : chat?.status === 'starting' ? 'starting' : 'down'
      if (live) setStatus(next)
    }
    const refresh = (): void => {
      if (refreshInFlight !== null) return
      refreshInFlight = Promise.resolve(api?.chatHealth?.())
        .then(applyHealth)
        .catch(() => {
          if (live) setStatus('down')
        })
        .finally(() => {
          refreshInFlight = null
        })
    }
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    const offChanged = api?.onChatHealthChanged?.(applyHealth)
    refresh()
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    const id = setInterval(refreshWhenVisible, 60_000)
    return () => {
      live = false
      clearInterval(id)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      try {
        offChanged?.()
      } catch {
        /* preload subscription already closed */
      }
    }
  }, [])
  const color =
    status == null
      ? 'text-neutral-500'
      : status === 'ready'
        ? 'text-green-500'
        : status === 'starting'
          ? 'text-amber-500'
          : 'text-red-500'
  const text =
    status == null
      ? 'Checking…'
      : status === 'ready'
        ? 'Model running'
        : status === 'starting'
          ? 'Model starting'
          : 'Model stopped'
  const label =
    status === 'down'
      ? 'Model server stopped. Open Setup and health.'
      : `Model server: ${text.toLowerCase()}. Open Setup and health.`
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={navRowClass(open)}
    >
      <IconActivityHeartbeat className={cn('h-5 w-5 shrink-0', color)} />
      {open && <span className="flex-1 text-left text-xs">{text}</span>}
    </button>
  )
}

function AppContent() {
  const { addNotification, unreadCount } = useNotifications()

  // Main owns entitlement truth. The preload value seeds this renderer, then
  // license:changed keeps it live without a restart.
  const { isPro, setIsPro } = useRendererEntitlement()
  // Re-render once pro renderer features have activated (registers the view-router).
  const [proReady, setProReady] = useState(false)
  const [proActivation, setProActivation] = useState<ProRendererActivation>('none')
  const TaskWorkspace = isPro && proReady ? getSlot(SLOTS.taskWorkspace) : undefined
  // Rendered at the app root, NOT inside the route switch: a running task follows the user across
  // navigation, so a route-scoped mount would unmount it exactly when it is wanted.
  const TaskFloatingView = isPro && proReady ? getSlot(SLOTS.taskFloatingView) : undefined
  const [externalUnreadCount, setExternalUnreadCount] = useState(0)
  useEffect(() => {
    let mounted = true
    void loadProFeaturesRenderer().then((activation) => {
      if (mounted) {
        setProActivation(activation)
        setProReady(true)
      }
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!proReady || !isPro) {
      setExternalUnreadCount(0)
      return
    }
    return callHook<ReturnType<NotificationExternalUnreadSubscriber>>(
      NOTIFICATION_SUBSCRIBE_EXTERNAL_UNREAD_HOOK,
      setExternalUnreadCount
    )
  }, [isPro, proReady])

  useEffect(() => {
    if (!proReady || !isPro) return
    return callHook<ReturnType<NotificationExternalItemSubscriber>>(
      NOTIFICATION_SUBSCRIBE_EXTERNAL_ITEMS_HOOK,
      addNotification
    )
  }, [addNotification, isPro, proReady])

  // Free users land on Models (download a model first, with the sidebar to
  // explore); Mac Pro users land on Day. Never land on a locked or unavailable tab.
  const [viewMode, commitViewMode] = useState<ViewMode>(isPro && isMac() ? 'day' : 'models')
  const [settingsSection, setSettingsSection] = useState<string | null>(null)
  const [settingsNavigationKey, setSettingsNavigationKey] = useState(0)
  const [navigationSubroute, setNavigationSubroute] = useState<string | null>(null)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [modelSettingsTab, setModelSettingsTab] = useState<ModelSettingsPanelTab>('model')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedMemoryId, setSelectedMemoryId] = useState<number | null>(null)
  // Version of a downloaded-and-staged update (null = none). Surfaced as a banner
  // with a "Restart to update" button — Squirrel only applies on a clean quit, so
  // we drive the install explicitly instead of waiting for one.
  const [updateReady, setUpdateReady] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  // Search filter + sort live here (not in the screen) so they survive navigating
  // to a result and back.
  const [searchSources, setSearchSources] = useState<string[]>([])
  const [searchSort, setSearchSort] = useState<'relevance' | 'recency' | 'match'>('relevance')
  const [replayTarget, setReplayTarget] = useState<number | null>(null)
  // A search hit can deep-link to a specific meeting; cleared on leaving Meetings.
  const [meetingTarget, setMeetingTarget] = useState<number | null>(null)
  // Which tab the Actions screen opens on when reached via a Day "View all" link.
  const [actionsMode, setActionsMode] = useState<'todo' | 'approvals' | null>(null)
  const [actionTarget, setActionTarget] = useState<number | null>(null)
  const [approvalTarget, setApprovalTarget] = useState<number | null>(null)
  const [calendarEventTarget, setCalendarEventTarget] = useState<number | null>(null)
  // When set, the Actions to-do list opens filtered to this entity (from clicking
  // a person chip on a to-do — "all to-dos for Ali").
  const [actionsEntity, setActionsEntity] = useState<{ id: number; name: string } | null>(null)
  // Target chat to open in the main Chat screen (from the Projects tab): an
  // existing conversation, or a request to start a new chat scoped to a project.
  const [chatTarget, setChatTarget] = useState<{
    conversationId?: string
    projectId?: string
    openGallery?: boolean
    presetId?: string
    draftPrompt?: string
  } | null>(null)
  // Navigation is unconditional. Leaving a chat with a task running used to prompt, because the
  // live view was lost on the way out; a running task now follows you in a floating card
  // (tasks.floatingView), so there is nothing left to warn about.
  const navigateTo = useCallback((destination: ViewMode, prepare?: () => void): void => {
    setNavigationSubroute(null)
    prepare?.()
    commitViewMode(destination)
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const rec = useMeetingRecorder()

  const setTaskDetailSidebarMode = useCallback((detailOpen: boolean): void => {
    if (detailOpen) setSidebarOpen(false)
  }, [])

  // The meeting recording lifecycle (detect → record → warn → stop → finalize) is
  // owned by the main-process MeetingController. This view just reflects rec.* and
  // offers a stop command — no detection, no timers, no start/stop decisions here.

  // Tell the capture layer which screen is showing, so self-capture can skip the
  // memory-mirror views (Day/Replay/Entities/…) and avoid looping the graph.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window.api as any)?.reportSelfView?.(viewMode)
  }, [viewMode])

  // Navigation history stacks (back and forward)
  const navigationHistory = useRef<NavigationState[]>([])
  const forwardHistory = useRef<NavigationState[]>([])
  const isNavigatingHistory = useRef(false)
  // Reactive mirrors of the stacks so the in-app back/forward buttons can
  // enable/disable (refs alone don't trigger a re-render).
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const syncNavFlags = useCallback(() => {
    setCanGoBack(navigationHistory.current.length > 1)
    setCanGoForward(forwardHistory.current.length > 0)
  }, [])

  const removePaidRendererAccess = useCallback((): void => {
    // Remove capability seams before React changes the route. No paid view,
    // slot, settings section, hook, screen, or nav entry can run after this.
    clearProFeaturesRenderer()
    setIsPro(false)
    setProActivation('none')
    setProReady(true)

    navigationHistory.current = []
    forwardHistory.current = []
    isNavigatingHistory.current = false
    setCanGoBack(false)
    setCanGoForward(false)
    setSettingsSection(null)
    setNavigationSubroute(null)
    setModelSettingsOpen(false)
    setModelSettingsTab('model')
    setSelectedSessionId(null)
    setSelectedMemoryId(null)
    setSelectedEntityId(null)
    setSelectedProjectId(null)
    setSearchQuery('')
    setSearchSources([])
    setSearchSort('relevance')
    setReplayTarget(null)
    setMeetingTarget(null)
    setActionsMode(null)
    setActionTarget(null)
    setApprovalTarget(null)
    setCalendarEventTarget(null)
    setActionsEntity(null)
    setChatTarget(null)
    commitViewMode('day')
  }, [setIsPro])

  useEffect(() => {
    const license = window.api.license
    if (!license || typeof license.onChanged !== 'function') return
    let active = true
    const applyStatus = (info: ProLicenseInfo): void => {
      if (!active || !shouldRemovePaidRendererAccess(info)) return
      removePaidRendererAccess()
    }
    const off = license.onChanged(applyStatus)
    void license
      .status()
      .then(applyStatus)
      .catch(() => {})
    return () => {
      active = false
      off()
    }
  }, [removePaidRendererAccess])

  // Handle browser URL changes
  useEffect(() => {
    const path = window.location.pathname
    const viewMap: Record<string, ViewMode> = {
      '/': 'day',
      '/explore': 'explore',
      '/day': 'day',
      '/replay': 'replay',
      '/reflect': 'reflect',
      '/actions': 'actions',
      '/connectors': 'connectors',
      '/meetings': 'meetings',
      '/chat': CHAT_VIEW,
      '/chats': 'chats',
      '/memories': 'memories',
      '/entities': 'entities',
      '/models': 'models',
      '/gateway': 'gateway',
      '/projects': 'projects',
      '/notifications': 'notifications',
      '/search': 'search',
      '/settings': 'settings',
      '/voice': 'voice',
      '/devices': 'devices'
    }

    const internalTab = internalTabLocation(path)
    if (internalTab) {
      setNavigationSubroute(internalTab.subroute)
      setSettingsSection(null)
      commitViewMode(internalTab.view)
    } else if (path.startsWith('/settings/')) {
      let section: string | null = null
      try {
        section = decodeURIComponent(path.slice('/settings/'.length)) || null
      } catch {
        section = null
      }
      setSettingsSection(section)
      setNavigationSubroute(null)
      commitViewMode('settings')
    } else if (viewMap[path]) {
      setNavigationSubroute(null)
      setSettingsSection(null)
      commitViewMode(viewMap[path])
    }
  }, [])

  // Programmatic navigation from outside the shell (e.g. the first-run gate's
  // "pick a model yourself" CTA) — switch the active view without a remount.
  useEffect(() => {
    const onNav = (e: Event): void => {
      const intent = (e as CustomEvent<unknown>).detail
      if (typeof intent === 'string') {
        navigateTo(intent as ViewMode, () => {
          setSettingsSection(null)
          setNavigationSubroute(null)
        })
        return
      }
      if (!intent || typeof intent !== 'object' || !('view' in intent)) return
      const navigation = intent as NavigationIntent
      navigateTo(navigation.view, () => {
        setSettingsSection(navigation.view === 'settings' ? (navigation.section ?? null) : null)
        if (navigation.view === 'settings') setSettingsNavigationKey((value) => value + 1)
        setNavigationSubroute(
          isInternalTabView(navigation.view) ? (navigation.subroute ?? null) : null
        )
        if (
          navigation.view === 'memory-chat' &&
          (navigation.conversationId || navigation.draftPrompt)
        ) {
          setChatTarget({
            conversationId: navigation.conversationId,
            draftPrompt: navigation.draftPrompt
          })
        }
      })
    }
    window.addEventListener('og:navigate', onNav)
    // Main-driven navigation (tray → a screen).
    const offNav = window.api.onNavigate?.((v: string) => {
      navigateTo(v as ViewMode, () => {
        setNavigationSubroute(null)
        setSettingsSection(null)
      })
    })
    return () => {
      window.removeEventListener('og:navigate', onNav)
      offNav?.()
    }
  }, [navigateTo])

  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ tab?: ModelSettingsPanelTab } | undefined>).detail
      const requestedTab = detail ? detail.tab : undefined
      setModelSettingsTab(requestedTab ?? 'model')
      setModelSettingsOpen(true)
    }
    window.addEventListener(OPEN_MODEL_SETTINGS_PANEL_EVENT, open)
    return () => window.removeEventListener(OPEN_MODEL_SETTINGS_PANEL_EVENT, open)
  }, [])

  // Update browser URL when view mode changes
  useEffect(() => {
    const urlMap: Record<ViewMode, string> = {
      explore: '/explore',
      day: '/day',
      replay: '/replay',
      reflect: '/reflect',
      actions: '/actions',
      connectors: '/connectors',
      meetings: '/meetings',
      dashboard: '/dashboard',
      'memory-chat': '/chat',
      chats: '/chats',
      tasks: '/tasks',
      memories: '/memories',
      entities: '/entities',
      models: '/models',
      gateway: '/gateway',
      projects: '/projects',
      notifications: '/notifications',
      search: '/search',
      settings: '/settings',
      clipboard: '/clipboard',
      voice: '/voice',
      vault: '/vault',
      devices: '/devices'
    }

    let newPath = urlMap[viewMode]
    if (viewMode === 'settings' && settingsSection) {
      newPath = `/settings/${encodeURIComponent(settingsSection)}`
    } else if (isInternalTabView(viewMode)) {
      newPath = internalTabPath(viewMode, navigationSubroute)
    }
    if (window.location.pathname !== newPath) {
      window.history.replaceState(null, '', newPath)
    }
    // Publish the view for anything that needs to reason about the current screen. replaceState
    // fires no event, so the URL alone is not observable.
    setCurrentView(viewMode)
  }, [navigationSubroute, settingsSection, viewMode])

  // Record the committed destination before paint so an immediate keyboard/back-button action
  // cannot observe the new screen while history still points at the previous screen. A passive
  // effect left a real race here under renderer load: Cmd+[ could skip the selected project.
  useLayoutEffect(() => {
    if (isNavigatingHistory.current) {
      isNavigatingHistory.current = false
      return
    }

    // Avoid duplicating the same state
    const currentState: NavigationState = {
      viewMode,
      subroute: isInternalTabView(viewMode) ? navigationSubroute : null,
      settingsSection: viewMode === 'settings' ? settingsSection : null,
      selectedSessionId,
      selectedMemoryId,
      selectedEntityId,
      selectedProjectId
    }

    const lastState = navigationHistory.current[navigationHistory.current.length - 1]
    const isSameState =
      lastState &&
      lastState.viewMode === currentState.viewMode &&
      lastState.subroute === currentState.subroute &&
      lastState.settingsSection === currentState.settingsSection &&
      lastState.selectedSessionId === currentState.selectedSessionId &&
      lastState.selectedMemoryId === currentState.selectedMemoryId &&
      lastState.selectedEntityId === currentState.selectedEntityId &&
      lastState.selectedProjectId === currentState.selectedProjectId

    if (!isSameState) {
      navigationHistory.current.push(currentState)
      // Clear forward history when navigating to a new state
      forwardHistory.current = []
      // Limit history size to prevent memory issues
      if (navigationHistory.current.length > 50) {
        navigationHistory.current = navigationHistory.current.slice(-50)
      }
    }
    syncNavFlags()
  }, [
    viewMode,
    navigationSubroute,
    settingsSection,
    selectedSessionId,
    selectedMemoryId,
    selectedEntityId,
    selectedProjectId,
    syncNavFlags
  ])

  // Subscribe to informational notification events from the main process. Action
  // approvals live only in Actions and never create a notification copy.
  useEffect(() => {
    if (!proReady || !isPro) return
    const unsubscribers: (() => void)[] = []

    // A new version finished downloading and is staged — show the restart banner.
    // Seed from main too: on macOS the app can keep running with no windows, so a
    // download that finished before this window existed would otherwise be missed
    // (the event only reaches windows open at download time).
    window.api
      .getStagedUpdateVersion()
      .then((v) => {
        if (v) setUpdateReady(v)
      })
      .catch(() => {})
    unsubscribers.push(
      window.api.onUpdateDownloaded((data) => {
        setUpdateReady(data.version)
      })
    )

    return () => {
      unsubscribers.forEach((unsub) => unsub())
    }
  }, [isPro, proReady])

  // Navigate back using history stack
  const navigateBack = useCallback(() => {
    if (navigationHistory.current.length > 1) {
      const previousState = navigationHistory.current[navigationHistory.current.length - 2]
      if (previousState) {
        navigateTo(previousState.viewMode, () => {
          isNavigatingHistory.current = true
          const currentState = navigationHistory.current.pop()
          if (currentState) forwardHistory.current.push(currentState)
          setNavigationSubroute(previousState.subroute)
          setSettingsSection(previousState.settingsSection)
          setSelectedSessionId(previousState.selectedSessionId)
          setSelectedMemoryId(previousState.selectedMemoryId)
          setSelectedEntityId(previousState.selectedEntityId)
          setSelectedProjectId(previousState.selectedProjectId)
          syncNavFlags()
        })
      }
    }
  }, [navigateTo, syncNavFlags])

  // Navigate forward using forward history stack
  const navigateForward = useCallback(() => {
    if (forwardHistory.current.length > 0) {
      const nextState = forwardHistory.current[forwardHistory.current.length - 1]
      if (nextState) {
        navigateTo(nextState.viewMode, () => {
          isNavigatingHistory.current = true
          forwardHistory.current.pop()
          navigationHistory.current.push(nextState)
          setNavigationSubroute(nextState.subroute)
          setSettingsSection(nextState.settingsSection)
          setSelectedSessionId(nextState.selectedSessionId)
          setSelectedMemoryId(nextState.selectedMemoryId)
          setSelectedEntityId(nextState.selectedEntityId)
          setSelectedProjectId(nextState.selectedProjectId)
          syncNavFlags()
        })
      }
    }
  }, [navigateTo, syncNavFlags])

  const handleBack = useCallback(() => {
    navigateBack()
  }, [navigateBack])

  // Navigation handlers for Dashboard and MemoryChat
  const handleSelectChat = useCallback(
    (sessionId: string) => {
      navigateTo('chats', () => setSelectedSessionId(sessionId))
    },
    [navigateTo]
  )

  const handleSelectMemory = useCallback(
    (memoryId: number) => {
      navigateTo('memories', () => setSelectedMemoryId(memoryId))
    },
    [navigateTo]
  )

  const handleSelectEntity = useCallback(
    (entityId: number) => {
      navigateTo('entities', () => setSelectedEntityId(entityId))
    },
    [navigateTo]
  )

  // Universal-search result → jump to the exact thing: open its source URL, the
  // owning entity/memory/meeting, or seek Replay to that captured moment.
  const handleOpenHit = useCallback(
    (hit: SearchHit) => {
      navigateSearchHit(hit, {
        selectEntity: handleSelectEntity,
        selectMemory: handleSelectMemory,
        openMeeting: (meetingId) => {
          navigateTo('meetings', () => setMeetingTarget(meetingId))
        },
        openChat: (target) => {
          navigateTo('memory-chat', () => setChatTarget(target))
        },
        openReplay: (timestamp) => {
          navigateTo('replay', () => setReplayTarget(timestamp))
        }
      })
    },
    [handleSelectEntity, handleSelectMemory, navigateTo]
  )

  const openSearch = useCallback(
    (q: string) => {
      navigateTo('search', () => setSearchQuery(q))
    },
    [navigateTo]
  )

  const handleProNavigate = useCallback(
    (rawIntent: ProNavigationIntent): void => {
      const intent = normalizeProNavigationIntent(rawIntent)
      if (!intent) return

      if (intent.view === 'chat') {
        if ('conversationId' in intent) {
          navigateTo('memory-chat', () => setChatTarget({ conversationId: intent.conversationId }))
          return
        }
        void window.api.approvalsExecutionChat(intent.approvalId).then((conversationId) => {
          if (!conversationId) return
          navigateTo('memory-chat', () => setChatTarget({ conversationId }))
        })
        return
      }
      navigateTo(intent.view, () => {
        if (intent.view === 'actions') {
          setActionTarget(intent.actionId ?? null)
          setApprovalTarget(intent.approvalId ?? null)
          setActionsMode(intent.mode ?? (intent.approvalId ? 'approvals' : 'todo'))
          setActionsEntity(intent.entity ?? null)
        } else if (intent.view === 'day') {
          setCalendarEventTarget(intent.calendarEventId ?? null)
        } else if (intent.view === 'replay') {
          setReplayTarget(intent.seekMs ?? null)
        } else {
          setMeetingTarget(intent.meetingId ?? null)
        }
      })
    },
    [navigateTo]
  )

  useEffect(() => {
    if (!proReady || !isPro) return
    return window.api.proOn?.(NOTIFICATION_OPEN_TARGET_CHANNEL, (rawTarget) => {
      const destination = callHook<ProNavigationIntent>(NOTIFICATION_RESOLVE_TARGET_HOOK, rawTarget)
      if (destination) handleProNavigate(destination)
    })
  }, [handleProNavigate, isPro, proReady])

  // Deep-link targets (Replay moment, specific meeting) are one-shot: clear them
  // only when we ACTUALLY LEAVE the screen that consumes them — tracked against the
  // previous view. Clearing via a viewMode+target dependency raced the navigation
  // (the target was wiped on the same transition that set it, so Replay opened on
  // "today"); keying off the transition out fixes that.
  const prevViewRef = useRef(viewMode)
  useEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = viewMode
    if (prev === viewMode) return
    if (prev === 'replay' && viewMode !== 'replay') setReplayTarget(null)
    if (prev === 'meetings' && viewMode !== 'meetings') setMeetingTarget(null)
    if (prev === 'day' && viewMode !== 'day') setCalendarEventTarget(null)
    if (prev === 'actions' && viewMode !== 'actions') {
      setActionTarget(null)
      setApprovalTarget(null)
      setActionsMode(null)
      setActionsEntity(null)
    }
  }, [viewMode])

  // Open a project chat in the main Chat screen (existing convo or new-in-project).
  const handleOpenProjectChat = useCallback(
    (target: { conversationId?: string; projectId?: string }) => {
      navigateTo('memory-chat', () => setChatTarget(target))
    },
    [navigateTo]
  )

  const handleOpenChatOwner = useCallback(
    (target: { conversationId?: string; openGallery?: boolean }) => {
      navigateTo('memory-chat', () => setChatTarget(target))
    },
    [navigateTo]
  )

  // Run an Explore preset: open a fresh chat with its catalog-owned intake form. The form collects
  // the complete brief before one detailed user message reaches the model.
  const handleRunPreset = useCallback(
    (preset: DemoPreset) => {
      navigateTo('memory-chat', () => setChatTarget({ presetId: preset.id }))
    },
    [navigateTo]
  )

  const handleOpenSkillPreset = useCallback(
    (preset: DemoPreset) => {
      navigateTo('memory-chat', () => setChatTarget({ presetId: preset.id }))
    },
    [navigateTo]
  )

  // Global keyboard shortcuts for back/forward navigation (Cmd+[ and Cmd+])
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault()
        if (modelSettingsOpen) setModelSettingsOpen(false)
        else navigateBack()
      } else if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault()
        navigateForward()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [modelSettingsOpen, navigateBack, navigateForward])

  // Original sidebar order preserved. Pro tabs pull their icon/label from the
  // static catalogue and are marked locked in the free build (open the
  // UpgradeScreen); core tabs (Projects / Chat / Models / Settings) sit where
  // they always did.
  // A missing catalog entry must NEVER blank the whole app — no error boundary
  // wraps the nav, so a TypeError here white-screens every user on boot (0.0.34).
  // If a route has no ProFeature, skip that item and warn; a dropped tab is
  // recoverable, a render-time throw is not.
  type NavItem = { label: string; icon: React.ReactNode; view: ViewMode; locked?: boolean }
  const proItem = (route: string): NavItem | null => {
    const f = getProFeature(route)
    if (!f) {
      console.warn(`[nav] no pro catalog entry for "${route}" — skipping nav item`)
      return null
    }
    return {
      label: f.label,
      icon: <f.icon className="h-5 w-5 shrink-0 text-neutral-400" weight="regular" />,
      view: f.route as ViewMode,
      locked: !isPro && !(route === 'devices' && proActivation === 'entitlement-bootstrap')
    }
  }
  // Icons take no color — the nav button drives it (emerald when active).
  const navItems = (...items: Array<NavItem | null>): NavItem[] =>
    items.filter((item): item is NavItem => item !== null)
  const navigationGroups = [
    {
      label: 'Discover',
      icon: <IconSparkles className="h-5 w-5 shrink-0" />,
      items: navItems(
        {
          label: 'Explore',
          icon: <IconCompass className="h-5 w-5 shrink-0" />,
          view: 'explore' as ViewMode
        },
        proItem('search'),
        proItem('day'),
        proItem('replay'),
        proItem('reflect')
      )
    },
    {
      label: 'Work',
      icon: <IconBriefcase className="h-5 w-5 shrink-0" />,
      items: navItems(
        proItem('meetings'),
        proItem('actions'),
        proItem('entities'),
        {
          label: 'Projects',
          icon: <IconFolders className="h-5 w-5 shrink-0" />,
          view: 'projects' as ViewMode
        },
        {
          label: 'Chat',
          icon: <IconMessageCircle className="h-5 w-5 shrink-0" />,
          view: 'memory-chat' as ViewMode
        },
        {
          label: 'Tasks',
          icon: <IconListCheck className="h-5 w-5 shrink-0" />,
          view: 'tasks' as ViewMode
        },
        proItem('voice')
      )
    },
    {
      label: 'Private Data',
      icon: <IconShieldLock className="h-5 w-5 shrink-0" />,
      items: navItems(proItem('vault'), proItem('clipboard'), proItem('devices'))
    },
    {
      label: 'System',
      icon: <IconTool className="h-5 w-5 shrink-0" />,
      items: navItems(
        {
          label: 'Integrations',
          icon: <IconPlug className="h-5 w-5 shrink-0" />,
          view: 'connectors' as ViewMode
        },
        {
          label: 'Models',
          icon: <IconDownload className="h-5 w-5 shrink-0" />,
          view: 'models' as ViewMode
        },
        {
          label: 'Gateway',
          icon: <IconServer2 className="h-5 w-5 shrink-0" />,
          view: 'gateway' as ViewMode
        },
        proItem('notifications')
      )
    }
  ].filter((group) => group.items.length > 0)
  const navigationItems = navigationGroups.flatMap((group) => group.items)
  const bottomNav: { label: string; icon: React.ReactNode; view: ViewMode; locked?: boolean }[] = [
    {
      label: 'Settings',
      icon: <IconSettings className="h-5 w-5 shrink-0" />,
      view: 'settings' as ViewMode
    }
  ]
  // One way in to a screen, used by the sidebar and by the command palette: switching screens also
  // drops whatever row was selected in the old one, so a stale detail pane never rides along.
  const goToView = (view: ViewMode, subroute: string | null = null): void => {
    navigateTo(view, () => {
      setNavigationSubroute(isInternalTabView(view) ? subroute : null)
      setSettingsSection(view === 'settings' ? subroute : null)
      setSelectedSessionId(null)
      setSelectedMemoryId(null)
      setSelectedEntityId(null)
      setReplayTarget(null)
    })
  }
  const renderNavItem = (item: {
    label: string
    icon: React.ReactNode
    view: ViewMode
    locked?: boolean
  }): React.ReactElement => {
    const active = viewMode === item.view
    const notificationCount = item.view === 'notifications' ? unreadCount + externalUnreadCount : 0
    const notificationCountLabel = notificationCount > 9 ? '9+' : String(notificationCount)
    return (
      <button
        key={item.view}
        onClick={() => goToView(item.view)}
        aria-label={item.label}
        title={!sidebarOpen ? item.label : undefined}
        className={navRowClass(sidebarOpen, active)}
      >
        {active && (
          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-green-500" />
        )}
        {item.icon}
        {sidebarOpen && <span className="flex-1 text-left whitespace-pre">{item.label}</span>}
        {notificationCount > 0 && (
          <span
            aria-label={`${notificationCount} unread notifications`}
            className={cn(
              'flex h-4 min-w-4 items-center justify-center border border-green-500 bg-green-500 px-1 font-mono text-[9px] leading-none text-black',
              !sidebarOpen && 'absolute right-0 top-0'
            )}
          >
            {notificationCountLabel}
          </span>
        )}
        {sidebarOpen && item.locked && (
          <IconLock className="h-3.5 w-3.5 shrink-0 text-neutral-400/60" title="Pro" />
        )}
      </button>
    )
  }

  return (
    <div className="h-screen w-full overflow-hidden bg-neutral-950 relative">
      <CommandPalette
        onOpenHit={handleOpenHit}
        onSeeAll={openSearch}
        /* The sidebar IS the list of screens - the palette searches that, never a second copy. */
        screens={[
          ...[...navigationItems, ...bottomNav].map(({ label, view, locked }) => ({
            label,
            view,
            locked
          })),
          ...internalTabPaletteScreens([...navigationItems, ...bottomNav]),
          ...SETTINGS_DESTINATIONS
        ]}
        onGoTo={(view, subroute) => {
          goToView(view as ViewMode, subroute)
          setSidebarOpen(false)
        }}
      />
      {/* Recording indicator — auto-records detected meetings; always visible. */}
      {(rec.recording || rec.busy) && (
        <button
          onClick={() =>
            rec.warningSecondsLeft > 0 ? rec.keepAlive() : rec.recording && rec.stop()
          }
          className="absolute left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-red-500/40 bg-neutral-900/95 px-3.5 py-1.5 font-mono text-xs text-neutral-200 shadow-xl backdrop-blur hover:border-red-500"
        >
          {rec.busy ? (
            <>
              <IconLoader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" /> Transcribing
              meeting…
            </>
          ) : rec.warningSecondsLeft > 0 ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              Stopping in {rec.warningSecondsLeft}s - click to keep, or rejoin the meeting
            </>
          ) : (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
              Recording{' '}
              {rec.platform === 'zoom'
                ? 'Zoom'
                : rec.platform === 'teams'
                  ? 'Teams'
                  : rec.platform === 'meet'
                    ? 'Meet'
                    : 'meeting'}{' '}
              · {Math.floor(rec.elapsed / 60)}:{String(rec.elapsed % 60).padStart(2, '0')} · click
              to stop
            </>
          )}
        </button>
      )}
      {/* Update ready — a new version downloaded and is staged. The button drives
          the install (quit + swap + relaunch); a plain quit/force-kill would leave
          it unapplied. */}
      {updateReady && (
        <div className="absolute right-4 top-4 z-50 flex items-center gap-3 rounded-md border border-green-500/40 bg-neutral-900/95 px-3.5 py-2 font-mono text-xs text-neutral-200 shadow-xl backdrop-blur">
          <IconDownload className="h-4 w-4 text-green-500" />
          <span>Update {updateReady} is ready</span>
          <button
            onClick={async () => {
              setInstalling(true)
              try {
                await window.api.installUpdate()
              } catch {
                // quitAndInstall normally never returns (the app exits). If it
                // rejects, unlock the button so the user can retry.
                setInstalling(false)
                addNotification({
                  type: 'info',
                  title: 'Update restart failed',
                  message: 'Try again from the update banner.'
                })
              }
            }}
            disabled={installing}
            className="flex items-center gap-1.5 rounded-sm border border-green-500/50 bg-green-500/10 px-2.5 py-1 text-emerald-400 hover:bg-green-500/20 disabled:opacity-60"
          >
            {installing ? (
              <>
                <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> Restarting…
              </>
            ) : (
              'Restart to update'
            )}
          </button>
        </div>
      )}
      {/* Background — flat Off Grid AI terminal grid (theme-aware), with a dark-mode
          starfield + periodic shooting star layered on top. */}
      <GridBackdrop className="z-0" />
      <StarfieldBackdrop className="z-0" />

      <div className="flex h-full relative z-10">
        {/* Aceternity Sidebar */}
        <Sidebar open={sidebarOpen} setOpen={setSidebarOpen}>
          <SidebarBody
            role="navigation"
            aria-label="Primary navigation"
            aria-expanded={sidebarOpen}
            className="justify-between gap-3 bg-neutral-900/80 backdrop-blur-xl border-r border-neutral-800"
            onMouseEnter={() => setSidebarOpen(true)}
            onMouseLeave={() => setSidebarOpen(false)}
            onFocusCapture={() => setSidebarOpen(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setSidebarOpen(false)
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              {/* The rail expands only while hovered or keyboard-focused. */}
              <div
                className={cn('flex items-center py-2', sidebarOpen ? 'gap-2' : 'justify-center')}
              >
                <img src={logo} alt="Off Grid AI" className="h-8 w-8 shrink-0 rounded-lg" />
                {sidebarOpen ? (
                  <span className="flex-1 text-left font-semibold text-white whitespace-pre">
                    Off Grid AI
                  </span>
                ) : null}
              </div>

              {/* Back / forward — a distinct control (filled), available everywhere (⌘[ / ⌘]) */}
              <div className={cn('mt-3 flex items-center gap-1', !sidebarOpen && 'justify-center')}>
                <button
                  onClick={navigateBack}
                  disabled={!canGoBack}
                  aria-label="Back"
                  title="Back (⌘[)"
                  className={cn(
                    'flex items-center justify-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-800/40 text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-white disabled:opacity-30 disabled:hover:bg-neutral-800/40',
                    sidebarOpen ? 'flex-1 px-2 py-1.5' : 'h-9 w-9'
                  )}
                >
                  <IconArrowLeft className="h-4 w-4 shrink-0" />
                  {sidebarOpen && <span className="text-xs font-medium">Back</span>}
                </button>
                {sidebarOpen && (
                  <button
                    onClick={navigateForward}
                    disabled={!canGoForward}
                    aria-label="Forward"
                    title="Forward (⌘])"
                    className="flex items-center justify-center rounded-lg border border-neutral-800 bg-neutral-800/40 px-2 py-1.5 text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-white disabled:opacity-30 disabled:hover:bg-neutral-800/40"
                  >
                    <IconArrowRight className="h-4 w-4 shrink-0" />
                  </button>
                )}
              </div>

              {/* Navigation (scrolls; Settings is pinned to the bottom) */}
              <div className="mt-5 flex flex-1 flex-col overflow-y-auto overflow-x-hidden pr-0.5">
                {sidebarOpen && (
                  <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
                    Menu
                  </div>
                )}
                <SidebarNavigationMenu
                  activeView={viewMode}
                  expanded={sidebarOpen}
                  groups={navigationGroups}
                  renderItem={renderNavItem}
                />
              </div>
            </div>

            {/* Pinned bottom */}
            {/* neutral-800 is the surface token, theme-aware on its own - neutral-200 is the TEXT
                token, which drew a hard black rule here in light mode. See navRowClass. */}
            <div className="flex flex-col gap-1 border-t border-neutral-800 pt-2">
              <ModelStatusDot
                open={sidebarOpen}
                onClick={() => {
                  navigateTo('settings', () => {
                    setNavigationSubroute(null)
                    setSettingsSection('setup')
                    setSettingsNavigationKey((key) => key + 1)
                  })
                }}
              />
              <NavThemeToggle expanded={sidebarOpen} />
              {bottomNav.map(renderNavItem)}
              {/* Cross-sell to the companion phone app — opens the /mobile page
                  (App Store + Google Play). Mirrors mobile's link back to desktop. */}
              <button
                onClick={() => openExternal(OFF_GRID_MOBILE_URL)}
                aria-label="Mobile app"
                title={!sidebarOpen ? 'Get the mobile app' : undefined}
                className={navRowClass(sidebarOpen)}
              >
                <IconDeviceMobile className="h-5 w-5 shrink-0" />
                {sidebarOpen && <span className="flex-1 text-left whitespace-pre">Mobile app</span>}
                {sidebarOpen && (
                  <IconExternalLink className="h-3.5 w-3.5 shrink-0 text-neutral-400/60" />
                )}
              </button>
            </div>
          </SidebarBody>
        </Sidebar>

        <div className="min-w-0 flex-1" data-testid="main-workspace">
          <div className="flex h-full flex-col overflow-hidden">
            {/* Global reprocessing banner */}
            <AnimatePresence>
              <ReprocessingBanner />
            </AnimatePresence>
            {/* Content Area */}
            <div className="flex-1 overflow-hidden">
              <AnimatePresence mode="wait">
                {viewMode === 'chats' && selectedSessionId ? (
                  <motion.div
                    key={`chat-detail-${selectedSessionId}`}
                    initial={{ opacity: 0, filter: 'blur(10px)' }}
                    animate={{ opacity: 1, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, filter: 'blur(5px)' }}
                    transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
                    className="h-full"
                  >
                    <ChatDetail
                      sessionId={selectedSessionId}
                      onBack={handleBack}
                      onSelectEntity={(entityId) => {
                        navigateTo('entities', () => {
                          setSelectedEntityId(entityId)
                          setSelectedSessionId(null)
                        })
                      }}
                      onSelectMemory={(memoryId) => {
                        navigateTo('memories', () => {
                          setSelectedMemoryId(memoryId)
                          setSelectedSessionId(null)
                        })
                      }}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key={viewMode}
                    initial={{ opacity: 0, filter: 'blur(10px)' }}
                    animate={{ opacity: 1, filter: 'blur(0px)' }}
                    exit={{ opacity: 0, filter: 'blur(5px)' }}
                    transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
                    className="p-6 h-full overflow-y-auto"
                  >
                    {viewMode === 'explore' ? (
                      <ExploreScreen onRunPreset={handleRunPreset} />
                    ) : viewMode === 'memory-chat' ? (
                      <MemoryChat
                        onNavigateToMemory={handleSelectMemory}
                        onNavigateToChat={handleSelectChat}
                        onNavigateToMeeting={(meetingId) =>
                          handleProNavigate({ view: 'meetings', meetingId })
                        }
                        onNavigateToEntity={handleSelectEntity}
                        onOpenProject={(id) => {
                          navigateTo('projects', () => setSelectedProjectId(id))
                        }}
                        onSeekReplay={(ts) => {
                          navigateTo('replay', () => setReplayTarget(ts || Date.now()))
                        }}
                        onOpenSkillPreset={handleOpenSkillPreset}
                        openTarget={chatTarget}
                        onTargetConsumed={() => setChatTarget(null)}
                        onTaskDetailModeChange={setTaskDetailSidebarMode}
                      />
                    ) : viewMode === 'tasks' ? (
                      TaskWorkspace ? (
                        <TaskWorkspace standalone onDetailModeChange={setTaskDetailSidebarMode} />
                      ) : (
                        <UpgradeScreen feature={getProFeature(viewMode)} />
                      )
                    ) : viewMode === 'chats' ? (
                      <ChatList onSelectSession={setSelectedSessionId} />
                    ) : viewMode === 'models' ? (
                      <ModelsScreen
                        navigationSubroute={navigationSubroute}
                        onNavigateSubroute={setNavigationSubroute}
                      />
                    ) : viewMode === 'projects' ? (
                      <ProjectsScreen
                        onOpenChat={handleOpenProjectChat}
                        selectedProjectId={selectedProjectId}
                        onSelectProject={setSelectedProjectId}
                      />
                    ) : viewMode === 'connectors' ? (
                      <ConnectorsScreen />
                    ) : viewMode === 'gateway' ? (
                      <GatewayScreen />
                    ) : viewMode === 'settings' ? (
                      <Settings
                        key={settingsNavigationKey}
                        activeSection={settingsSection}
                        onSectionChange={setSettingsSection}
                      />
                    ) : !isPro ? (
                      <UpgradeScreen feature={getProFeature(viewMode)} />
                    ) : proFeatureComingSoon(viewMode, currentPlatform(), isPro) ? (
                      <UpgradeScreen variant="coming-soon" feature={getProFeature(viewMode)} />
                    ) : (
                      // Pro tabs: render through the pro view-router when active,
                      // otherwise show the upgrade writeup for that feature.
                      (renderProView(viewMode, {
                        setView: (v) => navigateTo(v as ViewMode),
                        onNavigate: handleProNavigate,
                        navigationSubroute,
                        setNavigationSubroute,
                        navigateBack,
                        replayTarget,
                        meetingTarget,
                        actionTarget,
                        approvalTarget,
                        calendarEventTarget,
                        actionsMode,
                        actionsEntity,
                        searchQuery,
                        onSearchQueryChange: setSearchQuery,
                        searchSources,
                        onSearchSourcesChange: setSearchSources,
                        searchSort,
                        onSearchSortChange: setSearchSort,
                        selectedMemoryId,
                        setSelectedMemoryId,
                        selectedEntityId,
                        rec,
                        onSelectEntity: handleSelectEntity,
                        onSelectMemory: handleSelectMemory,
                        onOpenHit: handleOpenHit,
                        openChatOwner: handleOpenChatOwner
                      } satisfies ProViewContext) ?? (
                        <UpgradeScreen feature={getProFeature(viewMode)} />
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
      <AnimatePresence>
        {modelSettingsOpen && (
          <SettingsPanel
            key={modelSettingsTab}
            initialTab={modelSettingsTab}
            onClose={() => setModelSettingsOpen(false)}
          />
        )}
      </AnimatePresence>
      {TaskFloatingView ? <TaskFloatingView /> : null}
    </div>
  )
}

function App() {
  // Onboarding runs FIRST — before the model/permission gate — so a new user sees
  // the intro, then goes straight to model selection (handled by PermissionGate).
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  useEffect(() => {
    setOnboarded(localStorage.getItem('onboarding_completed') === 'true')
  }, [])

  if (onboarded === null) return null
  if (!onboarded) return <Onboarding onComplete={() => setOnboarded(true)} />

  return (
    <RendererEntitlementProvider>
      <PermissionGate>
        <NotificationProvider>
          <ToastProvider>
            <ReprocessingProvider>
              <AppContent />
            </ReprocessingProvider>
          </ToastProvider>
        </NotificationProvider>
      </PermissionGate>
    </RendererEntitlementProvider>
  )
}

export default App

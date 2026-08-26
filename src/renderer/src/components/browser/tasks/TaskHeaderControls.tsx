import {
  Clock,
  ClockCounterClockwise,
  Gear,
  Sidebar,
  SidebarSimple,
  X
} from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'

export function TaskHeaderControls({
  settingsOpen,
  mainWorkspaceCollapsed,
  historyOpen,
  showHistory = true,
  showClose = true,
  onToggleMainWorkspace,
  onToggleHistory,
  onToggleSettings,
  onClose
}: {
  settingsOpen: boolean
  mainWorkspaceCollapsed: boolean
  historyOpen: boolean
  showHistory?: boolean
  showClose?: boolean
  onToggleMainWorkspace?: () => void
  onToggleHistory: () => void
  onToggleSettings: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">Tasks</span>
      <TooltipProvider>
        <div className="flex items-center gap-1">
          {!settingsOpen && onToggleMainWorkspace ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onToggleMainWorkspace}
                  aria-label={
                    mainWorkspaceCollapsed ? 'Show main workspace' : 'Hide main workspace'
                  }
                  className="h-7 w-7 rounded-sm"
                >
                  {mainWorkspaceCollapsed ? (
                    <Sidebar data-testid="show-chat-icon" size={14} />
                  ) : (
                    <SidebarSimple data-testid="hide-chat-icon" size={14} />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{mainWorkspaceCollapsed ? 'Show Chat' : 'Hide Chat'}</TooltipContent>
            </Tooltip>
          ) : null}
          {!settingsOpen && showHistory ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={onToggleHistory}
                  aria-label={historyOpen ? 'Hide task history' : 'Show task history'}
                  className="h-7 w-7 rounded-sm"
                >
                  {historyOpen ? (
                    <ClockCounterClockwise data-testid="hide-history-icon" size={14} />
                  ) : (
                    <Clock data-testid="show-history-icon" size={14} />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{historyOpen ? 'Hide History' : 'Show History'}</TooltipContent>
            </Tooltip>
          ) : null}
          <Button
            size="icon"
            variant="ghost"
            onClick={onToggleSettings}
            aria-label="Computer Use settings"
            className="h-7 w-7 rounded-sm"
          >
            <Gear size={14} />
          </Button>
          {showClose ? <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                onClick={onClose}
                aria-label="Close Tasks"
                className="h-7 w-7 rounded-sm"
              >
                <X size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close Tasks</TooltipContent>
          </Tooltip> : null}
        </div>
      </TooltipProvider>
    </div>
  )
}

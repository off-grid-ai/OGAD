import { ListChecks } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import { taskAttentionCount, useTaskSessions } from '@renderer/lib/task-session-store'

export function TaskPanelTrigger(): React.JSX.Element {
  const { tasks } = useTaskSessions()
  const count = taskAttentionCount(tasks)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={count > 0 ? `Tasks, ${count} need attention` : 'Tasks'}
          onClick={() => openTaskSidePanel()}
          className="relative h-8 w-8 rounded-md border border-neutral-800 text-neutral-500 hover:border-green-500 hover:text-green-500"
        >
          <ListChecks size={16} />
          {count > 0 ? (
            <span
              data-testid="task-attention-badge"
              className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[9px] font-semibold leading-4 text-neutral-950"
            >
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Tasks</TooltipContent>
    </Tooltip>
  )
}

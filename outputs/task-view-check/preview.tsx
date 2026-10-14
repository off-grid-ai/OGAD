import React, {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TaskWorkspaceLayout} from '../../pro/renderer/components/browser/tasks/TaskWorkspaceLayout'
import type {TaskTab} from '../../pro/renderer/components/browser/tasks/task-types'
import type {LiveTaskSurfaceProps} from '../../pro/renderer/components/browser/tasks/LiveTaskSurface'
const task: TaskTab = {
  taskId: 'paired-browser-task',
  kind: 'web_use',
  title: 'Fill the synthetic form',
  status: 'running',
  summary: 'Working in your browser',
  steps: [],
  startedAt: Date.now() - 45000,
  updatedAt: Date.now(),
  lastUrl: 'https://synthetic.test/form'
}
const ignore = (): void => {}
function Workspace(): React.JSX.Element {
  const [stopped, setStopped] = useState(false)
  const active = { ...task, status: stopped ? ('stopped' as const) : ('running' as const) }
  const live: LiveTaskSurfaceProps = {
    active,
    activeStatus: active.status,
    activeIsLive: !stopped,
    activeComputerIsLocal: false,
    activeComputerIsControllable: false,
    activeWebIsLocal: true,
    controlError: '',
    journeyPages: [],
    manualTabs: [],
    navigation: { canGoBack: false, canGoForward: false, isLoading: false },
    address: '',
    addressError: '',
    onAddressChange: ignore,
    onSubmitAddress: ignore,
    onActivatePage: ignore,
    onActivateTab: ignore,
    onClosePage: ignore,
    onCloseTab: ignore,
    onNewTab: ignore,
    onTaskControl: (command) => {
      if (command === 'stop') setStopped(true)
    }
  }
  return (
    <TaskWorkspaceLayout
      mainWorkspaceCollapsed={false}
      visibleTasks={[active]}
      active={active}
      live={live}
      detailTaskId={active.taskId}
      onDetailTaskChange={ignore}
      onActivateTask={ignore}
      onClose={ignore}
    />
  )
}

createRoot(document.getElementById('root')!).render(<Workspace />)

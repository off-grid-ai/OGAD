// The one place a task model role is set or cleared. Web Use and Computer Use share one grounding
// specialist; each has its own decision model. The Models screens, Active models, Tasks settings
// and a paired browser all change roles through here, so they can never disagree.

import type { TaskModelRole } from '../shared/computer-use-settings'
import { getComputerUseSettings, setComputerUseSettings } from './computer-use-settings'
import { getWebUseSettings, setWebUseSettings } from './web-use-settings'

export type TaskKind = 'computer_use' | 'web_use'

/** Give `modelId` a role. Grounding is shared by both tasks, whichever one is named. */
export function setTaskRoleModel(task: TaskKind, role: TaskModelRole, modelId: string): void {
  if (role === 'grounding') {
    setComputerUseSettings({ ...getComputerUseSettings(), groundingModelId: modelId })
  } else if (task === 'computer_use') {
    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: modelId })
  } else {
    setWebUseSettings({ ...getWebUseSettings(), decisionModelId: modelId })
  }
}

/** A model that is gone leaves every role it held: each falls back to its default. */
export function clearTaskRolesFor(modelId: string): void {
  const computer = getComputerUseSettings()
  if (computer.groundingModelId === modelId || computer.decisionModelId === modelId) {
    setComputerUseSettings({
      ...computer,
      groundingModelId: computer.groundingModelId === modelId ? null : computer.groundingModelId,
      decisionModelId: computer.decisionModelId === modelId ? null : computer.decisionModelId
    })
  }
  const web = getWebUseSettings()
  if (web.decisionModelId === modelId) setWebUseSettings({ ...web, decisionModelId: null })
}

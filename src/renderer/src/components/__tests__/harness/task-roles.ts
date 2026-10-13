// Main answers the task roles view from its two task projections (getTaskRolesView). Tests that
// fake those projections get the view the same way, through the same shared builder.
import type { ComputerUseActiveModelProjection } from '../../../../../shared/computer-use-settings'
import { taskRolesView } from '../../../../../shared/task-roles-view'

const USES_CHAT: ComputerUseActiveModelProjection = {
  strategy: 'same_as_chat',
  strategyLabel: 'Same as Chat',
  models: []
}

type Projected = () => Promise<ComputerUseActiveModelProjection | null | undefined>

export function withTaskRoles<T extends Record<string, unknown>>(api: T): T {
  const computerUse = api.getComputerUseActiveModels as Projected | undefined
  const webUse = api.getWebUseActiveModels as Projected | undefined
  return Object.assign(api, {
    getTaskRoles: async () =>
      taskRolesView({
        computerUse: (await computerUse?.()) ?? USES_CHAT,
        webUse: (await webUse?.()) ?? USES_CHAT
      })
  })
}

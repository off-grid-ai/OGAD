import { strategyTaskRoles, type ComputerUseModelStrategy } from './computer-use-settings'
export interface TaskModelChoice {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly tags?: readonly string[]
  readonly grounder?: boolean
  readonly remoteServerId?: string
  readonly availability?: string
}

export function isGroundingSpecialist(model: {
  kind?: unknown
  tags?: unknown
  grounder?: unknown
}): boolean {
  return (
    model.grounder === true ||
    (model.kind === 'computer_use' &&
      !(Array.isArray(model.tags) && model.tags.includes('Decision')))
  )
}

export function isDecisionModel(model: {
  kind?: unknown
  tags?: unknown
  grounder?: unknown
}): boolean {
  return (
    model.kind === 'computer_use' && Array.isArray(model.tags) && model.tags.includes('Decision')
  )
}

/**
 * A decision model staged for evaluation: an added-folder model kept under a `decision-eval` folder.
 * It is a task specialist, not a chat model, so chat pickers leave it out. Paths are matched with
 * either separator, since Windows lists them with backslashes.
 */
export function isStagedDecisionModel(model: { files?: readonly { name: string }[] }): boolean {
  return (model.files ?? []).some((file) => /[\\/]decision-eval[\\/]/i.test(file.name))
}

export function isDecisionStrategy(strategy: ComputerUseModelStrategy): boolean {
  return strategyTaskRoles(strategy).includes('decision')
}

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

export function isDecisionStrategy(strategy: ComputerUseModelStrategy): boolean {
  return strategyTaskRoles(strategy).includes('decision')
}

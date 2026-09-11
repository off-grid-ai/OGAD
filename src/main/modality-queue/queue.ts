import { AsyncLocalStorage } from 'node:async_hooks'
import {
  backgroundOperation,
  CAPTURE_OPERATION,
  CHAT_OPERATION,
  DEFAULT_OPERATION_CONFIG,
  IMAGE_OPERATION,
  ModelOperationScheduler,
  type OperationRequest,
  type OperationSchedulerState,
  type OperationTier
} from '@offgrid/models'

export type Tier = OperationTier
export type QueueRequest = OperationRequest
export type QueueState = OperationSchedulerState

const context = new AsyncLocalStorage<true>()

/** Node composition for the shared portable admission scheduler. */
export class ModalityQueue extends ModelOperationScheduler {
  constructor() {
    super({
      isInsideOperation: () => context.getStore() === true,
      runInsideOperation: (operation) => context.run(true, operation)
    })
  }

  setEnabled(enabled: boolean): void {
    this.configure({ enabled })
  }

  isEnabled(): boolean {
    return this.getConfig().enabled
  }

  setTier1CoexistsWithTier2(tier1CoexistsWithTier2: boolean): void {
    this.configure({ tier1CoexistsWithTier2 })
  }
}

export const CHAT_JOB = CHAT_OPERATION
export const IMAGE_JOB = IMAGE_OPERATION
export const CAPTURE_JOB = CAPTURE_OPERATION
export const backgroundJob = backgroundOperation

export const QUEUE_ENABLED_KEY = 'modalityQueueEnabled'
export const TIER1_COEXIST_KEY = 'modalityTier1CoexistsWithTier2'
export const QUEUE_DEFAULTS = DEFAULT_OPERATION_CONFIG

export interface QueueConfig {
  enabled: boolean
  tier1Coexists: boolean
}

export function readQueueConfig(get: <T>(key: string, fallback: T) => T): QueueConfig {
  return {
    enabled: get(QUEUE_ENABLED_KEY, DEFAULT_OPERATION_CONFIG.enabled),
    tier1Coexists: get(TIER1_COEXIST_KEY, DEFAULT_OPERATION_CONFIG.tier1CoexistsWithTier2)
  }
}

export function applyQueueConfig(
  queue: Pick<ModalityQueue, 'setEnabled' | 'setTier1CoexistsWithTier2'>,
  config: QueueConfig
): void {
  queue.setEnabled(config.enabled)
  queue.setTier1CoexistsWithTier2(config.tier1Coexists)
}

export const modalityQueue = new ModalityQueue()

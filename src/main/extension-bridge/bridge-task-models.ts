import { isDecisionModel, isGroundingSpecialist } from '../../shared/task-model-rules'
import {
  strategyTaskRoles,
  type ComputerUseModelStrategy
} from '../../shared/computer-use-settings'
import { TASK_STRATEGIES, type TaskStrategyOption } from './bridge-settings'
import { modelShowsOnTab } from '../../shared/model-settings-rules'
// What a paired browser may pick for Remote and the Tasks models, built the same way as
// Settings > Remote and Settings > Tasks here (pro ComputerUseSettingsSection): installed
// local models plus each saved remote server's role models. Pure, so it is tested without
// Electron.

import { modelDisplayName } from '@offgrid/models'
import { remoteVisionModelId } from '../../shared/remote-vision-server'
import type { ModelChoice, RemoteSettings } from './bridge-settings'

/** A saved remote server, as the desktop keeps it. Only name, host and model names leave. */
export interface SavedServer {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly model: string
  readonly enabled?: boolean
  readonly roleModels?: Partial<Record<string, string>>
  readonly modelCatalog?: readonly { id: string; name: string }[]
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

const modelName = (server: SavedServer, id: string): string =>
  modelDisplayName(remoteVisionModelId(server.id, id), {
    remote: [{ serverId: server.id, models: server.modelCatalog ?? [] }]
  }) ?? id

export function remoteView(
  servers: readonly SavedServer[],
  activeServerId: string | null,
  textOnRemote: boolean
): RemoteSettings {
  const usable = servers.filter((s) => s.enabled !== false)
  const active = textOnRemote && usable.some((s) => s.id === activeServerId && Boolean(s.model))
  return {
    active,
    activeServerId: active ? activeServerId : null,
    servers: usable.map((s) => ({
      id: s.id,
      name: s.name,
      host: hostOf(s.endpoint),
      model: s.model ? modelName(s, s.model) : '',
      available: Boolean(s.model),
      ...(!s.model ? { reasonIfNot: 'No text model selected.' } : {})
    }))
  }
}

function localChoices(
  catalog: readonly Record<string, unknown>[],
  installed: ReadonlySet<string>,
  keep: (m: Record<string, unknown>) => boolean
): ModelChoice[] {
  return catalog
    .filter(
      (m) =>
        !m.remoteServerId &&
        keep(m) &&
        m.availability !== 'coming_soon' &&
        typeof m.id === 'string' &&
        installed.has(m.id)
    )
    .map((m) => ({ id: String(m.id), label: String(m.name ?? m.id) }))
}

function remoteChoices(servers: readonly SavedServer[], role: string): ModelChoice[] {
  return servers.flatMap((s) => {
    const id = s.roleModels?.[role]
    if (!id || s.enabled === false) {
      return []
    }
    return [{ id: remoteVisionModelId(s.id, id), label: modelName(s, id), server: s.name }]
  })
}

export function taskModelChoices(input: {
  catalog: readonly Record<string, unknown>[]
  installed: readonly string[]
  servers: readonly SavedServer[]
}): { grounding: ModelChoice[]; decision: ModelChoice[] } {
  const installed = new Set(input.installed)
  return {
    grounding: [
      ...localChoices(input.catalog, installed, (m) => isGroundingSpecialist(m)),
      ...remoteChoices(input.servers, 'grounding')
    ],
    decision: [
      ...localChoices(input.catalog, installed, (m) => isDecisionModel(m)),
      ...remoteChoices(input.servers, 'decision')
    ]
  }
}

export function taskStrategyOptions(
  choices: { grounding: ModelChoice[]; decision: ModelChoice[] },
  reasoners: readonly ModelChoice[]
): TaskStrategyOption[] {
  return TASK_STRATEGIES.map((value) => {
    const roles = strategyTaskRoles(value as ComputerUseModelStrategy)
    const decision = roles.includes('decision') ? choices.decision : []
    const grounding = roles.includes('grounding') ? choices.grounding : []
    const reasoner = value === 'separate_specialist' ? [] : reasoners
    const reason =
      roles.includes('decision') && !decision.length
        ? 'No decision model available.'
        : roles.includes('grounding') && !grounding.length
          ? 'No grounding model available.'
          : value !== 'separate_specialist' && !reasoner.length
            ? 'No active text model.'
            : undefined
    return {
      value,
      available: !reason,
      ...(reason ? { reasonIfNot: reason } : {}),
      decision,
      grounding,
      reasoner
    }
  })
}

export function modelsByTab(
  catalog: readonly Record<string, unknown>[],
  installed: readonly string[],
  activeIds: readonly string[]
): Record<string, (ModelChoice & { active: boolean })[]> {
  return Object.fromEntries(
    ['text', 'vision', 'computer_use', 'image', 'voice', 'speech', 'transcription'].map((tab) => [
      tab,
      catalog
        .filter(
          (m) =>
            typeof m.id === 'string' &&
            typeof m.kind === 'string' &&
            installed.includes(m.id) &&
            modelShowsOnTab(m as { id: string; kind: string }, tab === 'speech' ? 'voice' : tab)
        )
        .map((m) => ({
          id: String(m.id),
          label: String(m.name ?? m.id),
          active: activeIds.includes(String(m.id))
        }))
        .sort((a, b) => Number(b.active) - Number(a.active))
    ])
  )
}

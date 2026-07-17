import { useSyncExternalStore, type ComponentType } from 'react'

// Settings-section seam. Pro registers Settings sections (proactive delivery,
// secretary preferences, fleet console) during activation; the core Settings
// screen renders its own sections + all registered ones. Mirrors
// mobile/src/components/settings/sectionRegistry.ts.

export interface SettingsSection {
  id: string
  component: ComponentType
  /** Lower sorts first. */
  order?: number
  kind: 'core' | 'pro'
}

const sections: SettingsSection[] = []
const listeners = new Set<() => void>()
let snapshot: readonly SettingsSection[] = []
let coreSnapshot: readonly SettingsSection[] = []
let proSnapshot: readonly SettingsSection[] = []

function publish(): void {
  snapshot = Object.freeze(
    [...sections]
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100))
      .map((section) => Object.freeze({ ...section }))
  )
  coreSnapshot = Object.freeze(snapshot.filter((section) => section.kind === 'core'))
  proSnapshot = Object.freeze(snapshot.filter((section) => section.kind === 'pro'))
  listeners.forEach((listener) => listener())
}

export type SettingsSectionRegistration = Omit<SettingsSection, 'kind'>

function validateSectionId(id: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid settings section id: ${id}`)
}

function registerOwnedSettingsSection(section: SettingsSection): () => void {
  if (sections.some((registered) => registered.id === section.id)) return () => {}
  sections.push(section)
  publish()
  return () => {
    const index = sections.indexOf(section)
    if (index < 0) return
    sections.splice(index, 1)
    publish()
  }
}

/** Compatibility API for private Pro settings sections. */
export function registerSettingsSection(section: SettingsSectionRegistration): () => void {
  return registerOwnedSettingsSection({ ...section, kind: 'pro' })
}

/** Atomic registration API for package-owned core settings sections. */
export function registerCoreSettingsSection(section: SettingsSectionRegistration): () => void {
  validateSectionId(section.id)
  if (sections.some((registered) => registered.id === section.id)) {
    throw new Error(`Settings section is already registered: ${section.id}`)
  }
  return registerOwnedSettingsSection({ ...section, kind: 'core' })
}

export function getRegisteredSettingsSections(): readonly SettingsSection[] {
  return snapshot
}

export function getCoreSettingsSections(): readonly SettingsSection[] {
  return coreSnapshot
}

export function getProSettingsSections(): readonly SettingsSection[] {
  return proSnapshot
}

export function subscribeToSettingsSections(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRegisteredSettingsSections(): readonly SettingsSection[] {
  return useSyncExternalStore(
    subscribeToSettingsSections,
    getRegisteredSettingsSections,
    getRegisteredSettingsSections
  )
}

export function useCoreSettingsSections(): readonly SettingsSection[] {
  return useSyncExternalStore(
    subscribeToSettingsSections,
    getCoreSettingsSections,
    getCoreSettingsSections
  )
}

export function useProSettingsSections(): readonly SettingsSection[] {
  return useSyncExternalStore(
    subscribeToSettingsSections,
    getProSettingsSections,
    getProSettingsSections
  )
}

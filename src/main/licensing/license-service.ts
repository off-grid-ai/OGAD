import { PRO_PURCHASE_URL } from '../../shared/product-links'
import type { PersonalMeshActivationResult, PersonalMeshReconciliationReason } from '@offgrid/sync'

export const PRO_PAY_PAGE_URL = PRO_PURCHASE_URL

export type ActivateResult = PersonalMeshActivationResult

export type ProTier = 'lifetime' | 'monthly'

export interface ProLicenseInfo {
  isPro: boolean
  tier: ProTier | null
  expiry: string | null
  verifiedAt: number
}

export interface ProLicensedDevice {
  id: string
  fingerprint: string
  platform: string | null
  name: string | null
  lastSeen: string | null
}

/**
 * Provider-neutral paid entitlement boundary.
 *
 * The private Pro package owns credential storage and provider requests. Public core only consumes
 * this product-level interface for gating and the existing activation UI.
 */
export interface ProEntitlementProvider {
  initialize(): void
  revalidate(reason: PersonalMeshReconciliationReason): Promise<void>
  isEntitled(): boolean
  getInfo(): ProLicenseInfo
  activate(rawCredential: string): Promise<ActivateResult>
  listDevices(): Promise<ProLicensedDevice[]>
  deactivateDevice(deviceId: string): Promise<boolean>
  resetCurrentDevice(): Promise<boolean>
  clear(): void
  setChangeNotifier(notifier: (info: ProLicenseInfo) => void): void
}

const EMPTY_INFO: ProLicenseInfo = {
  isPro: false,
  tier: null,
  expiry: null,
  verifiedAt: 0
}

let provider: ProEntitlementProvider | undefined
let pendingNotifier: ((info: ProLicenseInfo) => void) | undefined

export function registerProEntitlementProvider(next: ProEntitlementProvider): () => void {
  provider = next
  if (pendingNotifier) next.setChangeNotifier(pendingNotifier)
  return () => {
    if (provider === next) provider = undefined
  }
}

export function initLicensing(): void {
  provider?.initialize()
}

export function revalidateProEntitlement(reason: PersonalMeshReconciliationReason): Promise<void> {
  return provider?.revalidate(reason) ?? Promise.resolve()
}

export function isProEntitled(): boolean {
  return provider?.isEntitled() ?? false
}

export function getProLicenseInfo(): ProLicenseInfo {
  return provider?.getInfo() ?? EMPTY_INFO
}

export function activateProByKey(rawCredential: string): Promise<ActivateResult> {
  return (
    provider?.activate(rawCredential) ??
    Promise.resolve({ ok: false, reason: 'invalid_credential' })
  )
}

export function listProDevices(): Promise<ProLicensedDevice[]> {
  return provider?.listDevices() ?? Promise.resolve([])
}

export function deactivateProDevice(deviceId: string): Promise<boolean> {
  return provider?.deactivateDevice(deviceId) ?? Promise.resolve(false)
}

export function resetProCurrentDevice(): Promise<boolean> {
  return provider?.resetCurrentDevice() ?? Promise.resolve(false)
}

export function clearPro(): void {
  provider?.clear()
}

export function setLicenseChangeNotifier(notifier: (info: ProLicenseInfo) => void): void {
  pendingNotifier = notifier
  provider?.setChangeNotifier(notifier)
}

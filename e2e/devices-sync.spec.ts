/**
 * M2 gate: the Devices (sync) surface is reachable by a USER, in both tiers.
 *
 * Free build must show the locked upsell (the inert core shell), pro build must render the real
 * screen with working sync settings. Unit and DB tests prove replication works; this proves a person
 * can actually get to it — the difference between "wired" and "shipped".
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { navButton } from './helpers/settings'
import {
  createKnowledgeDocumentStateFields,
  ClipboardSyncCoordinator,
  CLIPBOARD_CHANNEL,
  FileTransferManager,
  OpLog,
  StateSync,
  SyncEngine,
  type DeviceInfo,
  type ClipboardHistoryRecord,
  type ClipboardPendingDelivery,
  type Materializer,
  type MembershipRevocationPersistence,
  type MembershipRevocationTombstone,
  type PairedDevice,
  type PendingMembershipRevocation
} from '@offgrid/sync'
import { NodeTcpTransport } from '@offgrid/sync/node'
import type { KnowledgeDocumentSnapshot } from '../src/main/sync-knowledge-document'
import type { KeygenPersonalMeshRegistry } from '../pro/main/sync/keygen-personal-mesh-registry'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
// Pro implementation modules load lazily behind PRO_PRESENT: a static import
// fails spec COLLECTION in a core-only checkout, before the guard can skip.
const knowledgeDocumentTransfer = PRO_PRESENT
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../pro/main/sync/knowledge-document-transfer') as {
      createKnowledgeDocumentSource: (...args: never[]) => unknown
    })
  : null
const SYNCED_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const SYNCED_CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const SYNCED_MESSAGE_ID = '44444444-4444-4444-8444-444444444444'

let app: ElectronApplication
let page: Page
let userDataDir: string
let syntheticPeer: SyncEngine | null = null
let syntheticState: StateSync | null = null
let syntheticFiles: FileTransferManager | null = null
let syntheticClipboard: ClipboardSyncCoordinator | null = null
let syntheticRegistry: KeygenPersonalMeshRegistry | null = null
let syntheticInstallationId: string | null = null
const syntheticClipboardRecords = new Map<string, ClipboardHistoryRecord>()
/** The peer's pending clipboard deliveries, keyed the way the coordinator keys them: record × device. */
const syntheticClipboardDeliveries = new Map<string, ClipboardPendingDelivery>()
const syntheticActiveMemberships = new Map<string, PairedDevice>()
const syntheticProvisionalMemberships = new Map<string, PairedDevice>()
const syntheticPendingRevocations = new Map<string, PendingMembershipRevocation>()
const syntheticRevocationTombstones = new Map<string, MembershipRevocationTombstone>()
const syntheticRecords = new Map<
  string,
  { entity: string; entityId: string; fields: Record<string, unknown> }
>()

const launch = async (pro: '0' | '1'): Promise<void> => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `offgrid-devices-${pro}-`))
  if (pro === '1') {
    const modelsDir = path.join(userDataDir, 'models')
    const fileName = 'synthetic-transfer-q4.gguf'
    const bytes = Buffer.alloc(4096, 7)
    bytes.write('GGUF', 0, 'ascii')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(path.join(modelsDir, fileName), bytes)
    fs.writeFileSync(
      path.join(modelsDir, 'downloaded-models.json'),
      JSON.stringify([
        {
          id: 'off-grid/synthetic-transfer',
          name: 'Synthetic Transfer Model',
          kind: 'text',
          files: [fileName]
        }
      ])
    )
    // Index the received document with the real model, without downloading or copying it per run.
    const embeddingCache =
      process.env.OFFGRID_E2E_EMBEDDING_CACHE ??
      path.join(
        os.homedir(),
        'Library/Application Support/Off Grid AI Desktop/models/.cache/Xenova'
      )
    test.skip(
      !fs.existsSync(embeddingCache),
      `Devices sync requires a local embedding cache at ${embeddingCache}`
    )
    fs.mkdirSync(path.join(modelsDir, '.cache'), { recursive: true })
    fs.symlinkSync(embeddingCache, path.join(modelsDir, '.cache', 'Xenova'), 'dir')
  }
  app = await launchOffGrid({
    env: {
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: pro,
      OFFGRID_EMBEDDINGS_OFFLINE: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  const dismissSetup = page.getByRole('button', { name: 'Dismiss' })
  if (await dismissSetup.isVisible().catch(() => false)) await dismissSetup.click()
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
  await navigation.hover()
  await navigation.getByRole('button', { name: 'Pin sidebar', exact: true }).click()
}

/**
 * Select the sharing view. The app instance is shared across tests in this file.
 */
const openSyncSettings = async (): Promise<void> => {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Devices', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
  const tab = page
    .getByRole('navigation', { name: 'Devices control center' })
    .getByRole('button', { name: 'Sync sharing', exact: true })
  if ((await tab.getAttribute('aria-current')) !== 'page') await tab.click()
  await expect(tab).toHaveAttribute('aria-current', 'page')
}

const teardown = async (): Promise<void> => {
  await syntheticPeer?.stop().catch(() => {})
  syntheticPeer = null
  syntheticState = null
  await syntheticFiles?.dispose().catch(() => {})
  syntheticFiles = null
  syntheticClipboard = null
  syntheticClipboardRecords.clear()
  syntheticClipboardDeliveries.clear()
  syntheticActiveMemberships.clear()
  syntheticProvisionalMemberships.clear()
  syntheticPendingRevocations.clear()
  syntheticRevocationTombstones.clear()
  syntheticRecords.clear()
  await app?.close().catch(() => {})
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
  if (syntheticRegistry && syntheticInstallationId) {
    const installations = await syntheticRegistry.listInstallations()
    if (installations.some(({ installationId }) => installationId === syntheticInstallationId)) {
      await syntheticRegistry.deregisterInstallation(syntheticInstallationId)
    }
  }
  syntheticRegistry = null
  syntheticInstallationId = null
}

test.describe('Devices surface — unlicensed', () => {
  test.beforeAll(async () => launch('0'))
  test.afterAll(teardown)

  test('shows Devices as a locked Pro item that opens the upgrade screen', async () => {
    const nav = navButton(page, 'Devices')
    await expect(nav).toBeVisible()
    await nav.click()
    // The inert shell: core advertises the feature and sells it, with no pro logic present.
    await expect(page.getByText('Your chats and settings, on every device.')).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/devices-free-upgrade.png' })
  })
})

test.describe('Devices surface — pro tier', () => {
  test.beforeAll(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present')
    await launch('1')
  })
  test.afterAll(teardown)

  test('renders the real Devices screen with live sync status', async () => {
    await navButton(page, 'Devices').click()
    await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
    // Pro a29f7a0 removed the per-route health chips. Discovery and the port remain visible.
    await expect(page.getByRole('button', { name: 'Find nearby devices' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(page.getByRole('heading', { name: 'Pairing code', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Saved', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Available', exact: true })).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Available', exact: true }).getByText(/^\d+$/)
    ).toBeVisible()
    await page.getByRole('button', { name: /^Connection settings\. Sync port \d+$/ }).click()
    const connectionSettings = page.getByRole('dialog', { name: 'Connection settings' })
    await expect(connectionSettings.getByRole('textbox', { name: 'Sync port' })).toHaveValue(
      '37878'
    )
    await connectionSettings.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.screenshot({ path: 'e2e/screenshots/devices-pro.png' })
  })

  test('sync settings on the screen expose a toggle per replicated category', async () => {
    await navButton(page, 'Devices').click()
    await openSyncSettings()

    await expect(page.getByRole('heading', { name: 'Sending', exact: true })).toBeVisible()
    // Pro e58db26 removed Chats and Projects switches; those records always sync.
    await expect(page.getByRole('switch', { name: 'Optional sending enabled' })).toBeVisible()
    for (const label of ['Sync Model settings', 'Sync Copied text']) {
      await expect(page.getByRole('switch', { name: label })).toBeVisible()
    }
    await expect(page.getByRole('switch', { name: 'Sync Copied text' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    await page.screenshot({ path: 'e2e/screenshots/devices-sync-settings.png' })
  })

  test('pairs a real peer and converges projects and chats through the rendered app', async () => {
    await navButton(page, 'Devices').click()
    await page
      .getByRole('navigation', { name: 'Devices control center' })
      .getByRole('button', { name: 'Devices', exact: true })
      .click()
    const saved = page.getByRole('region', { name: 'Saved', exact: true })
    const initialSeatLabel = await saved
      .getByLabel(/^\d+ of \d+ licensed devices$/)
      .getAttribute('aria-label')
    const [, usedSeats, seatLimit] = initialSeatLabel!.match(/^(\d+) of (\d+) licensed devices$/)!
    // This fixture must have room for the peer; pairing must not evict another installation.
    expect(Number(seatLimit)).toBe(5)
    expect(Number(usedSeats)).toBeLessThan(Number(seatLimit))
    const desktop = await page.evaluate(async () =>
      (
        window as unknown as {
          api: {
            proInvoke(channel: string): Promise<{
              localDevice: DeviceInfo
              port: number
              pairingCode?: { status: string; code?: string }
            }>
          }
        }
      ).api.proInvoke('pro:sync:status')
    )
    expect(desktop.port).toBeGreaterThan(0)
    // Open the code a person would read to the joining device.
    const desktopCode = desktop.pairingCode?.code
    expect(desktopCode, 'the desktop has to be showing a pairing code to pair against').toBeTruthy()
    await page.getByRole('button', { name: 'Show QR Code', exact: true }).click()
    const pairingCode = page.getByRole('dialog', { name: 'Pair a device', exact: true })
    await expect(
      pairingCode.getByText(
        new RegExp(`^${desktopCode!.slice(0, 4)}[- ]?${desktopCode!.slice(4)}$`)
      )
    ).toBeVisible()
    await pairingCode.getByRole('button', { name: 'Close pairing code' }).click()
    // A different REAL code for the refusal case: 8 characters from the same confusable-free alphabet, so
    // it fails for being wrong rather than for being malformed.
    const wrongCode = desktopCode === 'WRNGC2DE' ? 'WRNGC2DF' : 'WRNGC2DE'

    const local: DeviceInfo = {
      id: 'synthetic-android',
      name: 'Synthetic Android',
      platform: 'android',
      version: 'test',
      host: '127.0.0.1',
      port: 0
    }

    const materializer: Materializer = {
      put: (entity, entityId, fields) => {
        syntheticRecords.set(`${entity}:${entityId}`, { entity, entityId, fields })
      },
      remove: (entity, entityId) => {
        syntheticRecords.delete(`${entity}:${entityId}`)
      }
    }
    const syntheticLog = new OpLog({
      deviceId: local.id,
      materializer,
      uuid: randomUUID,
      now: Date.now
    })
    syntheticState = new StateSync({
      oplog: syntheticLog,
      send: (deviceId, message) => {
        syntheticPeer?.sendApp(deviceId, 'state', message)
      }
    })
    syntheticFiles = new FileTransferManager({
      send: (deviceId, message) => syntheticPeer?.send(deviceId, message) ?? false,
      createSink: async () => null
    })
    let releaseSecureStore: (() => void) | undefined
    let waitForSecureStore = false
    const membershipPersistence: MembershipRevocationPersistence = {
      getActive: (deviceId) => syntheticActiveMemberships.get(deviceId),
      beginLocal: (active, pending) => {
        if (syntheticActiveMemberships.get(active.id)?.membershipId !== pending.membershipId) {
          return false
        }
        syntheticPendingRevocations.set(active.id, pending)
        syntheticActiveMemberships.delete(active.id)
        return true
      },
      listPending: () => [...syntheticPendingRevocations.values()],
      getPending: (deviceId) => syntheticPendingRevocations.get(deviceId),
      getTombstone: (deviceId, membershipId) => {
        const tombstone = syntheticRevocationTombstones.get(deviceId)
        return tombstone?.membershipId === membershipId ? tombstone : undefined
      },
      applyRemote: (expectedActive, tombstone) => {
        if (
          syntheticActiveMemberships.get(expectedActive.id)?.membershipId !== tombstone.membershipId
        ) {
          return false
        }
        syntheticActiveMemberships.delete(expectedActive.id)
        syntheticRevocationTombstones.set(expectedActive.id, tombstone)
        return true
      },
      completeLocal: (pending, tombstone) => {
        if (
          syntheticPendingRevocations.get(pending.device.id)?.revocationId !== pending.revocationId
        ) {
          return false
        }
        syntheticPendingRevocations.delete(pending.device.id)
        syntheticRevocationTombstones.set(pending.device.id, tombstone)
        return true
      },
      setPendingDismissed: (deviceId, revocationId, dismissedAt) => {
        const pending = syntheticPendingRevocations.get(deviceId)
        if (pending?.revocationId !== revocationId) return false
        if (dismissedAt === undefined) {
          delete pending.dismissedAt
        } else {
          pending.dismissedAt = dismissedAt
        }
        return true
      },
      getRevocationSecret: (deviceId, membershipId) => {
        const pending = syntheticPendingRevocations.get(deviceId)
        if (pending?.membershipId === membershipId) return pending.revocationSecret
        const tombstone = syntheticRevocationTombstones.get(deviceId)
        return tombstone?.membershipId === membershipId ? tombstone.revocationSecret : undefined
      }
    }
    syntheticPeer = new SyncEngine({
      localDevice: local,
      transport: new NodeTcpTransport(),
      // Pairing is a LICENSED transaction on both sides now: the engine refuses with
      // entitlement_unavailable when it has no entitlement adapter, so without this the peer refused the
      // handshake itself and the failure looked like the Mac rejecting it. This peer is the real-world
      // shape of a phone joining: it holds no licence of its own and is sponsored by the licensed Mac, so
      // only the IMPORT half is implemented and the export half refuses out loud rather than pretending.
      pairingEntitlement: {
        inspect: async () => ({ status: 'unlicensed' as const }),
        prepareExport: async () => {
          throw new Error('the synthetic peer holds no licence to sponsor anyone with')
        },
        commitExport: async () => {},
        rollbackExport: async () => {},
        finalizeExport: async () => {},
        prepareImport: async (credential, registration) => {
          // The joining device must register its seat before trust is committed. Since Pro
          // 73b5cb7, reconciliation retires paired devices missing from the licence registry.
          // Use the real provider adapter; a successful no-op import loses the peer immediately.
          const { KeygenPersonalMeshRegistry } =
            await import('../pro/main/sync/keygen-personal-mesh-registry')
          syntheticRegistry = new KeygenPersonalMeshRegistry(() => credential)
          await syntheticRegistry.listInstallations()
          const installation = await syntheticRegistry.registerInstallation(registration)
          syntheticInstallationId = installation.installationId
          return { id: 'synthetic-entitlement-import' }
        },
        commitImport: async () => {},
        rollbackImport: async () => {
          if (syntheticRegistry && syntheticInstallationId) {
            await syntheticRegistry.deregisterInstallation(syntheticInstallationId)
            syntheticInstallationId = null
          }
        },
        finalizeImport: async () => {}
      },
      pairingPersistence: {
        begin: async (device) => {
          if (waitForSecureStore) {
            await new Promise<void>((resolve) => {
              releaseSecureStore = resolve
            })
          }
          syntheticProvisionalMemberships.set(device.id, device)
        },
        commit: (device) => {
          if (!syntheticProvisionalMemberships.has(device.id)) {
            throw new Error('The pairing credential was not staged.')
          }
          syntheticActiveMemberships.set(device.id, device)
          syntheticPendingRevocations.delete(device.id)
          syntheticRevocationTombstones.delete(device.id)
          syntheticProvisionalMemberships.delete(device.id)
        },
        rollback: (deviceId) => {
          syntheticProvisionalMemberships.delete(deviceId)
        }
      },
      membershipPersistence,
      onMessage: (deviceId, message) => syntheticFiles?.handleMessage(deviceId, message),
      onAppMessage: (deviceId, channel, data) => {
        if (channel === 'state') syntheticState?.onMessage(deviceId, data)
        if (channel === CLIPBOARD_CHANNEL) {
          void syntheticClipboard?.onRemoteMessage(data, deviceId)
        }
      },
      onPaired: (device) => syntheticState?.onConnect(device.id)
    })
    syntheticClipboard = new ClipboardSyncCoordinator({
      localDevice: () => local,
      resolveRemoteDevice: (deviceId) =>
        deviceId === desktop.localDevice.id ? desktop.localDevice : undefined,
      enabled: () => true,
      // Two lists, not one: the coordinator asks separately who is PAIRED (may receive, even offline -
      // that is what pending deliveries are for) and who is CONNECTED right now. The harness only
      // supplied the connected half, so the coordinator hit an undefined pairedDeviceIds the moment
      // pairing started working and the clipboard step was finally reached.
      pairedDeviceIds: () =>
        syntheticPeer?.isPaired(desktop.localDevice.id) ? [desktop.localDevice.id] : [],
      connectedDeviceIds: () =>
        syntheticPeer?.isPaired(desktop.localDevice.id) ? [desktop.localDevice.id] : [],
      send: (deviceId, channel, data) => syntheticPeer?.sendApp(deviceId, channel, data) ?? false,
      writeNativeText: () => {},
      persistence: {
        load: () => [...syntheticClipboardRecords.values()],
        upsert: (record) => {
          syntheticClipboardRecords.set(record.id, structuredClone(record))
        },
        remove: (id) => {
          syntheticClipboardRecords.delete(id)
        }
      },
      // Required by the coordinator, and absent here - so this spec died on its own harness with
      // "Cannot read properties of undefined (reading 'load')" from loadPendingDeliveries, in CI and
      // locally both, before it ever reached the app it exists to exercise. In memory, like the history
      // store above: it stands in for the peer's disk, not for any of our logic.
      deliveryPersistence: {
        load: () => [...syntheticClipboardDeliveries.values()],
        upsert: (delivery) => {
          syntheticClipboardDeliveries.set(
            `${delivery.recordId}:${delivery.deviceId}`,
            structuredClone(delivery)
          )
        },
        remove: (recordId, deviceId) => {
          syntheticClipboardDeliveries.delete(`${recordId}:${deviceId}`)
        },
        removeRecord: (recordId) => {
          for (const key of [...syntheticClipboardDeliveries.keys()]) {
            if (key.startsWith(`${recordId}:`)) syntheticClipboardDeliveries.delete(key)
          }
        }
      }
    })
    await syntheticClipboard.initialize()
    await syntheticPeer.start(0)
    // Both codes are REAL pairing codes: 8 characters from the confusable-free alphabet
    // (23456789ABCDEFGHJKMNPQRSTUVWXYZ, see PAIRING_CODE_LENGTH/ALPHABET). They used to be
    // 'SYNTH4ND' and 'WRNGC2DE', which the field rejects outright with "Enter the
    // 8-character pairing code shown on the other device" - so Accept never ran, and the mismatch case
    // was failing validation rather than proving a mismatch is refused. Different from each other on
    // purpose: that is what makes the refusal below mean something.
    // Both codes are REAL pairing codes: 8 characters from the confusable-free alphabet
    // (23456789ABCDEFGHJKMNPQRSTUVWXYZ - PAIRING_CODE_LENGTH/ALPHABET in shared sync). They used to be
    // 'synthetic-pair-code' and 'different-pair-code', which the field rejects outright with "Enter the
    // 8-character pairing code shown on the other device", so Accept never ran - and the mismatch case
    // below was failing VALIDATION rather than proving a wrong code is refused. Different from each
    // other on purpose: that difference is the whole point of the refusal that follows.
    const wrongPairing = syntheticPeer
      .pair(
        {
          ...desktop.localDevice,
          host: '127.0.0.1',
          port: desktop.port
        },
        wrongCode
      )
      .catch((cause: unknown) => cause)

    // A wrong code is refused by the HOST ITSELF, with no prompt and nothing to accept. That is the
    // current design: the joining device presents the code shown on this screen, and the engine compares
    // it (getPassphrase in pro/main/sync-ipc.ts hands it this Mac's live code). What this spec used to
    // drive - a "Synthetic Android wants to pair" heading, an "Incoming pairing code" textbox and an
    // Accept button - does not exist in the renderer any more, so every run was waiting 15s for a screen
    // that had been removed. Evidence from the app itself: the attempt is registered as
    // stage=failed / failure.code=code_mismatch within ~11ms of arriving.
    await expect(page.getByText('Pairing failed')).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('The pairing codes did not match.')
    expect((await wrongPairing) as { code?: string }).toMatchObject({ code: 'code_mismatch' })
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByText('Pairing failed')).toHaveCount(0)

    waitForSecureStore = true
    const pairing = syntheticPeer.pair(
      {
        ...desktop.localDevice,
        host: '127.0.0.1',
        port: desktop.port
      },
      desktopCode as string
    )

    // The matching code completes the pairing on its own - the incoming dialog is informational and its
    // only action is Cancel. The secure-store gate is still held on purpose: it proves the trust is
    // written before the device is shown as paired, which is the half of this transaction the UI cannot
    // show.
    //
    // WAIT for the gate to exist before releasing it. releaseSecureStore is only assigned once the peer's
    // pairingPersistence.begin() actually runs, and the UI steps that used to sit here gave that time to
    // happen. Releasing too early is releasing nothing: the peer then blocks in begin() forever and the
    // attempt ends as "Pairing was cancelled" a minute later.
    await expect
      .poll(() => releaseSecureStore !== undefined, {
        message: 'the peer should reach its secure-store write',
        timeout: 20_000
      })
      .toBe(true)
    releaseSecureStore?.()
    await pairing
    // The Devices tab now carries the live connection count.
    await expect(
      page
        .getByRole('navigation', { name: 'Devices control center' })
        .getByRole('button', { name: 'Devices · 1 connected', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/devices-after-pairing.png' })
    // And the facts underneath, from the app's own state rather than a label.
    const paired = await page.evaluate(async () => {
      const status = (await (
        window as unknown as { api: { proInvoke(c: string): Promise<unknown> } }
      ).api.proInvoke('pro:sync:status')) as {
        paired?: { id: string }[]
        connectedIds?: string[]
      }
      return {
        pairedIds: (status.paired ?? []).map((device) => device.id),
        connectedIds: status.connectedIds ?? []
      }
    })
    expect(paired.pairedIds).toContain('synthetic-android')
    expect(paired.connectedIds).toContain('synthetic-android')
    await expect.poll(() => syntheticPeer?.isPaired(desktop.localDevice.id)).toBe(true)

    await openSyncSettings()
    const copiedText = page.getByRole('switch', { name: 'Sync Copied text' })
    await expect(copiedText).toHaveAttribute('aria-checked', 'false')
    await copiedText.click()
    await expect(copiedText).toHaveAttribute('aria-checked', 'true')
    await syntheticClipboard.onNativeText({
      text: 'PingSupport from Android',
      timestamp: Date.now()
    })
    await navButton(page, 'Clipboard').click()
    await expect(page.getByText('PingSupport from Android', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Synthetic Android', { exact: true }).first()).toBeVisible()

    await navButton(page, 'Devices').click()
    await openSyncSettings()
    await page.getByRole('switch', { name: 'Sync Copied text' }).click()
    await page
      .getByRole('navigation', { name: 'Devices control center' })
      .getByRole('button', { name: 'Devices · 1 connected', exact: true })
      .click()
    await page.getByRole('button', { name: 'Rescan network' }).click()
    await expect(page.getByRole('button', { name: 'Rescan network' })).toBeEnabled()
    await expect(page.getByText('Synthetic Android').first()).toBeVisible()
    await expect(page.getByText('Scanning Wi-Fi and Nearby routes.')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    const timestamp = new Date().toISOString()
    const inboundOps = [
      syntheticLog.record('project', SYNCED_PROJECT_ID, 'put', {
        name: 'Synced from phone',
        description: 'A project delivered over encrypted device sync.',
        system_prompt: '',
        icon: null,
        include_memory: 1,
        created_at: timestamp,
        updated_at: timestamp
      }),
      syntheticLog.record('conversation', SYNCED_CONVERSATION_ID, 'put', {
        title: 'Cross-device notes',
        project_id: SYNCED_PROJECT_ID,
        created_at: timestamp,
        updated_at: timestamp
      }),
      syntheticLog.record('message', SYNCED_MESSAGE_ID, 'put', {
        conversation_id: SYNCED_CONVERSATION_ID,
        role: 'user',
        content: 'This arrived over encrypted sync.',
        context: null,
        created_at: timestamp
      })
    ]
    expect(
      syntheticPeer.sendApp(desktop.localDevice.id, 'state', { t: 'ops', ops: inboundOps })
    ).toBe(true)
    await expect
      .poll(async () => {
        const status = await page.evaluate(async () =>
          (
            window as unknown as {
              api: { proInvoke(channel: string): Promise<{ ops: number }> }
            }
          ).api.proInvoke('pro:sync:status')
        )
        return status.ops
      })
      .toBeGreaterThanOrEqual(inboundOps.length)

    await navButton(page, 'Projects').click()
    const syncedProject = page.getByRole('button', { name: 'Synced from phone' })
    await expect(syncedProject).toBeVisible()
    await syncedProject.click()
    await expect(page.getByRole('button', { name: /Cross-device notes/ })).toBeVisible()

    await page.getByRole('button', { name: 'Knowledge & settings', exact: true }).click()
    await expect(page.getByText('No documents yet.')).toBeVisible()
    const knowledgePath = path.join(userDataDir, 'launch-brief.txt')
    const knowledgeBytes = Buffer.from(
      'Launch brief from the phone contains enough text to create a knowledge chunk.'
    )
    fs.writeFileSync(knowledgePath, knowledgeBytes)
    const knowledgeDocument: KnowledgeDocumentSnapshot = {
      syncId: randomUUID(),
      projectId: SYNCED_PROJECT_ID,
      name: path.basename(knowledgePath),
      filePath: knowledgePath,
      fileSize: knowledgeBytes.length,
      createdAt: timestamp,
      enabled: true
    }
    await syntheticFiles.sendFile(
      desktop.localDevice.id,
      knowledgeDocumentTransfer!.createKnowledgeDocumentSource(knowledgeDocument as never)
    )
    const knowledgeOp = syntheticLog.record(
      'knowledge_document',
      knowledgeDocument.syncId,
      'put',
      createKnowledgeDocumentStateFields(knowledgeDocument)
    )
    expect(
      syntheticPeer.sendApp(desktop.localDevice.id, 'state', {
        t: 'ops',
        ops: [knowledgeOp]
      })
    ).toBe(true)
    await expect(page.getByText(knowledgeDocument.name, { exact: true })).toBeVisible({
      timeout: 15_000
    })
    await expect(
      page.getByRole('button', { name: `Disable ${knowledgeDocument.name}`, exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: `Delete ${knowledgeDocument.name}`, exact: true })
    ).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/devices-state-sync.png' })

    await page.getByRole('button', { name: 'New project', exact: true }).click()
    const projectName = page.getByRole('textbox', { name: 'Project name…', exact: true })
    await projectName.fill('Created on desktop')
    await projectName.press('Enter')
    await expect(page.getByRole('button', { name: 'Created on desktop' })).toBeVisible()
    await expect
      .poll(() =>
        [...syntheticRecords.values()].some(
          (record) => record.entity === 'project' && record.fields.name === 'Created on desktop'
        )
      )
      .toBe(true)

    await navButton(page, 'Devices').click()
    await page.getByRole('button', { name: 'Send model' }).click()
    await expect(
      page.getByRole('heading', { name: 'Send a model to Synthetic Android' })
    ).toBeVisible()
    await expect(page.getByText('Synthetic Transfer Model')).toBeVisible()
    await expect(page.getByText('synthetic-transfer-q4.gguf')).toBeVisible()
    await page.screenshot({ path: 'e2e/screenshots/devices-model-transfer.png' })
    await page
      .getByRole('dialog', { name: 'Send a model to Synthetic Android' })
      .getByRole('button', { name: 'Close model transfer', exact: true })
      .click()

    await syntheticPeer.stop()
    syntheticPeer = null
    const peer = page.getByRole('article').filter({
      has: page.getByText('Synthetic Android', { exact: true })
    })
    await expect(peer.getByText('Offline', { exact: true })).toBeVisible()
    await peer.getByRole('button', { name: 'Evict', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Evict Synthetic Android?' })).toBeVisible()
    const eviction = page.getByRole('dialog', { name: 'Evict Synthetic Android?', exact: true })
    // Shared 6b387de distinguishes immediate seat release from queued offline licence removal.
    await expect(eviction).toContainText(
      'This removes Synthetic Android from your licensed devices, frees its seat and ends its Sync trust.'
    )
    await expect(eviction).toContainText(
      'Synthetic Android is offline, so removing its saved licence stays queued until it next connects.'
    )
    await expect(eviction).toContainText('Either device must pair again before Sync can reconnect.')
    await page.getByRole('button', { name: 'Evict device' }).click()
    await expect(saved.getByText(`${usedSeats} used`, { exact: true })).toBeVisible()
    await expect(saved.getByLabel(initialSeatLabel!, { exact: true })).toBeVisible()
    // Shared c88ccf0 removed evicted devices from both lists. Offline cleanup stays queued,
    // but the former error row and its Retry/Dismiss controls no longer exist on this surface.
    await expect(peer).toHaveCount(0)
    await expect(page.getByText('Could not reach Synthetic Android')).toHaveCount(0)
  })

  test('turning a category off persists across a screen change', async () => {
    await navButton(page, 'Devices').click()
    await openSyncSettings()
    const modelSettings = page.getByRole('switch', { name: 'Sync Model settings' })
    const clipboard = page.getByRole('switch', { name: 'Sync Copied text' })
    // Model settings are optional and start off. Enable them before testing off-state persistence.
    await expect(modelSettings).toHaveAttribute('aria-checked', 'false')
    await modelSettings.click()
    await expect(modelSettings).toHaveAttribute('aria-checked', 'true')
    await expect(clipboard).toHaveAttribute('aria-checked', 'false')
    await modelSettings.click()
    await clipboard.click()
    await expect(modelSettings).toHaveAttribute('aria-checked', 'false')
    await expect(clipboard).toHaveAttribute('aria-checked', 'true')

    // Leave and come back: the preference is persisted in main, not just React state.
    await navButton(page, 'Models').click()
    await navButton(page, 'Devices').click()
    await openSyncSettings()
    await expect(page.getByRole('switch', { name: 'Sync Model settings' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    await expect(page.getByRole('switch', { name: 'Sync Copied text' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  test('sync also appears in Settings as its own section', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Device sync' })).toBeVisible()
  })
})

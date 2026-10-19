/**
 * Activating Pro on a sixth device takes the seat of the device away longest. The person is never
 * told the licence is full.
 *
 * Real Devices screen, licence service, activation owner, Keygen client and seat replacement. The
 * boundary is Keygen: an in-memory provider that really holds machines and enforces the seat limit,
 * served on localhost; the app's Keygen URL is redirected to it (pro/e2e/fixtures/sync-license-boundary.cjs).
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { closeAndWait } from './helpers/windows'
import type { KeygenFake } from '../pro/main/__tests__/helpers/keygen-fake'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const LICENCE = 'OFFGRID-SIXTH-DEVICE-E2E'
const SEATS = 5
/** In activation order: the first has been away longest. */
const HOLDERS = ['phone-away-longest', 'tablet', 'old-mac', 'work-mac', 'phone-recent']

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let keygen: KeygenFake
let server: Server | null = null

/** Keygen on localhost, holding a licence whose five seats are all taken. */
async function startKeygen(): Promise<{ endpoint: string; provider: string }> {
  const { createKeygenFake } = await import('../pro/main/__tests__/helpers/keygen-fake')
  const { KEYGEN_API_BASE } = await import('../pro/main/licensing/keygen-config')
  keygen = createKeygenFake()
  keygen.addLicence({ key: LICENCE, seats: SEATS })
  for (const fingerprint of HOLDERS)
    keygen.activate({ key: LICENCE, fingerprint, name: fingerprint, platform: 'ios' })
  keygen.install()
  const providerFetch = globalThis.fetch
  keygen.restore()
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const result = await providerFetch(`${KEYGEN_API_BASE}${request.url}`, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    })
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Keygen did not bind')
  return { endpoint: `http://127.0.0.1:${address.port}`, provider: KEYGEN_API_BASE }
}

const seats = (): string[] => keygen.machines(LICENCE).map(({ fingerprint }) => fingerprint)

test.describe('Licence seats', () => {
  test.skip(targetIsPackaged(), 'The Keygen boundary needs the source app entry.')

  test.beforeEach(() => {
    test.skip(!PRO_PRESENT, 'pro package not present: licensing is Pro')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-sixth-device-'))
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('a sixth device takes the seat of the device away longest', async () => {
    test.setTimeout(120_000)
    const { endpoint, provider } = await startKeygen()
    expect(seats()).toEqual(HOLDERS)
    app = await launchOffGrid({
      appEntry: path.resolve('pro/e2e/fixtures/sync-license-boundary.cjs'),
      env: {
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_PRO: '',
        OFFGRID_E2E_KEYGEN_URL: endpoint,
        OFFGRID_E2E_KEYGEN_PROVIDER: provider,
        OFFGRID_NO_SERVICES: '1',
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await completeOnboarding(page)
    const navigation = page.getByRole('navigation', { name: 'Primary navigation' })
    await navigation.hover()
    await navigation.getByRole('button', { name: 'Devices', exact: true }).click()
    await page.getByPlaceholder('XXXX-XXXX-XXXX-XXXX').fill(LICENCE)
    await page.getByRole('button', { name: 'Activate', exact: true }).click()

    // This Mac is Pro, and nobody was told the licence is full.
    await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible({
      timeout: 60_000
    })
    await expect(page.getByRole('alert').filter({ hasText: /full|in use|no seats/i })).toHaveCount(
      0
    )
    // The licence is at its cap again, and Devices says which device a seventh would replace.
    await expect(
      page.getByText(
        'All slots are in use. Pairing another device will remove tablet, the one away longest.'
      )
    ).toBeVisible()
    expect(await page.evaluate(() => window.api.license.status())).toMatchObject({ isPro: true })

    // Still five seats: the one away longest went, every other device kept its seat.
    expect(seats()).toHaveLength(SEATS)
    expect(seats()).not.toContain('phone-away-longest')
    for (const fingerprint of HOLDERS.slice(1)) expect(seats()).toContain(fingerprint)
  })
})

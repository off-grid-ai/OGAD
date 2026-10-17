/**
 * A connected Google account lists its access, asks to sign in again once Google refuses its
 * sign-in, and on Remove asks Google to revoke it; when Google cannot be told, the person is.
 *
 * Real Integrations screen, Google sign-in (PKCE, loopback redirect), token store, sync and
 * removal. The boundaries: the system browser (the consent URL is recorded, and the test plays
 * the redirect Google would send), Google's servers (token, revoke and REST answered inside the
 * app's network layer), and the OS notification centre.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { closeAndWait } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const EMAIL = 'avery.quinn@example.test'

interface GoogleFake {
  opened: string[]
  revoked: string[]
  notices: string[]
  codes: number
  expired: boolean
  revokeFails: boolean
}

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

/** Google, as the app's main process sees it over the network, and the OS around it. */
async function installGoogle(): Promise<void> {
  await app!.evaluate(({ shell, Notification }, email) => {
    const fake = {
      opened: [] as string[],
      revoked: [] as string[],
      notices: [] as string[],
      codes: 0,
      expired: false,
      revokeFails: false
    }
    ;(globalThis as unknown as { __google: typeof fake }).__google = fake
    shell.openExternal = async (url: string) => {
      fake.opened.push(url)
    }
    const show = Notification.prototype.show
    Notification.prototype.show = function (this: Notification) {
      fake.notices.push(`${this.title}: ${this.body}`)
      return show.call(this)
    }
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    const network = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.hostname !== 'googleapis.com' && !url.hostname.endsWith('.googleapis.com'))
        return network(input, init)
      const form = new URLSearchParams(
        typeof init?.body === 'string' ? init.body : String(init?.body ?? '')
      )
      if (url.pathname === '/token') {
        if (form.get('grant_type') === 'authorization_code') {
          const n = form.get('code')!.replace('code-', '')
          return json(200, {
            access_token: `access-${n}`,
            refresh_token: `refresh-${n}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope:
              'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly'
          })
        }
        return fake.expired
          ? json(400, { error: 'invalid_grant' })
          : json(200, { access_token: 'access-refreshed', expires_in: 3600 })
      }
      if (url.pathname === '/revoke') {
        fake.revoked.push(form.get('token') ?? '')
        return fake.revokeFails ? json(503, { error: 'backend_error' }) : json(200, {})
      }
      if (fake.expired) return json(401, { error: { code: 401 } })
      if (url.pathname.endsWith('/profile')) return json(200, { emailAddress: email })
      if (url.pathname.includes('userinfo')) return json(200, { email })
      return json(200, { messages: [], items: [], resultSizeEstimate: 0 })
    }
  }, EMAIL)
}

const google = (): Promise<GoogleFake> =>
  app!.evaluate(() => (globalThis as unknown as { __google: GoogleFake }).__google)

const setGoogle = (change: Partial<GoogleFake>): Promise<void> =>
  app!.evaluate((_electron, next) => {
    Object.assign((globalThis as unknown as { __google: object }).__google, next)
  }, change)

/** The person consents in the browser: Google sends them back to the app with a code. */
async function consent(): Promise<void> {
  let consentUrl: URL | undefined
  await expect
    .poll(
      async () => {
        const url = (await google()).opened.find(
          (u) => new URL(u).hostname === 'accounts.google.com'
        )
        consentUrl = url ? new URL(url) : undefined
        return Boolean(consentUrl)
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  const { codes } = await google()
  await setGoogle({ opened: [], codes: codes + 1 })
  const back = new URL(consentUrl!.searchParams.get('redirect_uri')!)
  back.searchParams.set('code', `code-${codes + 1}`)
  back.searchParams.set('state', consentUrl!.searchParams.get('state')!)
  expect((await fetch(back)).ok).toBe(true)
}

const googleCard = (): ReturnType<Page['getByRole']> =>
  page.getByRole('listitem', { name: 'Google', exact: true })

const account = (): ReturnType<Page['getByRole']> =>
  page.getByRole('group', { name: new RegExp(EMAIL.replace('.', '\\.')) })

async function connectGoogle(button: string): Promise<void> {
  const panel = page.getByRole('dialog', { name: 'Connect Google' })
  if (!(await panel.isVisible().catch(() => false)))
    await googleCard().getByRole('button', { name: 'Connect', exact: true }).click()
  await panel.getByRole('button', { name: button }).click()
  await consent()
}

/** The app reads the account live (Google accounts are read when asked, not copied). */
const readGoogle = (): Promise<unknown> =>
  page.evaluate(async () => {
    const connectors = (await window.api.mcpList()) as Array<{ id: number; url?: string }>
    const google = connectors.find((c) => c.url?.includes('offgrid-services=workspace'))
    return google ? window.api.mcpTest(google.id) : null
  })

async function openIntegrations(): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' })
  await nav.hover()
  await nav.getByRole('button', { name: 'Integrations', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible({
    timeout: 60_000
  })
}

test.describe('Google account lifecycle', () => {
  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: accounts are a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-google-account-'))
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_PRO: '1',
        OFFGRID_NO_SERVICES: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await installGoogle()
    await completeOnboarding(page)
    await openIntegrations()
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('connect, sign in again after Google refuses, remove with revoke', async () => {
    test.setTimeout(150_000)
    await connectGoogle('Connect Google')
    await expect(account()).toContainText(/Reads .*Gmail/)

    // Google refuses the saved sign-in: the next read marks the account, and it says what to do.
    await setGoogle({ expired: true })
    await readGoogle()
    const signInAgain = account().getByRole('button', { name: 'Sign in again' })
    await expect(signInAgain).toBeVisible({ timeout: 20_000 })
    await setGoogle({ expired: false })
    await signInAgain.click()
    await connectGoogle('Update access')
    await expect(signInAgain).toHaveCount(0, { timeout: 20_000 })
    await expect(account()).toContainText(/Reads .*Gmail/)

    // Remove, after confirming: Google is asked to revoke the current sign-in.
    await account()
      .getByRole('button', { name: /^Remove / })
      .click()
    await account().getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
    await expect(account()).toHaveCount(0)
    await expect.poll(async () => (await google()).revoked).toEqual(['refresh-2'])
    expect((await google()).notices).toEqual([])

    // When Google cannot be told, the person is, with where to remove the access themselves.
    await setGoogle({ revokeFails: true })
    await connectGoogle('Connect Google')
    await expect(account()).toBeVisible()
    await account()
      .getByRole('button', { name: /^Remove / })
      .click()
    await account().getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()
    await expect(account()).toHaveCount(0)
    await expect
      .poll(async () => (await google()).notices)
      .toEqual([expect.stringMatching(/^Google access is still allowed: .*myaccount\.google\.com/)])
  })
})

// @vitest-environment jsdom
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GatewayScreen } from '../src/renderer/src/components/GatewayScreen'
// Real gateway and encrypted SQLite secret store. Electron's OS key storage is
// the external boundary; its synthetic implementation uses real authenticated encryption.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net, { type AddressInfo } from 'node:net'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-api-keys-'))
const osKey = randomBytes(32)
let keychainLocked = false
vi.mock('electron', () => ({
  app: { getPath: () => directory, getAppPath: () => process.cwd(), isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => !keychainLocked,
    encryptString: (value: string) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', osKey, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString: (value: Buffer) => {
      const cipher = createDecipheriv('aes-256-gcm', osKey, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
    }
  }
}))
import {
  startModelServer,
  stopModelServer,
  getGatewayPort,
  createGatewayApiKey,
  gatewayApiKeySettings,
  revokeGatewayApiKey,
  setGatewayApiKeyRequired
} from '../src/main/model-server'
let base: string
beforeAll(async () => {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  await startModelServer(port)
  base = `http://127.0.0.1:${getGatewayPort()}`
})
afterAll(() => {
  stopModelServer()
  fs.rmSync(directory, { recursive: true, force: true })
})

it('requires independent keys on every modality and rejects expiry, revocation, and locked storage', async () => {
  expect((await fetch(`${base}/v1/requests`)).status).toBe(200)
  const phone = createGatewayApiKey('Phone', null)
  const laptop = createGatewayApiKey('Laptop', Date.now() + 86400000)
  const headers = { Authorization: `Bearer ${phone.key}` }
  expect(phone.settings.enabled).toBe(true)
  expect(JSON.stringify(gatewayApiKeySettings())).not.toContain(phone.key)
  expect(gatewayApiKeySettings().keys).toHaveLength(2)
  for (const route of [
    '/v1/models',
    '/v1/requests',
    '/v1/requests/unknown',
    '/v1/images/unknown',
    '/v1/audio/voices',
    '/v1/settings',
    '/completion',
    '/api/tags'
  ]) {
    expect((await fetch(base + route)).status, route).toBe(401)
  }
  for (const route of [
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings',
    '/v1/images/generations',
    '/v1/images/edits',
    '/v1/audio/speech',
    '/v1/audio/transcriptions',
    '/v1/models/pull'
  ]) {
    expect(
      (await fetch(base + route, { method: 'POST', body: 'invalid body' })).status,
      route
    ).toBe(401)
  }
  expect((await fetch(`${base}/v1/requests/unknown`, { method: 'DELETE' })).status).toBe(401)
  for (const authorization of ['Bearer wrong', `Basic ${phone.key}`, `Bearer ${phone.key} extra`]) {
    expect(
      (await fetch(`${base}/v1/requests`, { headers: { Authorization: authorization } })).status
    ).toBe(401)
  }
  const denied = await fetch(`${base}/v1/requests?api_key=${phone.key}`)
  expect(denied.status).toBe(401)
  expect(denied.headers.get('www-authenticate')).toContain('Bearer')
  expect((await denied.json()).error.type).toBe('authentication_error')
  const preflight = await fetch(`${base}/v1/requests`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://client.example', 'Access-Control-Request-Headers': 'authorization' }
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization')
  expect((await fetch(`${base}/docs`)).status).toBe(200)
  for (const key of [phone.key, laptop.key])
    expect(
      (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${key}` } })).status
    ).toBe(200)
  expect(gatewayApiKeySettings().keys[0]?.lastUsedAt).toBeGreaterThan(0)
  expect((await fetch(`${base}/v1/requests`, { headers })).status).toBe(200)
  const firstId = phone.settings.keys[0]!.id
  revokeGatewayApiKey(firstId)
  expect((await fetch(`${base}/v1/requests`, { headers })).status).toBe(401)
  expect(
    (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${laptop.key}` } }))
      .status
  ).toBe(200)
  const laptopId = laptop.settings.keys[1]!.id
  const replacement = createGatewayApiKey('Laptop replacement', null, laptopId)
  expect(
    (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${laptop.key}` } }))
      .status
  ).toBe(401)
  expect(
    (
      await fetch(`${base}/v1/requests`, {
        headers: { Authorization: `Bearer ${replacement.key}` }
      })
    ).status
  ).toBe(200)
  const short = createGatewayApiKey('Short lived', Date.now() + 250)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(
    (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${short.key}` } }))
      .status
  ).toBe(401)
  keychainLocked = true
  expect((await fetch(`${base}/v1/requests`, { headers })).status).toBe(503)
  expect(() => createGatewayApiKey('Cannot save', null)).toThrow()
  keychainLocked = false
  for (const key of gatewayApiKeySettings().keys) revokeGatewayApiKey(key.id)
  expect(gatewayApiKeySettings().enabled).toBe(true)
  expect((await fetch(`${base}/v1/requests`)).status).toBe(401)
  stopModelServer()
  await startModelServer(Number(new URL(base).port))
  base = `http://127.0.0.1:${getGatewayPort()}`
  await expect
    .poll(async () => {
      try {
        return (await fetch(`${base}/v1/requests`)).status
      } catch {
        return 0
      }
    })
    .toBe(401)
  setGatewayApiKeyRequired(false)
  expect((await fetch(`${base}/v1/requests`)).status).toBe(200)
  expect(() => createGatewayApiKey('', null)).toThrow()
  expect(() => createGatewayApiKey('Bad expiry', Date.now() - 1)).toThrow()
  expect(() => createGatewayApiKey('Unknown replacement', null, 'missing')).toThrow()
  expect(() => revokeGatewayApiKey('missing')).toThrow()
  keychainLocked = true
  expect(() => setGatewayApiKeyRequired(false)).toThrow()
  keychainLocked = false
})

it('creates, replaces, and revokes keys from Gateway with one-time disclosure', async () => {
  // Electron IPC is the external boundary. The screen, main-process owner,
  // secret storage, and HTTP gateway are real.
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    gatewayApiKeys: async () => gatewayApiKeySettings(),
    // The Gateway screen also reads who it serves; this journey runs it for one person.
    getLlmSettings: async () => ({ gatewayMode: 'single' }),
    createGatewayApiKey: async (...args: Parameters<typeof createGatewayApiKey>) =>
      createGatewayApiKey(...args),
    revokeGatewayApiKey: async (id: string) => revokeGatewayApiKey(id),
    setGatewayApiKeyRequired: async (enabled: boolean) => setGatewayApiKeyRequired(enabled)
  }
  const user = userEvent.setup()
  render(<GatewayScreen />)
  const section = within(screen.getByRole('region', { name: 'API keys' }))
  await section.findByText('API key not required')
  await user.type(section.getByLabelText('Key name'), 'Studio client')
  await user.click(section.getByRole('combobox', { name: 'Expiry' }))
  await user.click(await screen.findByRole('option', { name: 'No expiry', exact: true }))
  await user.click(section.getByRole('button', { name: 'Create key' }))
  const issued = (await section.findByLabelText(
    'Copy this key now. It will not be shown again.'
  )) as HTMLInputElement
  const key = issued.value
  expect(
    (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${key}` } })).status
  ).toBe(200)
  await user.click(section.getByRole('button', { name: 'Done' }))
  expect(section.queryByDisplayValue(key)).toBeNull()
  await user.click(section.getByRole('combobox', { name: 'Expiry' }))
  await user.click(await screen.findByRole('option', { name: '7 days', exact: true }))
  await user.click(section.getByRole('button', { name: 'Replace Studio client' }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm' }))
  const replacement = (
    (await section.findByLabelText(
      'Copy this key now. It will not be shown again.'
    )) as HTMLInputElement
  ).value
  expect(replacement).not.toBe(key)
  expect(
    (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${key}` } })).status
  ).toBe(401)
  expect(
    (await fetch(`${base}/v1/requests`, { headers: { Authorization: `Bearer ${replacement}` } }))
      .status
  ).toBe(200)
  await user.click(section.getByRole('button', { name: 'Done' }))
  await user.click(section.getByRole('button', { name: 'Revoke Studio client' }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm' }))
  await expect
    .poll(
      async () =>
        (
          await fetch(`${base}/v1/requests`, {
            headers: { Authorization: `Bearer ${replacement}` }
          })
        ).status
    )
    .toBe(401)
  await user.click(section.getByRole('switch', { name: /^Require an API key/ }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
  expect((await fetch(`${base}/v1/requests`)).status).toBe(401)
  await user.click(section.getByRole('switch', { name: /^Require an API key/ }))
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Confirm' }))
  await section.findByText('API key not required')
  expect((await fetch(`${base}/v1/requests`)).status).toBe(200)
  keychainLocked = true
  try {
    await user.click(section.getByRole('button', { name: 'Refresh status' }))
    expect((await section.findByRole('alert')).textContent).toContain('API key storage is locked')
    expect(section.getByRole('button', { name: 'Create key' })).toBeTruthy()
  } finally {
    keychainLocked = false
    cleanup()
  }
})

it('keeps Gateway visible when API key storage is locked on entry', async () => {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    gatewayApiKeys: async () => gatewayApiKeySettings(),
    getLlmSettings: async () => ({ gatewayMode: 'single' })
  }
  keychainLocked = true
  try {
    render(<GatewayScreen />)
    expect((await screen.findByRole('alert')).textContent).toContain('API key storage is locked')
    expect(screen.getByRole('heading', { name: 'Gateway', exact: true })).toBeTruthy()
  } finally {
    keychainLocked = false
    cleanup()
  }
})

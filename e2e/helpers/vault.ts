import { expect, type Page } from '@playwright/test'

/**
 * Create a vault through the gate the way a person does, and return the recovery phrase it shows.
 *
 * Creating a vault also unlocks it. When the vault screen began following unlock pushes
 * (pro cbc02a9), that unlock replaced the gate before the 24 words were shown, and the specs were
 * changed to expect the vault to open straight away. Every vault since then had a phrase sealed on
 * disk that nobody ever saw. The phrase step is required: every spec that creates a vault goes
 * through it here, so the flow cannot skip it again without failing all of them.
 */
export const createVaultThroughGate = async (page: Page, password: string): Promise<string[]> => {
  await expect(page.getByRole('heading', { name: 'Create Vault', exact: true })).toBeVisible()
  await page.getByLabel('Master password', { exact: true }).fill(password)
  await page.getByLabel('Confirm password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Create Vault', exact: true }).click()

  const heading = page.getByRole('heading', { name: 'Save your recovery phrase', exact: true })
  await expect(heading).toBeVisible()
  // The vault must not open behind the phrase: the person has to confirm first.
  await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toHaveCount(0)
  const words = (await page.getByText(/^\d+\. \S+$/).allInnerTexts()).map(
    (line) => line.split(' ')[1]
  )
  expect(words).toHaveLength(24)

  await page.getByRole('button', { name: 'I have saved it. Open vault', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
  return words
}

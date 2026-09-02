import { expect, type Page } from '@playwright/test'

/**
 * Click through onboarding into the app shell.
 *
 * Two failure modes this exists to prevent, both seen in the suite:
 *
 * 1. Racing the first paint. Specs looped `if (!visible) break` immediately after
 *    domcontentloaded, so if onboarding had not rendered yet the loop exited on step 0 and
 *    left the app sitting on onboarding — every later nav lookup then timed out against the
 *    onboarding DOM. We wait for the CTA to appear before stepping.
 *
 * 2. A CTA regex that misses the last step. meeting-transcription.spec.ts matched
 *    /Continue|Start using Off Grid AI Desktop/, but the final button renders
 *    'Start using Off Grid AI' (src/renderer/src/components/Onboarding.tsx), so the last step
 *    never got clicked. One shared matcher means one place to keep in sync.
 *
 * NOTE: the button copy is 'Start using Off Grid AI' while the product name is 'Off Grid AI
 * Desktop'. Matched as-is here rather than changing user-facing copy from a test fix.
 */
const ONBOARDING_CTA = /^(Continue|Start using Off Grid(?: AI(?: Desktop)?)?)$/i

const dismissOptionalSetupNudge = async (page: Page): Promise<void> => {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  const visible = await dismiss
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false)
  if (visible) await dismiss.click()
}

export const completeOnboarding = async (page: Page, maxSteps = 10): Promise<void> => {
  const cta = page.getByRole('button', { name: ONBOARDING_CTA }).first()
  // An existing/seeded profile may skip onboarding entirely — that is not a failure.
  const onOnboarding = await cta
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (onOnboarding) {
    for (let step = 0; step < maxSteps; step += 1) {
      if (!(await cta.isVisible().catch(() => false))) break
      await cta.click().catch(() => {})
      await page.waitForTimeout(350)
    }
    // Reaching the shell is the point of this helper — assert it rather than hoping.
    await expect(cta).toBeHidden()
  }

  // Most journeys test the app shell, not first-model setup. A fresh profile has no
  // model, so PermissionGate shows its non-blocking setup nudge over that shell. Dismiss
  // it through the real user control once here. The dedicated onboarding journey keeps
  // owning model-setup coverage without every other spec carrying this precondition.
  await dismissOptionalSetupNudge(page)
}

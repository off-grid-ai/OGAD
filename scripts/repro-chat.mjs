import { _electron as electron } from '@playwright/test'
const timing = {
  wait(ms) {
    return new Promise((resolveWait) => setTimeout(resolveWait, ms))
  }
}
const APP_BIN = process.env.APP_BIN
const app = await electron.launch({
  ...(APP_BIN ? { executablePath: APP_BIN, args: [] } : { args: ['.'] }),
  env: { ...process.env, OFFGRID_PRO: '0', OFFGRID_USER_DATA: '/tmp/og-chatdiag' }
})
app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d))
app.process().stderr.on('data', (d) => process.stdout.write('[err]  ' + d))
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  if (w) w.setSize(1480, 940)
})
await timing.wait(3000)
// skip onboarding if present
for (let i = 0; i < 4; i++) {
  const b = win.getByRole('button', { name: /Continue|Start using Off Grid AI/i }).first()
  if (await b.isVisible().catch(() => false)) {
    await b.click().catch(() => {})
    await timing.wait(1000)
  } else break
}
await timing.wait(1000)
// go to Chat
await win
  .getByRole('button', { name: 'Chat', exact: false })
  .first()
  .click()
  .catch(() => {})
await timing.wait(1500)
// type + send
const box = win.getByPlaceholder(/Ask anything/i).first()
await box.click().catch(() => {})
await box.fill('hey')
await win.keyboard.press('Enter')
console.log('>>> sent "hey", waiting for response...')
await timing.wait(45000)
const txt = await win
  .locator('body')
  .innerText()
  .catch(() => '')
const m = txt.match(/(Sorry, something went wrong[^\n]*|No response returned[^\n]*)/)
console.log('>>> RESULT:', m ? m[1] : '(got a normal response)')
await app.close()

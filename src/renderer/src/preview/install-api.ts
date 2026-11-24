// Installs the demo bridge as `window.api`. main.tsx imports this first: some renderer modules read
// window.api when they load (useMeetingRecorder), and imports run before main.tsx's own code.
//
// Pro is unlocked, so the Pro screens are there to translate too. App reads the launch value (isPro) and
// then asks license.status(); both say Pro. The Pro screens below read fields off their answers, so each
// gets an empty answer of the right shape.
import { createDemoApi } from './demo-api'

const proLicense = { isPro: true, expiry: null, verifiedAt: 1 }

;(window as unknown as { api: unknown }).api = createDemoApi({
  isPro: true,
  license: {
    status: async () => proLicense,
    onChanged: () => () => {},
    listDevices: async () => []
  },
  idGet: async () => ({ name: '', email: '', emails: [], aliases: [] }),
  secretaryPrefsGet: async () => ({ doc: '' })
})

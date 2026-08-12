# Physical iOS and macOS knowledge Sync

This runner drives the real packaged Desktop app with Playwright and the installed iPhone app with
WebDriverAgent. It preserves both profiles and the existing pair. It never pairs or forgets a
device.

Requirements:

- Mac and iPhone are on the same Wi-Fi.
- The current Mobile build is installed.
- One existing project is already visible on both devices.
- A synthetic text fixture exists on the Mac and has the same basename in an Apple Files provider
  on the iPhone.
- WebDriverAgent is running at the URL supplied to `IOS_SYNC_WDA_URL`.

Start WebDriverAgent from the Mobile repository:

```bash
cd ../mobile && WDA_UDID=<hardware-udid> node scripts/ios/launch-wda.mjs
```

Keep that process open and use the printed `WDA_URL`:

```bash
export IOS_DEVICE_ID=00008150-000225103CD8C01C
export IOS_SYNC_WDA_URL=http://iphone-address:8100
export SYNC_PROJECT_NAME="Physical Sync Test"
export IOS_SYNC_FIXTURE_PATH=/absolute/path/phone-notes.txt
```

Check every prerequisite without restarting an app or changing data:

```bash
npm run test:sync:physical
```

Run the journey:

```bash
npm run test:sync:physical -- --execute
```

The executed run builds the current Desktop Pro app, restarts both apps without clearing their
profiles, and verifies:

1. Desktop document arrives on iPhone.
2. iPhone document arrives on Desktop.
3. Disable from Desktop and enable from iPhone converge.
4. Delete from iPhone converges on Desktop.
5. The remaining document survives both app relaunches.
6. Delete from Desktop converges on iPhone.

Screenshots stay in the local path printed as `artifactDir`. The runner removes its test documents
after a passing run and reopens Desktop. It does not run the pre-push gate or push a branch.

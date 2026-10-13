import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const hasPro = await fs.access('pro/main/meeting-recorder-preload.ts').then(
  () => true,
  () => false
)

// This is a native worker integration test, not an application navigation test.
// Chromium records a synthetic tab and a synthetic microphone. No user desktop,
// microphone, application profile, models, or saved meetings are accessed.
it.runIf(hasPro)(
  'writes and finalizes both recording tracks with real Chromium MediaRecorder',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-meeting-worker-'))
    try {
      const preload = path.join(root, 'worker.cjs')
      await build({
        entryPoints: [path.resolve('pro/main/meeting-recorder-preload.ts')],
        outfile: preload,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        sourcemap: 'inline',
        external: ['electron']
      })
      await fs.appendFile(preload, `\n//# sourceURL=${pathToFileURL(preload).href}\n`)
      const entry = path.join(root, 'main.cjs')
      await fs.writeFile(
        path.join(root, 'source.html'),
        '<!doctype html><title>Synthetic meeting</title><p>Recorded tab</p>'
      )
      await fs.copyFile('resources/linux-desktop/recorder.html', path.join(root, 'worker.html'))
      await fs.writeFile(
        entry,
        `const {app, BrowserWindow, session, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'synthetic-profile'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const timeout = setTimeout(() => { console.error('Recording worker timed out'); app.exit(1); }, 18000);
app.whenReady().then(async () => {
  const capture = session.fromPartition('synthetic-meeting');
  capture.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'));
  const source = new BrowserWindow({show: false, webPreferences: {session: capture, backgroundThrottling: false}});
  await source.loadFile(path.join(__dirname, 'source.html'));
  await source.webContents.executeJavaScript('const audio = new AudioContext(); const tone = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = 0; tone.connect(gain).connect(audio.destination); tone.start(); audio.resume();', true);
  capture.setDisplayMediaRequestHandler((_request, callback) => callback({video: source.webContents.mainFrame, audio: source.webContents.mainFrame}));
  const worker = new BrowserWindow({show: false, webPreferences: {preload: path.join(__dirname, 'worker.cjs'), session: capture, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false}});
  const finished = new Set();
  ipcMain.handle('meeting-recorder:chunk', async (event, track, bytes) => {
    if (event.sender !== worker.webContents || !['screen', 'mic'].includes(track)) throw new Error('Invalid recording sender');
    await fs.promises.appendFile(path.join(__dirname, track + '.webm'), Buffer.from(bytes));
  });
  ipcMain.on('meeting-recorder:ready', () => setTimeout(() => worker.webContents.send('meeting-recorder:stop'), 2200));
  ipcMain.on('meeting-recorder:error', (_event, error) => { console.error(error); app.exit(1); });
  ipcMain.on('meeting-recorder:track-stopped', async (_event, track) => {
    finished.add(track);
    if (finished.size === 2) {
      const coverage = await worker.webContents.debugger.sendCommand('Profiler.takePreciseCoverage');
      fs.writeFileSync(path.join(__dirname, 'worker-coverage.json'), JSON.stringify(coverage));
      clearTimeout(timeout); console.log('RECORDING_FINALIZED'); app.exit(0);
    }
  });
  await worker.loadFile(path.join(__dirname, 'worker.html'));
  worker.webContents.debugger.attach('1.3');
  await worker.webContents.debugger.sendCommand('Profiler.enable');
  await worker.webContents.debugger.sendCommand('Profiler.startPreciseCoverage', {callCount: true, detailed: true});
  worker.webContents.focus();
  await worker.webContents.executeJavaScript('window.dispatchEvent(new Event("offgrid-record-meeting"))', true);
}).catch(error => { console.error(error); app.exit(1); });
`
      )
      const binary = require('electron') as string
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const command = process.platform === 'linux' ? 'xvfb-run' : binary
      const args = process.platform === 'linux' ? ['-a', binary, '--no-sandbox', entry] : [entry]
      const { stdout } = await promisify(execFile)(command, args, {
        env,
        timeout: 22_000,
        maxBuffer: 1024 * 1024
      })
      expect(stdout).toContain('RECORDING_FINALIZED')
      if (process.env.OFFGRID_AGGREGATE_COVERAGE === '1') {
        // Keep the compiled script and its inline map available while c8 converts
        // the browser report. This reports actual renderer execution, not a mock.
        const output = path.resolve('coverage-native-raw')
        await fs.mkdir(output, { recursive: true })
        const raw = JSON.parse(await fs.readFile(path.join(root, 'worker-coverage.json'), 'utf8'))
        const nativeScript = raw.result.filter((script: { url: string }) =>
          script.url.includes('worker.cjs')
        )
        expect(nativeScript.length).toBeGreaterThan(0)
        const scriptPath = path.join(output, 'meeting-recorder-worker.cjs')
        const compiled = await fs.readFile(preload, 'utf8')
        const relocated = compiled.replace(
          /sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/,
          (_match, encoded: string) => {
            const map = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
            map.sources = map.sources.map((source: string) => path.resolve(root, source))
            return (
              'sourceMappingURL=data:application/json;base64,' +
              Buffer.from(JSON.stringify(map)).toString('base64')
            )
          }
        )
        await fs.writeFile(scriptPath, relocated)
        for (const script of nativeScript) script.url = scriptPath
        await fs.writeFile(
          path.join(output, 'meeting-recorder-worker.json'),
          JSON.stringify({ result: nativeScript })
        )
      }
      for (const track of ['screen', 'mic']) {
        const bytes = await fs.readFile(path.join(root, `${track}.webm`))
        expect(bytes.length).toBeGreaterThan(100)
        // EBML is the public WebM container contract, not worker implementation state.
        expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  activateWaylandWindow,
  captureWaylandWindow,
  isWaylandSession,
  prepareLinuxCapture,
  pasteDesktopWindow,
  readFocusedWindow
} from '../src/main/linux-desktop'

// The compositor commands are the external boundary. Product capture code and
// its shipped Python helper both run unchanged, with real files and processes.
describe.runIf(process.platform === 'linux')('Linux native desktop boundary', () => {
  let root: string
  let previous: NodeJS.ProcessEnv
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XkAAAAASUVORK5CYII=',
    'base64'
  )
  const window = {
    type: 'con',
    id: 42,
    focused: true,
    app_id: 'synthetic-editor',
    name: 'Synthetic document',
    pid: 123,
    rect: { x: -1280, y: 20, width: 640, height: 480 }
  }
  async function executable(name: string, source: string): Promise<void> {
    await fs.writeFile(path.join(root, name), '#!/usr/bin/python3\n' + source, { mode: 0o755 })
  }
  beforeEach(async () => {
    previous = { ...process.env }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-desktop-boundary-'))
    Object.assign(process.env, {
      PATH: `${root}${path.delimiter}${previous.PATH}`,
      XDG_SESSION_TYPE: 'wayland',
      XDG_CURRENT_DESKTOP: 'sway',
      SWAYSOCK: path.join(root, 'compositor.sock'),
      COMPOSITOR_TREE: path.join(root, 'tree.json'),
      COMPOSITOR_PNG: path.join(root, 'pixel.png'),
      XDG_DATA_HOME: root
    })
    delete process.env.HYPRLAND_INSTANCE_SIGNATURE
    await fs.writeFile(process.env.COMPOSITOR_TREE!, JSON.stringify({ nodes: [window] }))
    await fs.writeFile(process.env.COMPOSITOR_PNG!, png)
    await executable(
      'swaymsg',
      `import json, os, sys
from pathlib import Path
p = Path(os.environ['COMPOSITOR_TREE'])
if sys.argv[1:] == ['-t', 'get_tree', '-r']: print(p.read_text())
else:
    identifier = int(sys.argv[1].split('=')[1].rstrip(']'))
    current = json.loads(p.read_text())['nodes'][0]
    print(json.dumps([{'success': identifier == current['id']}]))
`
    )
    await executable(
      'grim',
      `import os, sys
from pathlib import Path
Path(sys.argv[-1]).write_bytes(Path(os.environ['COMPOSITOR_PNG']).read_bytes())
`
    )
  })
  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reads the focused window and captures that window through the shipped helper', async () => {
    expect(isWaylandSession()).toBe(true)
    await prepareLinuxCapture()
    const focused = await readFocusedWindow()
    expect(focused?.id).toBe(42)
    expect(focused?.title).toBe('Synthetic document')
    expect(focused?.bounds).toEqual(window.rect)
    expect(await captureWaylandWindow(42)).toEqual(png)
    expect(await captureWaylandWindow(43)).toBeNull()
    expect(await activateWaylandWindow('sway:42')).toBe(true)
    expect(await activateWaylandWindow('sway:43')).toBe(false)
  })

  it('returns an actionable error when the compositor cannot report focus', async () => {
    await fs.writeFile(process.env.COMPOSITOR_TREE!, 'not JSON')
    await expect(readFocusedWindow()).rejects.toThrow(
      'The Linux desktop could not provide the active window'
    )
  })

  it('installs the GNOME extension into the desktop extension directory', async () => {
    process.env.XDG_CURRENT_DESKTOP = 'GNOME'
    await executable(
      'gnome-extensions',
      `import sys
if sys.argv[1:] != ['enable', 'offgrid-capture@getoffgridai.co']: sys.exit(1)
`
    )
    await prepareLinuxCapture()
    const extension = path.join(root, 'gnome-shell/extensions/offgrid-capture@getoffgridai.co')
    const metadata = JSON.parse(await fs.readFile(path.join(extension, 'metadata.json'), 'utf8'))
    expect(metadata.uuid).toBe('offgrid-capture@getoffgridai.co')
    expect(await fs.stat(path.join(extension, 'extension.js'))).toHaveProperty(
      'size',
      expect.any(Number)
    )
    await prepareLinuxCapture()
    expect(JSON.parse(await fs.readFile(path.join(extension, 'metadata.json'), 'utf8'))).toEqual(
      metadata
    )
  })

  it('reports the setup action if GNOME cannot enable the extension', async () => {
    process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME'
    await executable('gnome-extensions', 'import sys\nsys.exit(1)\n')
    await expect(prepareLinuxCapture()).rejects.toThrow(
      'Enable Off Grid AI Capture in GNOME Extensions'
    )
  })

  it('honors an explicit X11 session even if a Wayland display is inherited', async () => {
    process.env.XDG_SESSION_TYPE = 'x11'
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    expect(isWaylandSession()).toBe(false)
    await prepareLinuxCapture()
    await expect(fs.stat(path.join(root, 'gnome-shell'))).rejects.toThrow()
  })
  it('uses an inherited Wayland display only when X11 is not explicit', () => {
    delete process.env.XDG_SESSION_TYPE
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    expect(isWaylandSession()).toBe(true)
    delete process.env.WAYLAND_DISPLAY
    expect(isWaylandSession()).toBe(false)
  })
  it('reports a missing installation instead of launching an unrelated helper', async () => {
    process.env.OFFGRID_RESOURCE_DIR = root
    await expect(captureWaylandWindow(42)).rejects.toThrow('The Linux desktop helper is missing')
  })
  it('reports a refused desktop input connection', async () => {
    process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(root, 'missing-bus')}`
    await expect(pasteDesktopWindow('gnome:42', false)).rejects.toThrow()
  })
})

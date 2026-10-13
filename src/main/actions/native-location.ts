import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { parseHelperResponse, type NativeActionResponse } from './native-helper-logic'

type LocationBinding = {
  currentLocation(): Promise<NativeActionResponse>
}

let binding: LocationBinding | null = null

const execFileAsync = promisify(execFile)

// A separate process bounds the system bus calls and releases the GeoClue client
// after this one location request. Coordinates are never persisted here.
const LINUX_LOCATION_SCRIPT = `
import json, math, time
from datetime import datetime, timezone
from gi.repository import Gio, GLib

client = None
bus = None
manager = '/org/freedesktop/GeoClue2/Manager'
service = 'org.freedesktop.GeoClue2'

def call(path, interface, method, args=None, timeout=1500):
    return bus.call_sync(service, path, interface, method, args, None,
                         Gio.DBusCallFlags.NONE, timeout, None)

try:
    bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
    client = call(manager, service + '.Manager', 'GetClient').unpack()[0]
    for name, value in [('DesktopId', GLib.Variant('s', 'off-grid-ai')),
                        ('RequestedAccuracyLevel', GLib.Variant('u', 8))]:
        call(client, 'org.freedesktop.DBus.Properties', 'Set',
             GLib.Variant('(ssv)', (service + '.Client', name, value)))
    call(client, service + '.Client', 'Start', timeout=60000)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        location = call(client, 'org.freedesktop.DBus.Properties', 'Get',
                        GLib.Variant('(ss)', (service + '.Client', 'Location'))).unpack()[0]
        if location != '/':
            fields = call(location, 'org.freedesktop.DBus.Properties', 'GetAll',
                          GLib.Variant('(s)', (service + '.Location',))).unpack()[0]
            latitude, longitude = fields['Latitude'], fields['Longitude']
            accuracy = fields['Accuracy']
            if not (math.isfinite(latitude) and -90 <= latitude <= 90 and
                    math.isfinite(longitude) and -180 <= longitude <= 180 and
                    math.isfinite(accuracy) and accuracy >= 0):
                raise ValueError('The location service returned invalid coordinates.')
            timestamp = fields['Timestamp']
            observed = datetime.fromtimestamp(timestamp[0] + timestamp[1] / 1000000,
                                              timezone.utc).isoformat()
            print(json.dumps({'ok': True, 'result': {'latitude': latitude,
                  'longitude': longitude, 'accuracyMeters': accuracy, 'timestamp': observed}}))
            break
        time.sleep(0.25)
    else:
        raise TimeoutError('Current location was not available within 15 seconds.')
except Exception as error:
    print(json.dumps({'ok': False, 'error': 'Linux location is unavailable. Enable location access and check that GeoClue is installed. ' + str(error)}))
finally:
    if client is not None:
        try:
            call(manager, service + '.Manager', 'DeleteClient', GLib.Variant('(o)', (client,)))
        except Exception:
            pass
`

export async function currentLinuxLocation(): Promise<NativeActionResponse> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/python3', ['-c', LINUX_LOCATION_SCRIPT], {
      timeout: 80_000,
      maxBuffer: 64 * 1024
    })
    return parseHelperResponse(stdout)
  } catch {
    return {
      ok: false,
      error: 'Linux location is unavailable. Install python3-gi and geoclue-2.0, enable location access, or provide a starting address.'
    }
  }
}

export async function currentMacLocation(): Promise<NativeActionResponse> {
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'location.node')
    : path.join(process.cwd(), 'resources', 'bin', 'location.node')
  if (!fs.existsSync(binary)) {
    return { ok: false, error: 'the macOS location bridge is not available in this build' }
  }
  try {
    // The system permission prompt is tied to the foreground app. This bridge
    // runs in Electron itself, so its TCC identity matches the Settings switch.
    app.focus({ steal: true })
    if (!binding) {
      const nativeModule = { exports: {} } as NodeModule
      process.dlopen(nativeModule, binary)
      binding = nativeModule.exports as LocationBinding
    }
    return await binding.currentLocation()
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

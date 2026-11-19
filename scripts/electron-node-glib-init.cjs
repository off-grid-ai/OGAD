// Loaded with NODE_OPTIONS=--require when tests run under Electron's Node
// runtime (ELECTRON_RUN_AS_NODE) on Linux, as the pre-push hook does.
//
// Electron links the system GLib/GObject. In a full Electron app GTK sets that
// library up before any app code runs. Run as Node, nothing does, and sharp's
// addon binds g_object_unref to the system copy: every PNG, JPEG or TIFF
// decode then crashes the worker with SIGSEGV. A 2D canvas context sets up the
// system GObject library the way GTK does, so sharp works as it does in the app.
//
// sharp loads first: it brings in the system libstdc++. canvas carries an older libstdc++ of its
// own, and loaded first it would be the one every later addon gets (better-sqlite3 then fails
// with GLIBCXX_3.4.29 not found).
const path = require('node:path')

try {
  const modules = path.join(__dirname, '..', 'node_modules')
  require(path.join(modules, 'sharp'))
  const { createCanvas } = require(path.join(modules, 'canvas'))
  createCanvas(1, 1).getContext('2d')
} catch (error) {
  console.warn(
    `[electron-node-glib-init] canvas could not set up GObject; sharp image decodes may crash: ${error.message}`
  )
}

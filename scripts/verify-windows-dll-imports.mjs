#!/usr/bin/env node
// Every Windows executable, DLL and native addon in the packaged app must find each DLL it imports
// on a clean Windows install: in its own folder, or as part of Windows itself.
//
// A native addon is loaded with its own folder as the search path, so a DLL next to electron.exe or
// in another engine's folder does not count. The MSVC runtime (MSVCP140, VCRUNTIME140, ...) is not
// part of Windows: a machine without the Visual C++ redistributable fails with error 126, "The
// specified module could not be found". That is how 0.0.58 crashed at launch: onnxruntime-node's
// binding shipped without the runtime beside it.
//
// Usage: node scripts/verify-windows-dll-imports.mjs <packaged app folder, e.g. dist/win-unpacked>
// Reads the PE import tables directly, so it runs on any OS. Delay-loaded imports are not checked:
// they load on first use, and Node addons delay-load their host (node.exe) that way.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** DLLs every supported Windows 10/11 install has (System32), lowercase. */
const WINDOWS_DLLS = new Set(
  `advapi32 advapi32res authz bcrypt bcryptprimitives cabinet cfgmgr32 clbcatq comctl32 comdlg32
  crypt32 cryptbase cryptnet cryptsp d2d1 d3d10warp d3d11 d3d12 d3d9 d3dcompiler_47 dbgeng dbghelp
  dcomp ddraw devobj dhcpcsvc dinput8 dnsapi dpapi dsound dwmapi dwrite dxcore dxgi dxva2 esent
  evr fltlib gdi32 gdi32full gdiplus glu32 hid imagehlp imm32 iphlpapi kernel32 kernelbase ksuser
  mf mfplat mfreadwrite mfuuid mpr msacm32 msasn1 mscms msctf msi msimg32 mswsock msvcrt ncrypt
  netapi32 normaliz ntdll ntmarta ole32 oleacc oleaut32 opengl32 pdh powrprof profapi propsys
  psapi rpcrt4 rstrtmgr sechost secur32 setupapi shcore shell32 shlwapi sspicli ucrtbase urlmon
  user32 userenv usp10 uxtheme version winhttp wininet winmm winspool wintrust wldap32 wlanapi
  ws2_32 wsock32 wtsapi32 xinput1_4 dxva2 mfcore ninput nvcuda vulkan-1 comppkgsup windows.storage
  combase avrt avicap32 wevtapi wer winusb hidparse srvcli netutils samcli logoncli wkscli cryptui credui`
    .split(/\s+/)
    .filter(Boolean)
)

/** Loaded from the host process, not from a file beside the addon. */
const HOST_MODULES = new Set(['node.exe', 'node.dll', 'electron.exe', 'off grid ai.exe'])

function isWindowsDll(name) {
  const lower = name.toLowerCase()
  if (lower.startsWith('api-ms-win-') || lower.startsWith('ext-ms-')) return true
  return WINDOWS_DLLS.has(lower.replace(/\.(dll|drv|sys)$/, ''))
}

/** The DLL names a PE file imports (not delay-loaded), or null when the file is not PE. */
export function peImports(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) return null
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null
  const sections = buf.readUInt16LE(pe + 6)
  const optionalSize = buf.readUInt16LE(pe + 20)
  const optional = pe + 24
  const magic = buf.readUInt16LE(optional)
  const dataDirs = optional + (magic === 0x20b ? 112 : 96)
  const importRva = buf.readUInt32LE(dataDirs + 8)
  if (!importRva) return []
  const table = optional + optionalSize
  const offset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = table + i * 40
      const va = buf.readUInt32LE(s + 12)
      const size = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16))
      if (rva >= va && rva < va + size) return rva - va + buf.readUInt32LE(s + 20)
    }
    return -1
  }
  const names = []
  for (let entry = offset(importRva); entry >= 0 && entry + 20 <= buf.length; entry += 20) {
    const nameRva = buf.readUInt32LE(entry + 12)
    if (!nameRva) break
    const at = offset(nameRva)
    if (at < 0) break
    names.push(buf.toString('latin1', at, buf.indexOf(0, at)))
  }
  return names
}

function* binaries(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) yield* binaries(full)
    else if (/\.(exe|dll|node)$/i.test(entry.name)) yield full
  }
}

/** Each binary's imports that a clean Windows install cannot resolve. */
export function missingDllImports(root) {
  const folders = new Map()
  const local = (dir) => {
    if (!folders.has(dir)) {
      folders.set(dir, new Set(fs.readdirSync(dir).map((name) => name.toLowerCase())))
    }
    return folders.get(dir)
  }
  const missing = []
  for (const file of binaries(root)) {
    const imports = peImports(file)
    if (!imports) continue
    const beside = local(path.dirname(file))
    const absent = imports.filter((name) => {
      const lower = name.toLowerCase()
      return !beside.has(lower) && !isWindowsDll(name) && !HOST_MODULES.has(lower)
    })
    if (absent.length) missing.push({ file: path.relative(root, file), absent })
  }
  return missing
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2]
  if (!root || !fs.existsSync(root)) {
    console.error('Usage: node scripts/verify-windows-dll-imports.mjs <packaged app folder>')
    process.exit(2)
  }
  const missing = missingDllImports(root)
  for (const { file, absent } of missing) {
    console.error(`${file}: needs ${absent.join(', ')}, which is not beside it or part of Windows`)
  }
  if (missing.length) {
    console.error(`${missing.length} Windows binaries would fail to load on a clean install.`)
    process.exit(1)
  }
  console.log('Every Windows binary finds the DLLs it imports.')
}

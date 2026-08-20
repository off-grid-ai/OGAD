import React, { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { DeviceMobile, WarningCircle, Eye, EyeSlash } from '@phosphor-icons/react'
import { CopyButton } from './ui/CopyButton'

interface PairingInfo {
  mcpUrl: string
  token: string
  deviceName: string
  lanIps: string[]
  port: number
  qr: string
}

function CodeRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</div>
        <div className="truncate text-xs text-neutral-300">{value}</div>
      </div>
      <CopyButton text={value} />
    </div>
  )
}

/** "Pair a device": shows a QR (and a copyable code fallback) a phone scans to run
 *  this Mac's MCP action tools. The QR carries the /mcp URL + the pairing token, so
 *  scanning fills everything in - no typing. Same data as the manual flow. */
export function PairDevicePanel(): React.ReactElement {
  const [info, setInfo] = useState<PairingInfo | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [err, setErr] = useState(false)

  useEffect(() => {
    window.api.pairing
      .info()
      .then(setInfo)
      .catch(() => setErr(true))
  }, [])

  if (err) {
    return <p className="text-sm text-neutral-400">Could not load pairing details.</p>
  }
  if (!info) {
    return <p className="text-sm text-neutral-500">Loading pairing details...</p>
  }

  const noNetwork = info.lanIps.length === 0
  const otherNets = info.lanIps.length - 1

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-relaxed text-neutral-400">
        Run this Mac&apos;s tools from Off Grid on your phone. In the mobile app, tap{' '}
        <span className="text-neutral-200">Connect desktop tools</span> and scan this code - it
        fills in everything, including the pairing token. Both devices must be on the same network.
      </p>

      {noNetwork ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
          <WarningCircle className="h-4 w-4 shrink-0" />
          No local network found. Connect this Mac to Wi-Fi, then reopen this panel.
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="rounded-xl bg-white p-3">
            <QRCodeSVG value={info.qr} size={168} marginSize={0} />
          </div>
          <div className="flex flex-1 flex-col gap-2 text-sm">
            <div className="flex items-center gap-2 text-neutral-200">
              <DeviceMobile className="h-4 w-4 text-emerald-400" />
              <span className="font-medium">{info.deviceName}</span>
            </div>
            <p className="text-xs text-neutral-500">
              Serving at {info.mcpUrl}
              {otherNets > 0 ? ` (+${otherNets} other network${otherNets > 1 ? 's' : ''})` : ''}
            </p>
            <button
              onClick={() => setShowCode((v) => !v)}
              className="mt-1 inline-flex w-fit items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300"
            >
              {showCode ? <EyeSlash className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showCode ? 'Hide code' : 'Cannot scan? Enter it by hand'}
            </button>
          </div>
        </div>
      )}

      {showCode && !noNetwork && (
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
          <CodeRow label="Server URL" value={info.mcpUrl} />
          <CodeRow label="Header name" value="Authorization" />
          <CodeRow label="Header value" value={`Bearer ${info.token}`} />
          <p className="text-[11px] text-neutral-500">
            In the app: Add MCP server from URL, choose Request header, and paste these.
          </p>
        </div>
      )}
    </div>
  )
}

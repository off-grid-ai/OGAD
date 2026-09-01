import { formatGatewayDataUrl, parseGatewayDataUrl } from '@offgrid/models'
import { mimeForExt } from '../mime'

/** Node byte adapter for the shared data-URL contract. */
export function decodeDataUrl(url: string): { data: Buffer; mime: string } {
  const parsed = parseGatewayDataUrl(url)
  const data =
    parsed.encoding === 'base64'
      ? Buffer.from(parsed.payload, 'base64')
      : Buffer.from(decodeURIComponent(parsed.payload))
  return { data, mime: parsed.mime }
}

export function mimeFromExt(ext: string): string {
  return mimeForExt(ext, 'image/png')
}

export function toDataUrl(data: Buffer, mime: string): string {
  return formatGatewayDataUrl(data.toString('base64'), mime)
}

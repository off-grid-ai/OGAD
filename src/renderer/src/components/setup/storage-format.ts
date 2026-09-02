export function formatStorageBytes(bytes: number): string {
  if (!bytes) return '0 bytes'
  if (bytes < 1_000) return `${bytes} bytes`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

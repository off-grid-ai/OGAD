import { describe, expect, it } from 'vitest'
import { formatStorageBytes } from '../storage-format'

describe('formatStorageBytes', () => {
  it('formats empty, megabyte, and gigabyte sizes consistently', () => {
    expect(formatStorageBytes(0)).toBe('0 bytes')
    expect(formatStorageBytes(512)).toBe('512 bytes')
    expect(formatStorageBytes(1_024)).toBe('1 KB')
    expect(formatStorageBytes(3_000_000)).toBe('3 MB')
    expect(formatStorageBytes(1_500_000_000)).toBe('1.5 GB')
  })
})

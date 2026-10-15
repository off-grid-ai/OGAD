import { describe, expect, it } from 'vitest'
import { parseLinuxDriverVersion } from '../nvidia-driver'

describe('NVIDIA driver version', () => {
  it('reads the kernel module version from /proc/driver/nvidia/version', () => {
    expect(
      parseLinuxDriverVersion(
        'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22 01:44:30 UTC 2024\nGCC version:  gcc version 12.3.0\n'
      )
    ).toBe('550.54.14')
    expect(
      parseLinuxDriverVersion(
        'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.82.07  Release Build  (dvs-builder@U16)\n'
      )
    ).toBe('580.82.07')
  })

  it('returns null for text without a version', () => {
    expect(parseLinuxDriverVersion('no driver here')).toBeNull()
  })
})

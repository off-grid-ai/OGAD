import { describe, expect, it } from 'vitest'
import { nvidiaSmiPath } from '../vram-probe'

// The filesystem is the boundary: which driver files exist on this machine.
const installed =
  (...files: string[]) =>
  (file: string): boolean =>
    files.includes(file)

describe('nvidiaSmiPath', () => {
  it('runs nvidia-smi from where the driver installs it, never from PATH', () => {
    expect(nvidiaSmiPath('linux', installed('/usr/bin/nvidia-smi'))).toBe('/usr/bin/nvidia-smi')
    expect(nvidiaSmiPath('linux', installed('/usr/local/nvidia/bin/nvidia-smi'))).toBe(
      '/usr/local/nvidia/bin/nvidia-smi'
    )
    expect(
      nvidiaSmiPath(
        'win32',
        installed('C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe')
      )
    ).toBe('C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe')
  })

  it('finds none where no driver is installed, or on a Mac', () => {
    expect(nvidiaSmiPath('linux', installed())).toBeNull()
    expect(nvidiaSmiPath('darwin', installed('/usr/bin/nvidia-smi'))).toBeNull()
  })
})

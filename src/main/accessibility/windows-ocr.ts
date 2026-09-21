import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BoxedOcrResult, OcrBlock } from '../ocr'
import { psQuote } from './ax-uia-script'

const execFileAsync = promisify(execFile)

export function windowsOcrScript(imagePath: string): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
function Await($operation, $resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync(${psQuote(imagePath)})) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw 'No Windows OCR language is installed.' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$blocks = @()
foreach ($line in $result.Lines) {
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    $blocks += [ordered]@{
      text = $word.Text
      confidence = 1.0
      bounds = [ordered]@{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }
    }
  }
}
[ordered]@{ width=$bitmap.PixelWidth; height=$bitmap.PixelHeight; blocks=$blocks } | ConvertTo-Json -Depth 5 -Compress
`.trim()
}

export async function runWindowsOCR(imagePath: string): Promise<BoxedOcrResult> {
  if (process.platform !== 'win32') {
    return {
      width: 0,
      height: 0,
      blocks: [],
      available: false,
      degradedReason: 'platform_unsupported'
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsOcrScript(imagePath)
      ],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    )
    const result = JSON.parse(stdout) as { width?: unknown; height?: unknown; blocks?: OcrBlock[] }
    return {
      width: typeof result.width === 'number' ? result.width : 0,
      height: typeof result.height === 'number' ? result.height : 0,
      blocks: Array.isArray(result.blocks) ? result.blocks : [],
      available: true
    }
  } catch {
    return {
      width: 0,
      height: 0,
      blocks: [],
      available: false,
      degradedReason: 'windows_ocr_unavailable'
    }
  }
}

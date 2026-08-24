/**
 * PowerShell + Windows UI Automation scripts - the Windows analogue of the macOS
 * Swift `text-extractor` helper for the accessibility rail. UIA is the OS
 * accessibility API (System.Windows.Automation), so a normal chat model can drive
 * an app by element LABEL with no grounder, exactly like the mac AX rail. Uses
 * PowerShell (no compiled binary), mirroring the Windows semantic rail.
 *
 * Pure string builders, kept Electron-free and unit-tested for the CONTRACT the TS
 * side parses (parseAxElements): a `[WINDOW_TITLE] <title>` line, then one compact
 * JSON object per interactive element - {role,label,value,x,y,w,h,press,enabled}.
 * Coordinates are UIA BoundingRectangle in PHYSICAL screen pixels, which is the
 * space the nut.js actuator uses on Windows - so NO DIP scaling is applied here
 * (unlike the vision rail, whose screenshot is in DIP).
 */

/** Single-quote a value for a PowerShell string literal (embedded quotes doubled).
 *  This is the injection boundary: an app name is only ever a quoted literal. */
export function psQuote(value: string): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** `--apps`: one display name per line for every app that owns a foreground window. */
export const UIA_APPS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$seen = @{}
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  $name = $_.ProcessName
  try { $p = $_.MainModule.FileVersionInfo.ProductName; if ($p) { $name = $p } } catch {}
  if ($name -and -not $seen.ContainsKey($name)) { $seen[$name] = $true; Write-Output $name }
}
`.trim()

/** The `Get-Process | Where-Object ...` clause that finds the target app's windowed
 *  process by process name OR window title - shared by the elements + activate scripts. */
function targetProcessClause(appName: string): string {
  return `$target = ${psQuote(appName)}
$proc = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    $_.ProcessName -like ('*' + $target + '*') -or $_.MainWindowTitle -like ('*' + $target + '*')
  )
} | Select-Object -First 1`
}

/** `--elements <app>`: walk one app's UIA control tree and emit the ax-elements
 *  contract. Fail-closed: any error emits nothing, so parseAxElements returns an
 *  empty snapshot and the router falls through to the vision rail. */
export function uiaElementsScript(appName: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
${targetProcessClause(appName)}
if (-not $proc) { exit }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $root) { exit }
Write-Output ('[WINDOW_TITLE] ' + $root.Current.Name)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$stack = New-Object System.Collections.Stack
$stack.Push($root)
$count = 0
while ($stack.Count -gt 0 -and $count -lt 400) {
  $el = $stack.Pop()
  try {
    $c = $el.Current
    $r = $c.BoundingRectangle
    if (-not $c.IsOffscreen -and $r.Width -ge 3 -and $r.Height -ge 3) {
      $role = ($c.ControlType.ProgrammaticName -replace 'ControlType\\.','')
      $press = $false
      try { $press = ($el.GetSupportedPatterns() -contains [System.Windows.Automation.InvokePattern]::Pattern) } catch {}
      $val = ''
      try {
        if (-not $c.IsPassword) {
          $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          if ($vp) { $val = $vp.Current.Value }
        }
      } catch {}
      $obj = [ordered]@{ role=$role; label=$c.Name; value=$val; x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height; press=$press; enabled=$c.IsEnabled }
      Write-Output ($obj | ConvertTo-Json -Compress)
      $count++
    }
  } catch {}
  try {
    $child = $walker.GetFirstChild($el)
    while ($child) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
  } catch {}
}
`.trim()
}

/** Bring the target app's window to the foreground so synthetic clicks land on it -
 *  the `open -a` equivalent (SW_RESTORE + SetForegroundWindow). Best-effort. */
export function uiaActivateScript(appName: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
${targetProcessClause(appName)}
if ($proc) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OffGridFg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@
  [OffGridFg]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
  [OffGridFg]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
}
`.trim()
}

import { describe, expect, it } from 'vitest'
import {
  psQuote,
  UIA_APPS_SCRIPT,
  uiaActivateScript,
  uiaElementsScript
} from '../ax-uia-script'

describe('psQuote', () => {
  it('wraps in single quotes and doubles embedded quotes (PowerShell injection boundary)', () => {
    expect(psQuote('Slack')).toBe("'Slack'")
    expect(psQuote("O'Brien")).toBe("'O''Brien'")
  })

  it('never leaves an app name unquoted in a built script', () => {
    // A malicious app name must stay inside the quoted literal - the doubled quote
    // keeps it from breaking out into a new statement.
    const script = uiaElementsScript("x'; Remove-Item C:\\ -Recurse; '")
    expect(script).toContain("'x''; Remove-Item C:\\ -Recurse; '''")
    expect(script).not.toMatch(/\$target = 'x';\s*Remove-Item/)
  })
})

describe('UIA_APPS_SCRIPT', () => {
  it('lists windowed processes (the --apps mode)', () => {
    expect(UIA_APPS_SCRIPT).toContain('Get-Process')
    expect(UIA_APPS_SCRIPT).toContain('MainWindowHandle')
    expect(UIA_APPS_SCRIPT).toContain('Write-Output')
  })
})

describe('uiaElementsScript', () => {
  const script = uiaElementsScript('Slack')

  it('loads UI Automation and targets the named app', () => {
    expect(script).toContain('Add-Type -AssemblyName UIAutomationClient')
    expect(script).toContain("$target = 'Slack'")
    expect(script).toContain('AutomationElement]::FromHandle')
  })

  it('emits the parseAxElements contract: [WINDOW_TITLE] + JSON with every field', () => {
    expect(script).toContain("Write-Output ('[WINDOW_TITLE] '")
    expect(script).toContain('ConvertTo-Json -Compress')
    // Every field parseAxElements reads must be produced.
    for (const key of ['role', 'label', 'value', 'x', 'y', 'w', 'h', 'press', 'enabled']) {
      expect(script).toContain(`${key}=`)
    }
  })

  it('drops offscreen / sub-3px artifacts (same guard as the mac helper + parser)', () => {
    expect(script).toContain('IsOffscreen')
    expect(script).toContain('$r.Width -ge 3 -and $r.Height -ge 3')
  })

  it('never leaks a secure field value + marks Invoke-able elements as pressable', () => {
    expect(script).toContain('IsPassword')
    expect(script).toContain('InvokePattern]::Pattern')
  })

  it('bounds the tree walk so a huge app cannot hang the step', () => {
    expect(script).toContain('$count -lt 400')
  })
})

describe('uiaActivateScript', () => {
  it('foregrounds the target window (the open -a equivalent)', () => {
    const script = uiaActivateScript('Notepad')
    expect(script).toContain("$target = 'Notepad'")
    expect(script).toContain('SetForegroundWindow')
    expect(script).toContain('ShowWindow')
  })
})

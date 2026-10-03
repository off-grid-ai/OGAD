param([int]$KeyCode = 49, [string]$Modifier = 'option')
# Existing saved ANSI key codes are translated at the operating-system boundary.
$Letters = @{0='A';1='S';2='D';3='F';4='H';5='G';6='Z';7='X';8='C';9='V';11='B';12='Q';13='W';14='E';15='R';16='Y';17='T';31='O';32='U';34='I';35='P';37='L';38='J';40='K';45='N';46='M'}
$Other = @{18=49;19=50;20=51;21=52;22=54;23=53;24=187;25=57;26=55;27=189;28=56;29=48;30=221;33=219;36=13;39=222;41=186;42=220;43=188;44=191;47=190;48=9;49=32;50=192}
$VirtualKey = if ($Letters.ContainsKey($KeyCode)) { [int][char]$Letters[$KeyCode] } else { $Other[$KeyCode] }
$ModifierKey = switch ($Modifier) { 'option' {18} 'control' {17} 'command' {91} 'shift' {16} default {throw 'Unsupported shortcut modifier'} }
if (-not $VirtualKey) { throw 'Unsupported shortcut key' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OffGridHotkey {
    [StructLayout(LayoutKind.Sequential)] public struct Message {
        public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam;
        public uint time; public int x; public int y; public uint privateData;
    }
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll")] public static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
}
'@
$NativeModifier = switch ($Modifier) { 'option' {1} 'control' {2} 'shift' {4} 'command' {8} }
# Register the chord so Windows does not also open its Alt+Space window menu.
if (-not [OffGridHotkey]::RegisterHotKey([IntPtr]::Zero, 72, ($NativeModifier -bor 0x4000), $VirtualKey)) {
    throw 'The dictation shortcut is already in use.'
}
$Held = $false
try {
    while ($true) {
        $Message = New-Object OffGridHotkey+Message
        while ([OffGridHotkey]::PeekMessage([ref]$Message, [IntPtr]::Zero, 0, 0, 1)) {}
        $ModifierDown = (([OffGridHotkey]::GetAsyncKeyState($ModifierKey) -band 0x8000) -ne 0)
        if ($Modifier -eq 'command') { $ModifierDown = $ModifierDown -or (([OffGridHotkey]::GetAsyncKeyState(92) -band 0x8000) -ne 0) }
        $ExtraModifierDown = $false
        foreach ($OtherModifier in @('option', 'control', 'shift', 'command')) {
            if ($OtherModifier -eq $Modifier) { continue }
            $OtherKey = switch ($OtherModifier) { 'option' {18} 'control' {17} 'shift' {16} 'command' {91} }
            $OtherDown = (([OffGridHotkey]::GetAsyncKeyState($OtherKey) -band 0x8000) -ne 0)
            if ($OtherModifier -eq 'command') { $OtherDown = $OtherDown -or (([OffGridHotkey]::GetAsyncKeyState(92) -band 0x8000) -ne 0) }
            $ExtraModifierDown = $ExtraModifierDown -or $OtherDown
        }
        $Down = (([OffGridHotkey]::GetAsyncKeyState($VirtualKey) -band 0x8000) -ne 0) -and $ModifierDown -and (-not $ExtraModifierDown)
        if ($Down -ne $Held) {
            [Console]::WriteLine($(if ($Down) {'down'} else {'up'}))
            $Held = $Down
        }
        Start-Sleep -Milliseconds 10
    }
} finally {
    [void][OffGridHotkey]::UnregisterHotKey([IntPtr]::Zero, 72)
}

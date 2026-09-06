// Off Grid AI dictation hotkey helper. Watches the configured chord (default
// Option+Space) globally via a CGEventTap and prints "down" / "up" on stdout so
// the Electron main process can drive push-to-talk (Electron's globalShortcut
// only sees key-DOWN; this gives us key-UP). Needs Accessibility permission —
// the same grant the paste keystroke already requires. It swallows the chord so
// the key (space) isn't typed into the focused app.
//
// Usage: dictation-hotkey --keycode 49 --modifier option

import Foundation
import CoreGraphics

// Globals — a CGEventTapCallBack is a C function pointer and cannot capture Swift
// context, so all state the callback touches lives at file scope.
var gKeyCode: Int64 = 49 // 49 = Space
var gModifier: CGEventFlags = .maskAlternate // Option
var gPressed = false
var gTap: CFMachPort?

func maskFor(_ name: String) -> CGEventFlags {
  switch name.lowercased() {
  case "command", "cmd": return .maskCommand
  case "control", "ctrl": return .maskControl
  case "shift": return .maskShift
  default: return .maskAlternate // option / alt
  }
}

// Parse CLI args.
do {
  let args = CommandLine.arguments
  var i = 1
  while i < args.count {
    switch args[i] {
    case "--keycode":
      if i + 1 < args.count { gKeyCode = Int64(args[i + 1]) ?? gKeyCode; i += 1 }
    case "--modifier":
      if i + 1 < args.count { gModifier = maskFor(args[i + 1]); i += 1 }
    default:
      break
    }
    i += 1
  }
}

// Unbuffered stdout so the parent sees each line immediately.
setvbuf(stdout, nil, _IONBF, 0)

let callback: CGEventTapCallBack = { _, type, event, _ in
  // The system can disable the tap (timeout / user input) — re-enable it. If a key
  // was held when this happened, we may have missed the matching key-up, so emit an
  // "up" and clear gPressed; otherwise the next press is swallowed (line ~59) and
  // push-to-talk gets stuck.
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if gPressed { gPressed = false; print("up") }
    if let tap = gTap { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }

  let code = event.getIntegerValueField(.keyboardEventKeycode)
  if code == gKeyCode {
    if type == .keyDown, event.flags.contains(gModifier) {
      if !gPressed { gPressed = true; print("down") } // ignore auto-repeat
      return nil // swallow so the app doesn't receive the keystroke
    }
    if type == .keyUp, gPressed {
      gPressed = false
      print("up")
      return nil
    }
  }
  return Unmanaged.passUnretained(event)
}

let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
guard
  let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(mask),
    callback: callback,
    userInfo: nil
  )
else {
  FileHandle.standardError.write("dictation-hotkey: failed to create event tap (Accessibility not granted?)\n".data(using: .utf8)!)
  exit(1)
}
gTap = tap
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
CFRunLoopRun()

import Cocoa
import ApplicationServices

// Event-driven focus watcher (screenpipe-style). Instead of polling
// NSWorkspace.frontmostApplication (unreliable for a spawned helper — it never
// saw the terminal), we run a real NSApplication and observe
// NSWorkspace.didActivateApplication, which hands us the activated app directly.
// A low-frequency heartbeat re-captures the current app so content changes
// within the same app are still picked up. Text content is intentionally light
// (the focused element's value); the real on-screen content comes from OCR
// downstream.

struct WindowContext: Codable {
    let appName: String
    let title: String
    let selectedText: String
    let content: String
    let isTrusted: Bool
}

func getAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

func emit(for app: NSRunningApplication) {
    guard AXIsProcessTrusted() else {
        print("{\"isTrusted\": false}")
        return
    }
    let appName = app.localizedName ?? "Unknown"
    let appElement = AXUIElementCreateApplication(app.processIdentifier)

    var title = ""
    var content = ""
    var selectedText = ""

    // Focused window title.
    if let win = getAttribute(appElement, kAXFocusedWindowAttribute) {
        let window = win as! AXUIElement
        if let t = getAttribute(window, kAXTitleAttribute) as? String { title = t }
    }
    // Focused element value/selection (cheap; OCR supplies the full content).
    if let focused = getAttribute(appElement, kAXFocusedUIElementAttribute) {
        let el = focused as! AXUIElement
        if let v = getAttribute(el, kAXValueAttribute) as? String { content = v }
        if let s = getAttribute(el, kAXSelectedTextAttribute) as? String { selectedText = s }
    }

    let ctx = WindowContext(appName: appName, title: title, selectedText: selectedText, content: content, isTrusted: true)
    if let data = try? JSONEncoder().encode(ctx), let json = String(data: data, encoding: .utf8) {
        print(json)
    }
}

setbuf(stdout, nil)

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // faceless helper, no dock icon

let ws = NSWorkspace.shared
var current: NSRunningApplication? = ws.frontmostApplication

// Event-driven: fire whenever the active app changes (this is what the old poll
// missed). Delivered on the main run loop via NSApplication.run().
ws.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
    if let activated = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        current = activated
        emit(for: activated)
    }
}

// Initial capture + heartbeat to catch content changes within the same app.
if let c = current { emit(for: c) }
Timer.scheduledTimer(withTimeInterval: 8.0, repeats: true) { _ in
    if let c = ws.frontmostApplication ?? current { emit(for: c) }
}

app.run()

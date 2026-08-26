import Cocoa
import ApplicationServices

// R5 T1c - the accessibility DRIVING rail's producer. `text-extractor --elements
// <app>` walks the focused window's AX tree and emits one JSON object per
// interactive element: role, label, value, screen frame (x/y/w/h), whether it
// exposes AXPress, and enabled. This is the machine-readable twin of the text
// mode, and the exact contract parseAxElements (src/main/accessibility) is
// tested against - keep the two in step.

// Roles that are actionable/targetable for driving. Kept intentionally broad;
// the frame + AXPress presence do the real filtering.
let interactiveRoles: Set<String> = [
    "AXButton", "AXMenuButton", "AXPopUpButton", "AXMenuItem", "AXMenuBarItem",
    "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox",
    "AXLink", "AXTabButton", "AXTab", "AXSlider", "AXStepper", "AXSearchField",
    "AXDisclosureTriangle", "AXIncrementor", "AXSwitch", "AXToggle", "AXCell"
]

func axStr(_ el: AXUIElement, _ attr: String) -> String? {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if let s = v as? String, !s.isEmpty { return s }
    return nil
}

func axFrame(_ el: AXUIElement) -> (Int, Int, Int, Int)? {
    var posVal: AnyObject?
    var sizeVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal)
    AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeVal)
    guard let pos = posVal, let size = sizeVal,
          CFGetTypeID(pos) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var dims = CGSize.zero
    AXValueGetValue(pos as! AXValue, .cgPoint, &point)
    AXValueGetValue(size as! AXValue, .cgSize, &dims)
    return (Int(point.x), Int(point.y), Int(dims.width), Int(dims.height))
}

func axHasPress(_ el: AXUIElement) -> Bool {
    var actions: CFArray?
    AXUIElementCopyActionNames(el, &actions)
    if let list = actions as? [String] { return list.contains("AXPress") }
    return false
}

func axEnabled(_ el: AXUIElement) -> Bool {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXEnabledAttribute as CFString, &v)
    if let b = v as? Bool { return b }
    return true
}

func jsonEscape(_ s: String) -> String {
    var out = ""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
        }
    }
    return out
}

func elementLabel(_ el: AXUIElement) -> String {
    return axStr(el, kAXTitleAttribute as String)
        ?? axStr(el, kAXDescriptionAttribute as String)
        ?? axStr(el, "AXPlaceholderValue")
        ?? axStr(el, kAXHelpAttribute as String)
        ?? ""
}

let axDebug = ProcessInfo.processInfo.environment["AX_ELEMENTS_DEBUG"] == "1"

func walkElements(_ el: AXUIElement, depth: Int, out: inout [String]) {
    if depth > 45 || out.count > 400 { return }
    let role = axStr(el, kAXRoleAttribute as String) ?? ""
    if axDebug {
        let label = elementLabel(el)
        let frame = axFrame(el)
        FileHandle.standardError.write(
            "\(String(repeating: "  ", count: min(depth, 20)))[\(depth)] \(role) '\(label.prefix(30))' frame=\(String(describing: frame)) press=\(axHasPress(el))\n".data(using: .utf8)!
        )
    }
    if interactiveRoles.contains(role), let (x, y, w, h) = axFrame(el), w > 0, h > 0 {
        let label = elementLabel(el)
        // Never emit a secure field's contents.
        let secure = axStr(el, "AXSubrole") == "AXSecureTextField"
        let value = secure ? "" : (axStr(el, kAXValueAttribute as String) ?? "")
        out.append(
            "{\"role\":\"\(jsonEscape(role))\",\"label\":\"\(jsonEscape(label))\",\"value\":\"\(jsonEscape(value))\",\"x\":\(x),\"y\":\(y),\"w\":\(w),\"h\":\(h),\"press\":\(axHasPress(el)),\"enabled\":\(axEnabled(el))}"
        )
    }
    var childrenVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal)
    if let children = childrenVal as? [AXUIElement] {
        for child in children { walkElements(child, depth: depth + 1, out: &out) }
    }
}

/** The app's focused window (preferred) or its first window, re-resolved each
 *  attempt so the retry loop sees a tree that appeared after the trigger. */
func resolveWindow(_ appElem: AXUIElement) -> AXUIElement? {
    var focusedWin: AnyObject?
    AXUIElementCopyAttributeValue(appElem, kAXFocusedWindowAttribute as CFString, &focusedWin)
    if let focused = focusedWin, CFGetTypeID(focused) == AXUIElementGetTypeID() {
        return (focused as! AXUIElement)
    }
    var windows: AnyObject?
    AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &windows)
    if let list = windows as? [AXUIElement], let first = list.first { return first }
    return nil
}

/** Pick the real app for a name: a foreground (.regular) app, preferring an
 *  exact localizedName match over a substring, so "Safari" resolves the browser
 *  and not a background "…Safari Web Content" helper with no window. */
func resolveApp(_ appName: String) -> NSRunningApplication? {
    let wanted = appName.lowercased()
    let regular = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    if let exact = regular.first(where: { ($0.localizedName ?? "").lowercased() == wanted }) {
        return exact
    }
    if let sub = regular.first(where: { ($0.localizedName ?? "").lowercased().contains(wanted) }) {
        return sub
    }
    // Last resort: any running app (agents included) whose name matches.
    return NSWorkspace.shared.runningApplications.first(where: {
        ($0.localizedName ?? "").lowercased().contains(wanted)
    })
}

/** List the foreground (.regular) running apps, one localizedName per line.
 *  NSWorkspace needs no Screen-Recording / Accessibility grant, so this is a
 *  reliable candidate list for target resolution (get-windows under-reports
 *  without Screen Recording). */
func runAppsList() {
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        if let name = app.localizedName, !name.isEmpty { print(name) }
    }
}

/** Classify the frontmost app's focused field without reading or emitting its
 * value. Vision Computer Use uses this immediately before synthetic typing. */
func runFocusedElementInspector() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options),
          let app = NSWorkspace.shared.frontmostApplication
    else {
        print("{\"state\":\"unknown\"}")
        return
    }
    let appElem = AXUIElementCreateApplication(app.processIdentifier)
    var focusedValue: AnyObject?
    let result = AXUIElementCopyAttributeValue(
        appElem,
        kAXFocusedUIElementAttribute as CFString,
        &focusedValue
    )
    guard result == .success,
          let focused = focusedValue,
          CFGetTypeID(focused) == AXUIElementGetTypeID()
    else {
        print("{\"state\":\"unknown\"}")
        return
    }
    let element = focused as! AXUIElement
    let role = axStr(element, kAXRoleAttribute as String) ?? ""
    let subrole = axStr(element, kAXSubroleAttribute as String) ?? ""
    let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
    if secure {
        print("{\"state\":\"secure\"}")
        return
    }
    let editableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"
    ]
    var settable = DarwinBoolean(false)
    let settableResult = AXUIElementIsAttributeSettable(
        element,
        kAXValueAttribute as CFString,
        &settable
    )
    if editableRoles.contains(role) && settableResult == .success && settable.boolValue {
        print("{\"state\":\"safe\"}")
    } else {
        print("{\"state\":\"unknown\"}")
    }
}

func runElementsExtractor(_ appName: String) {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    if !AXIsProcessTrustedWithOptions(options) {
        print("Accessibility permissions not granted")
        exit(1)
    }
    guard let app = resolveApp(appName) else {
        print("[WINDOW_TITLE] (app not running)")
        return
    }
    let appElem = AXUIElementCreateApplication(app.processIdentifier)
    // Chromium/Electron/WebKit apps (Slack, Code, Chrome, Discord, ...) build NO
    // web-content accessibility tree until a client asks for it. These "an
    // assistive client is here" attributes trigger the full tree; without them a
    // window has a title but zero elements. Harmless on native apps. The tree is
    // built ASYNChronously, so the first read can be empty - retry until it
    // populates (or a native window that is simply control-thin gives up).
    AXUIElementSetAttributeValue(appElem, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(appElem, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    var elements: [String] = []
    var window: AXUIElement? = nil
    for attempt in 0..<5 {
        usleep(attempt == 0 ? 250_000 : 350_000)
        guard let win = resolveWindow(appElem) else { continue }
        window = win
        elements = []
        walkElements(win, depth: 0, out: &elements)
        if !elements.isEmpty { break }
    }
    if let win = window, let title = axStr(win, kAXTitleAttribute as String) {
        print("[WINDOW_TITLE] \(title)")
    }
    for line in elements { print(line) }
}

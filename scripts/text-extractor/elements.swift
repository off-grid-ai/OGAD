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

// Read-only semantic state must remain visible to planning and verification.
// These items are evidence only: they never become click targets.
let evidenceRoles: Set<String> = [
    "AXStaticText", "AXHeading", "AXImage", "AXValueIndicator"
]

func axStr(_ el: AXUIElement, _ attr: String) -> String? {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if let s = v as? String, !s.isEmpty { return s }
    return nil
}

// AXValue is numeric for controls such as sliders and steppers. Keep that
// state in the observation instead of silently dropping it because it is not a
// String. The structured rail can then verify the value, while actuation still
// uses a value-aware path rather than an arbitrary center click.
func axDisplayValue(_ el: AXUIElement) -> String? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(
        el,
        kAXValueAttribute as CFString,
        &value
    ) == .success else { return nil }
    if let string = value as? String, !string.isEmpty { return string }
    if let number = value as? NSNumber { return number.stringValue }
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

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else {
        return nil
    }
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

func axNumber(_ el: AXUIElement, _ attr: String) -> Double? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success,
          let number = value as? NSNumber else { return nil }
    return number.doubleValue
}

func axValueIsSettable(_ el: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(
        el,
        kAXValueAttribute as CFString,
        &settable
    ) == .success && settable.boolValue
}

func axHasPopup(_ el: AXUIElement, role: String) -> Bool {
    guard role == "AXMenuItem" || role == "AXMenuBarItem" else { return false }
    var childrenValue: AnyObject?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenValue) == .success,
          let children = childrenValue as? [AXUIElement]
    else { return false }
    return !children.isEmpty
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
let elementWalkDeadline = 0.6

func walkElements(
    _ el: AXUIElement,
    depth: Int,
    startedAt: Date,
    focusedElement: AXUIElement?,
    out: inout [String]
) {
    if depth > 45 || out.count > 400 || Date().timeIntervalSince(startedAt) >= elementWalkDeadline { return }
    let role = axStr(el, kAXRoleAttribute as String) ?? ""
    if axDebug {
        let label = elementLabel(el)
        let frame = axFrame(el)
        FileHandle.standardError.write(
            "\(String(repeating: "  ", count: min(depth, 20)))[\(depth)] \(role) '\(label.prefix(30))' frame=\(String(describing: frame)) press=\(axHasPress(el))\n".data(using: .utf8)!
        )
    }
    let interactive = interactiveRoles.contains(role)
    let evidence = evidenceRoles.contains(role)
    if (interactive || evidence), let (x, y, w, h) = axFrame(el), w > 0, h > 0 {
        let label = elementLabel(el)
        // Never emit a secure field's contents.
        let secure = axStr(el, "AXSubrole") == "AXSecureTextField"
        let value = secure ? "" : (axDisplayValue(el) ?? "")
        let focused = focusedElement.map { CFEqual(el, $0) } ?? false
        let checked: Bool? = ["AXCheckBox", "AXSwitch", "AXToggle", "AXRadioButton"].contains(role)
            ? axBool(el, kAXValueAttribute as String)
            : nil
        let selected = axBool(el, kAXSelectedAttribute as String)
        let minValue = axNumber(el, "AXMinValue")
        let maxValue = axNumber(el, "AXMaxValue")
        let checkedJSON = checked.map(String.init) ?? "null"
        let selectedJSON = selected.map(String.init) ?? "null"
        let minValueJSON = minValue.map { String($0) } ?? "null"
        let maxValueJSON = maxValue.map { String($0) } ?? "null"
        if interactive || !label.isEmpty || !value.isEmpty {
            out.append(
                "{\"role\":\"\(jsonEscape(role))\",\"label\":\"\(jsonEscape(label))\",\"value\":\"\(jsonEscape(value))\",\"x\":\(x),\"y\":\(y),\"w\":\(w),\"h\":\(h),\"press\":\(axHasPress(el)),\"enabled\":\(axEnabled(el)),\"focused\":\(focused),\"checked\":\(checkedJSON),\"selected\":\(selectedJSON),\"minValue\":\(minValueJSON),\"maxValue\":\(maxValueJSON),\"valueSettable\":\(axValueIsSettable(el)),\"hasPopup\":\(axHasPopup(el, role: role)),\"executable\":\(interactive)}"
            )
        }
    }
    var childrenVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal)
    if let children = childrenVal as? [AXUIElement] {
        for child in children {
            walkElements(
                child,
                depth: depth + 1,
                startedAt: startedAt,
                focusedElement: focusedElement,
                out: &out
            )
        }
    }
}

func findWritableSlider(_ element: AXUIElement, x: Double, y: Double, depth: Int = 0) -> AXUIElement? {
    if depth > 45 { return nil }
    if axStr(element, kAXRoleAttribute as String) == "AXSlider",
       let (left, top, width, height) = axFrame(element),
       x >= Double(left), x <= Double(left + width),
       y >= Double(top), y <= Double(top + height),
       axValueIsSettable(element) {
        return element
    }
    var childrenValue: AnyObject?
    AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
    guard let children = childrenValue as? [AXUIElement] else { return nil }
    for child in children {
        if let match = findWritableSlider(child, x: x, y: y, depth: depth + 1) {
            return match
        }
    }
    return nil
}

/** Set a native slider through its AX value contract. The app and screen point
 * bind the mutation to the same visible control that the structured snapshot
 * described; callers must still perform their normal fresh-window check. */
func runSetSliderValue(_ appName: String, x: Double, y: Double, value: Double) {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options),
          let app = resolveApp(appName),
          let window = resolveWindow(AXUIElementCreateApplication(app.processIdentifier)),
          let slider = findWritableSlider(window, x: x, y: y) else {
        exit(2)
    }
    let minimum = axNumber(slider, "AXMinValue")
    let maximum = axNumber(slider, "AXMaxValue")
    if let minimum, value < minimum { exit(3) }
    if let maximum, value > maximum { exit(3) }
    guard AXUIElementSetAttributeValue(
        slider,
        kAXValueAttribute as CFString,
        NSNumber(value: value)
    ) == .success else {
        exit(4)
    }
    print(axDisplayValue(slider) ?? "")
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

/** Return the current foreground application for the execution-time ownership
 * check. This emits only the process name and never reads window contents. */
func runFrontmostAppName() {
    print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "")
}

/** Resolve the ScreenCaptureKit/CGWindow identity that belongs to the AX
 * window. PID plus the exact window rectangle is stronger than title alone. */
func platformWindowID(pid: pid_t, title: String, frame: (Int, Int, Int, Int)) -> UInt32? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    let (x, y, width, height) = frame
    let expected = CGRect(x: x, y: y, width: width, height: height)
    let candidates = windows.compactMap { window -> (id: UInt32, score: Double)? in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let id = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let boundsValue = window[kCGWindowBounds as String],
              CFGetTypeID(boundsValue as CFTypeRef) == CFDictionaryGetTypeID(),
              let bounds = CGRect(dictionaryRepresentation: boundsValue as! CFDictionary) else {
            return nil
        }
        let name = (window[kCGWindowName as String] as? String) ?? ""
        let frameDelta = abs(bounds.origin.x - expected.origin.x)
            + abs(bounds.origin.y - expected.origin.y)
            + abs(bounds.width - expected.width)
            + abs(bounds.height - expected.height)
        let titlePenalty = title.isEmpty || name == title ? 0.0 : 10_000.0
        return (id, frameDelta + titlePenalty)
    }
    return candidates.min(by: { $0.score < $1.score })?.id
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
    var focusedValue: AnyObject?
    AXUIElementCopyAttributeValue(
        appElem,
        kAXFocusedUIElementAttribute as CFString,
        &focusedValue
    )
    let focusedElement: AXUIElement? = {
        guard let value = focusedValue, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return (value as! AXUIElement)
    }()
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
        walkElements(
            win,
            depth: 0,
            startedAt: Date(),
            focusedElement: focusedElement,
            out: &elements
        )
        if !elements.isEmpty { break }
    }
    // The application menu bar is a separate AX root, not a child of the
    // focused window. Include it after the window tree so standard macOS
    // commands such as About, Settings, New, Open, and Export are available to
    // the same structured controller. Closed menus normally expose only their
    // top-level items; after one opens, the next snapshot also exposes the
    // visible menu items with usable frames.
    var menuBarValue: AnyObject?
    if AXUIElementCopyAttributeValue(
        appElem,
        kAXMenuBarAttribute as CFString,
        &menuBarValue
    ) == .success,
       let value = menuBarValue,
       CFGetTypeID(value) == AXUIElementGetTypeID() {
        walkElements(
            value as! AXUIElement,
            depth: 0,
            startedAt: Date(),
            focusedElement: focusedElement,
            out: &elements
        )
    }
    if let win = window {
        let title = axStr(win, kAXTitleAttribute as String) ?? ""
        print("[WINDOW_TITLE] \(title)")
        if let (x, y, w, h) = axFrame(win) {
            let processName = app.localizedName ?? ""
            let windowId = "\(app.processIdentifier):\(title):\(x):\(y):\(w):\(h)"
            let captureWindowId = platformWindowID(
                pid: app.processIdentifier,
                title: title,
                frame: (x, y, w, h)
            ) ?? 0
            print(
                "[WINDOW_CONTEXT] {\"pid\":\(app.processIdentifier),\"process\":\"\(jsonEscape(processName))\",\"windowId\":\"\(jsonEscape(windowId))\",\"platformWindowId\":\(captureWindowId),\"windowX\":\(x),\"windowY\":\(y),\"windowW\":\(w),\"windowH\":\(h),\"revision\":0}"
            )
        }
    }
    for line in elements { print(line) }
}

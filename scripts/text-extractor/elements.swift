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

func walkElements(_ el: AXUIElement, depth: Int, count: inout Int) {
    if depth > 45 || count > 400 { return }
    let role = axStr(el, kAXRoleAttribute as String) ?? ""
    if interactiveRoles.contains(role), let (x, y, w, h) = axFrame(el), w > 0, h > 0 {
        let label = elementLabel(el)
        // Never emit a secure field's contents.
        let secure = axStr(el, "AXSubrole") == "AXSecureTextField"
        let value = secure ? "" : (axStr(el, kAXValueAttribute as String) ?? "")
        count += 1
        print(
            "{\"role\":\"\(jsonEscape(role))\",\"label\":\"\(jsonEscape(label))\",\"value\":\"\(jsonEscape(value))\",\"x\":\(x),\"y\":\(y),\"w\":\(w),\"h\":\(h),\"press\":\(axHasPress(el)),\"enabled\":\(axEnabled(el))}"
        )
    }
    var childrenVal: AnyObject?
    AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal)
    if let children = childrenVal as? [AXUIElement] {
        for child in children { walkElements(child, depth: depth + 1, count: &count) }
    }
}

func runElementsExtractor(_ appName: String) {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    if !AXIsProcessTrustedWithOptions(options) {
        print("Accessibility permissions not granted")
        exit(1)
    }
    for app in NSWorkspace.shared.runningApplications {
        if let name = app.localizedName, name.lowercased().contains(appName.lowercased()) {
            let appElem = AXUIElementCreateApplication(app.processIdentifier)
            var focusedWin: AnyObject?
            AXUIElementCopyAttributeValue(appElem, kAXFocusedWindowAttribute as CFString, &focusedWin)
            var targetWindow: AXUIElement? = nil
            if let focused = focusedWin, CFGetTypeID(focused) == AXUIElementGetTypeID() {
                targetWindow = (focused as! AXUIElement)
            } else {
                var windows: AnyObject?
                AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &windows)
                if let list = windows as? [AXUIElement], let first = list.first { targetWindow = first }
            }
            if let win = targetWindow {
                if let title = axStr(win, kAXTitleAttribute as String) { print("[WINDOW_TITLE] \(title)") }
                var count = 0
                walkElements(win, depth: 0, count: &count)
            }
            return
        }
    }
    print("[WINDOW_TITLE] (app not running)")
}

import Cocoa
import ApplicationServices

// Dispatch helpers (platform-specific logic lives in scripts/text-extractor/*)
func getSemanticRole(element: AXUIElement) -> String {
    switch captureMode {
    case .chatgpt:
        return getSemanticRoleForChatGPT(element: element)
    case .gemini:
        return getSemanticRoleForGemini(element: element)
    case .claudeDesktop, .claudeWeb:
        if captureMode == .claudeWeb {
            return getSemanticRoleForClaudeWeb(element: element)
        }
        return getSemanticRoleForClaudeDesktop(element: element)
    case .generic:
        return getSemanticRoleForGeneric(element: element)
    }
}

func getTextForCurrentMode(element: AXUIElement, depth: Int) -> String {
    switch captureMode {
    case .chatgpt:
        return getTextChatGPT(element: element, depth: depth)
    case .gemini:
        return getTextGemini(element: element, depth: depth)
    case .claudeDesktop, .claudeWeb:
        if captureMode == .claudeWeb {
            return getTextClaudeWeb(element: element, depth: depth)
        }
        return getTextClaudeDesktop(element: element, depth: depth)
    case .generic:
        return getTextGeneric(element: element, depth: depth)
    }
}

func uiLiteralsForCurrentMode() -> Set<String> {
    switch captureMode {
    case .chatgpt:
        return uiLiteralsChatGPT
    case .gemini:
        return uiLiteralsGemini
    case .claudeDesktop, .claudeWeb:
        return uiLiteralsClaude
    case .generic:
        return uiLiteralsGeneric
    }
}

func collectLines(from element: AXUIElement) -> [String] {
    let text = getTextForCurrentMode(element: element, depth: 0)
    if text.isEmpty { return [] }
    return text.split(separator: "\n").map { String($0) }
}

// (Platform-specific UI literals, timestamp parsing, and text extraction live in their respective files.)

func selectPrimaryScrollArea(from areas: [AXUIElement]) -> AXUIElement? {
    if areas.isEmpty { return nil }
    var best: AXUIElement? = nil
    var bestScore = -1
    let uiLiterals = uiLiteralsForCurrentMode()

    for area in areas {
        let lines = collectLines(from: area)
        var score = 0
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            let clean = trimmed.replacingOccurrences(of: "^\\[.*?\\]", with: "", options: .regularExpression)
            if clean.isEmpty { continue }
            if uiLiterals.contains(clean) { continue }
            score += 1
        }
        if score > bestScore {
            bestScore = score
            best = area
        }
    }

    return best
}
func runTextExtractor() {
    let args = CommandLine.arguments
    // R5 T1c: `--elements <app>` emits the structured interactive-element list
    // for the accessibility driving rail instead of the text blob.
    if args.count >= 3 && args[1] == "--elements" {
        runElementsExtractor(args[2])
        return
    }
    // R5 T1d: the foreground running-app list for target resolution.
    if args.count >= 2 && args[1] == "--apps" {
        runAppsList()
        return
    }
    // Screenshot-only vision asks only whether the focused native field is safe.
    // The helper never reads or emits the field value.
    if args.count >= 2 && args[1] == "--focused-element" {
        runFocusedElementInspector()
        return
    }
    if args.count < 2 {
        print("Usage: text-extractor <app-name> | --elements <app-name> | --focused-element")
        exit(1)
    }

    let targetAppName = args[1]

    // Check accessibility permissions
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    if !AXIsProcessTrustedWithOptions(options) {
        print("Accessibility permissions not granted")
        exit(1)
    }

    let apps = NSWorkspace.shared.runningApplications
    for app in apps {
        if let name = app.localizedName, name.lowercased().contains(targetAppName.lowercased()) {
            let pid = app.processIdentifier
            let appElem = AXUIElementCreateApplication(pid)

            // Prefer focused window if available (better for long chats)
            var focusedWin: AnyObject?
            AXUIElementCopyAttributeValue(appElem, kAXFocusedWindowAttribute as CFString, &focusedWin)

            var targetWindow: AXUIElement? = nil
            if let focused = focusedWin, CFGetTypeID(focused) == AXUIElementGetTypeID() {
                targetWindow = (focused as! AXUIElement)
            } else {
                // Fallback to first window
                var windows: AnyObject?
                AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &windows)
                if let windowList = windows as? [AXUIElement], let mainWin = windowList.first {
                    targetWindow = mainWin
                }
            }

            if let mainWin = targetWindow {
                // Extract window title first
                var winTitle: AnyObject?
                AXUIElementCopyAttributeValue(mainWin, kAXTitleAttribute as CFString, &winTitle)
                if let title = winTitle as? String, !title.isEmpty {
                    print("[WINDOW_TITLE] \(title)")
                }

                // Attempt to extract browser URL (if present)
                var urlFallback: String? = nil
                var detectedURL: String? = nil
                if let url = findBrowserURL(element: mainWin, depth: 0, fallback: &urlFallback) {
                    detectedURL = url
                    print("[BROWSER_URL] \(url)")
                } else if let urlFallback = urlFallback {
                    detectedURL = urlFallback
                    print("[BROWSER_URL] \(urlFallback)")
                }

                // Set capture mode based on app + URL
                if targetAppName.lowercased().contains("claude") {
                    captureMode = .claudeDesktop
                } else if let url = detectedURL {
                    if isClaudeURL(url) {
                        captureMode = .claudeWeb
                    } else if isChatGPTURL(url) {
                        captureMode = .chatgpt
                    } else if isGeminiURL(url) {
                        captureMode = .gemini
                    } else {
                        captureMode = .generic
                    }
                } else {
                    captureMode = .generic
                }

                if captureMode == .gemini {
                    if let sidebarTitle = extractSelectedListItemTitle(root: mainWin) {
                        print("[CHAT_TITLE] \(sidebarTitle)")
                    }
                }

                // Attempt multi-pass scrolling extraction for long chats
                var extractionRoot: AXUIElement = mainWin
                if captureMode == .chatgpt || captureMode == .gemini {
                    var areas: [AXUIElement] = []
                    findAllScrollAreas(element: mainWin, depth: 0, results: &areas)
                    if let best = selectPrimaryScrollArea(from: areas) {
                        extractionRoot = best
                    }
                }

                let scrollArea: AXUIElement? = {
                    var role: AnyObject?
                    AXUIElementCopyAttributeValue(extractionRoot, kAXRoleAttribute as CFString, &role)
                    if let strRole = role as? String, strRole == "AXScrollArea" {
                        return extractionRoot
                    }
                    return findScrollArea(element: extractionRoot, depth: 0)
                }()
                let scrollBar = scrollArea != nil ? getVerticalScrollBar(from: scrollArea!) : nil

                var allLines: [String] = []
                var recentSet: Set<String> = []
                var recentQueue: [String] = []
                let recentLimit = 800

                func appendLines(_ lines: [String]) {
                    for line in lines {
                        if recentSet.contains(line) {
                            continue
                        }
                        allLines.append(line)
                        recentSet.insert(line)
                        recentQueue.append(line)
                        if recentQueue.count > recentLimit {
                            let removed = recentQueue.removeFirst()
                            recentSet.remove(removed)
                        }
                    }
                }

                if let bar = scrollBar, let range = getScrollRange(scrollBar: bar) {
                    let minVal = range.0
                    let maxVal = range.1
                    let steps = 50

                    // Start at top
                    setScrollValue(scrollBar: bar, value: minVal)
                    usleep(200_000)
                    appendLines(collectLines(from: extractionRoot))

                    if maxVal > minVal {
                        for i in 1...steps {
                            let t = Double(i) / Double(steps)
                            let val = minVal + (maxVal - minVal) * t
                            setScrollValue(scrollBar: bar, value: val)
                            usleep(150_000)
                            appendLines(collectLines(from: extractionRoot))
                        }
                    }
                } else {
                    // Fallback: single pass
                    appendLines(collectLines(from: extractionRoot))
                }

                if !allLines.isEmpty {
                    print(allLines.joined(separator: "\n"))
                }
            }
            break
        }
    }
}

import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let targetPid = Int(CommandLine.arguments[1]) else {
    exit(2)
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    exit(3)
}

for window in windows {
    let ownerPid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue
    let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue
    let windowId = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    if ownerPid == targetPid, layer == 0, let windowId {
        print(windowId)
        exit(0)
    }
}

exit(4)

import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
if let window = windows.first(where: { ($0[kCGWindowOwnerName as String] as? String) == "Ghostty" && ($0[kCGWindowName as String] as? String)?.contains("Workspace sidebar verification") == true }), let number = window[kCGWindowNumber as String] as? Int {
    print(number)
}

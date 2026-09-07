// Off Grid AI Desktop - one clean Computer Use frame on macOS.
//
// ScreenCaptureKit owns window exclusion. The PiP stays visible on the display, but its exact
// SCWindow is omitted before pixels exist. Output is one PNG at the requested path.

import AppKit
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--help" {
    print("usage: computer-use-capture <output.png> <display-id> <excluded-window-id> <width> <height>")
    exit(0)
}

guard CommandLine.arguments.count == 6,
      let displayID = UInt32(CommandLine.arguments[2]),
      let excludedWindowID = UInt32(CommandLine.arguments[3]),
      let width = Int(CommandLine.arguments[4]), width > 0,
      let height = Int(CommandLine.arguments[5]), height > 0 else {
    fail("usage: computer-use-capture <output.png> <display-id> <excluded-window-id> <width> <height>")
}

let outputPath = CommandLine.arguments[1]

final class StreamScreenshot: NSObject, SCStreamOutput, SCStreamDelegate {
    private let queue = DispatchQueue(label: "ai.offgrid.computer-use-capture")
    private let context = CIContext()
    private var stream: SCStream?
    private var continuation: CheckedContinuation<CGImage, Error>?
    private var settled = false

    func capture(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
            self.stream = stream
            do {
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            } catch {
                finish(.failure(error))
                return
            }
            Task {
                do {
                    try await stream.startCapture()
                } catch {
                    finish(.failure(error))
                }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen,
              CMSampleBufferDataIsReady(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
              ) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: statusRaw) == .complete,
              let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(image, from: image.extent) else { return }
        finish(.success(cgImage))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<CGImage, Error>) {
        queue.async {
            guard !self.settled else { return }
            self.settled = true
            let continuation = self.continuation
            self.continuation = nil
            Task { try? await self.stream?.stopCapture() }
            continuation?.resume(with: result)
        }
    }
}

func capture() async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
    )
    guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
        throw NSError(
            domain: "computer-use-capture",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "display \(displayID) is not available"]
        )
    }
    // A hidden PiP is not present in `onScreenWindowsOnly` and needs no exclusion.
    // If it is visible, exclude its exact native window before pixels exist.
    let excludedWindows = content.windows.filter { $0.windowID == excludedWindowID }
    let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = false
    configuration.queueDepth = 1

    if #available(macOS 14.0, *) {
        return try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
    }
    return try await StreamScreenshot().capture(filter: filter, configuration: configuration)
}

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0
Task {
    do {
        let image = try await capture()
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw NSError(
                domain: "computer-use-capture",
                code: 5,
                userInfo: [NSLocalizedDescriptionKey: "PNG encoding failed"]
            )
        }
        try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    } catch {
        FileHandle.standardError.write("capture failed: \(error.localizedDescription)\n".data(using: .utf8)!)
        exitCode = 1
    }
    semaphore.signal()
}
semaphore.wait()
exit(exitCode)

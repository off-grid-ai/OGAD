// Off Grid AI Desktop — native meeting recorder.
//
// Records the screen video + SYSTEM AUDIO (the remote participants) + the
// microphone (you), fully on-device. The key reason this exists: macOS
// ScreenCaptureKit taps the system audio mix BEFORE it reaches the output
// device, so the far side is captured reliably no matter what the user is
// listening through — built-in speakers, wired headphones, AirPods, anything.
// The Electron/getDisplayMedia "loopback" path could not do that dependably.
//
// Output: two files in the given directory —
//   screen.mov : H.264 video + AAC system audio (one SCStream clock, in sync)
//   mic.m4a    : the microphone
// Electron muxes them with the bundled ffmpeg on stop (amix), so we never have
// to do sample-accurate mixing in Swift. On a clean stop we print one JSON line
// {"screen":"…","mic":"…"} to stdout, then exit.
//
// Usage: meeting-recorder <output-dir> [display-id]
// Stop:  send SIGINT or SIGTERM (the process finalizes the files first).

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import AppKit

func errLog(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

guard CommandLine.arguments.count > 1 else {
    errLog("usage: meeting-recorder <output-dir> [platform: meet|zoom|teams]")
    exit(2)
}
let outDir = CommandLine.arguments[1]
let platform = CommandLine.arguments.count > 2 ? CommandLine.arguments[2].lowercased() : ""

// Find the actual meeting WINDOW so we record the call, not whatever display
// happens to be frontmost (multi-monitor) — and so the user can keep other apps
// in front while we still capture the call (SCStream captures occluded windows).
func pickMeetingWindow(_ content: SCShareableContent, _ platform: String) -> SCWindow? {
    let wins = content.windows.filter {
        ($0.title?.isEmpty == false) && $0.frame.width > 200 && $0.frame.height > 200
    }
    func appName(_ w: SCWindow) -> String { (w.owningApplication?.applicationName ?? "").lowercased() }
    func title(_ w: SCWindow) -> String { (w.title ?? "").lowercased() }
    let browsers = ["chrome", "brave", "safari", "edge", "arc", "firefox", "vivaldi", "opera"]
    func isBrowser(_ w: SCWindow) -> Bool { browsers.contains { appName(w).contains($0) } }
    func area(_ w: SCWindow) -> CGFloat { w.frame.width * w.frame.height }
    // The biggest browser window is, in practice, the one holding the call — the
    // robust fallback when we can't title-match the exact tab (a browser window's
    // title is only its ACTIVE tab, so a backgrounded Meet tab is invisible to us).
    let biggestBrowser = wins.filter { isBrowser($0) }.max { area($0) < area($1) }
    func titled(_ kws: [String]) -> SCWindow? {
        wins.first { w in isBrowser(w) && kws.contains { title(w).contains($0) } }
    }

    errLog("[rec] window candidates: " + wins.map { "\(appName($0))::\(title($0)) [\(Int(area($0)))]" }.joined(separator: " | "))

    switch platform {
    case "zoom":
        return wins.first { appName($0).contains("zoom") && title($0).contains("meeting") }
            ?? wins.first { appName($0).contains("zoom") }
            ?? biggestBrowser
    case "teams":
        return titled(["teams"]) ?? wins.first { appName($0).contains("teams") } ?? biggestBrowser
    default: // meet (browser)
        // Match the Meet tab by title; otherwise capture the main browser window
        // (where the call is) rather than falling through to a whole-display grab.
        return titled(["meet.google", "google meet", "meet -", "- meet", "meet"]) ?? biggestBrowser
    }
}

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let screenURL = URL(fileURLWithPath: outDir).appendingPathComponent("screen.mov")
let micURL = URL(fileURLWithPath: outDir).appendingPathComponent("mic.m4a")
try? FileManager.default.removeItem(at: screenURL)
try? FileManager.default.removeItem(at: micURL)

// MARK: - Recorder

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var started = false
    private let q = DispatchQueue(label: "ai.offgrid.meeting.rec")
    private var micRecorder: AVAudioRecorder?
    private var finished = false

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        // Prefer the meeting WINDOW; fall back to the main display if not found.
        let filter: SCContentFilter
        var outW: Int
        var outH: Int
        let scale = NSScreen.main?.backingScaleFactor ?? 2.0
        func even(_ n: Int) -> Int { n % 2 == 0 ? n : n + 1 }

        if let win = pickMeetingWindow(content, platform) {
            errLog("[rec] capturing window: \(win.title ?? "?") [\(win.owningApplication?.applicationName ?? "?")]")
            filter = SCContentFilter(desktopIndependentWindow: win)
            outW = even(Int(win.frame.width * scale))
            outH = even(Int(win.frame.height * scale))
        } else {
            let display: SCDisplay
            if let m = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) {
                display = m
            } else if let first = content.displays.first {
                display = first
            } else {
                throw NSError(domain: "rec", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
            }
            errLog("[rec] no meeting window found for '\(platform)', capturing display")
            filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            outW = display.width
            outH = display.height
        }

        let cfg = SCStreamConfiguration()
        cfg.width = outW
        cfg.height = outH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15) // 15 fps — plenty for a meeting
        cfg.queueDepth = 6
        cfg.showsCursor = true
        cfg.capturesAudio = true            // <-- system audio (the far side)
        cfg.sampleRate = 48000
        cfg.channelCount = 2

        // AVAssetWriter: H.264 video + AAC audio into screen.mov
        let w = try AVAssetWriter(outputURL: screenURL, fileType: .mov)
        let vSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outW,
            AVVideoHeightKey: outH,
        ]
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
        vIn.expectsMediaDataInRealTime = true
        let aSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128000,
        ]
        let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: aSettings)
        aIn.expectsMediaDataInRealTime = true
        if w.canAdd(vIn) { w.add(vIn) }
        if w.canAdd(aIn) { w.add(aIn) }
        self.writer = w
        self.videoInput = vIn
        self.audioInput = aIn

        // SCStream
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q)
        self.stream = s
        try await s.startCapture()

        // Mic — separate file, simplest reliable path (AVAudioRecorder records the
        // default input device). Muxed in later by ffmpeg. Best-effort: if the mic
        // is unavailable we still record the screen + far side.
        let micSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 96000,
        ]
        do {
            let mr = try AVAudioRecorder(url: micURL, settings: micSettings)
            if mr.record() { self.micRecorder = mr } else { errLog("[rec] mic record() returned false") }
        } catch {
            errLog("[rec] mic unavailable: \(error.localizedDescription)")
        }
    }

    // SCStream sample callback
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard CMSampleBufferDataIsReady(sampleBuffer), let writer = writer else { return }
        if writer.status == .failed { return }

        if type == .screen {
            // Drop frames that aren't "complete" (SCK marks idle/blank frames).
            guard let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let attachments = attachmentsArray.first,
                  let statusRaw = attachments[.status] as? Int,
                  let status = SCFrameStatus(rawValue: statusRaw), status == .complete else { return }

            if !started {
                if writer.status == .unknown {
                    writer.startWriting()
                    writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
                    started = true
                }
            }
            if started, let vIn = videoInput, vIn.isReadyForMoreMediaData {
                vIn.append(sampleBuffer)
            }
        } else if type == .audio {
            // Only write audio once the session has started (video drives the clock).
            if started, let aIn = audioInput, aIn.isReadyForMoreMediaData {
                aIn.append(sampleBuffer)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        errLog("[rec] stream stopped with error: \(error.localizedDescription)")
    }

    func finish(_ completion: @escaping () -> Void) {
        if finished { completion(); return }
        finished = true
        micRecorder?.stop()
        Task { [weak self] in
            guard let self = self else { completion(); return }
            do { try await self.stream?.stopCapture() } catch { errLog("[rec] stopCapture: \(error.localizedDescription)") }
            self.videoInput?.markAsFinished()
            self.audioInput?.markAsFinished()
            if let w = self.writer, w.status == .writing {
                await w.finishWriting()
            }
            completion()
        }
    }
}

// MARK: - Run

let recorder = Recorder()
let sema = DispatchSemaphore(value: 0)

func shutdown() {
    recorder.finish {
        let hasMic = FileManager.default.fileExists(atPath: micURL.path)
        let payload: [String: Any] = [
            "screen": screenURL.path,
            "mic": hasMic ? micURL.path : "",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        sema.signal()
    }
}

// Finalize cleanly on the stop signals Electron sends.
let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
sigintSrc.setEventHandler { shutdown() }
sigtermSrc.setEventHandler { shutdown() }
sigintSrc.resume()
sigtermSrc.resume()

Task {
    do {
        try await recorder.start()
        errLog("[rec] recording")
    } catch {
        errLog("[rec] start failed: \(error.localizedDescription)")
        exit(3)
    }
}

// Wait for shutdown() to finalize, then exit.
DispatchQueue.global().async {
    sema.wait()
    exit(0)
}
RunLoop.main.run()

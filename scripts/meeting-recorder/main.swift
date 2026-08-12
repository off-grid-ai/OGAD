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
    /// How long to wait between attempts to get the display back. A meeting outlives a few seconds.
    private static let resumeRetryNs: UInt64 = 2_000_000_000

    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var started = false
    private let q = DispatchQueue(label: "ai.offgrid.meeting.rec")
    private var micRecorder: AVAudioRecorder?
    private var finished = false
    private var screenFrames = 0 // diagnostic: how many complete frames we actually wrote
    /// Fixed by the first start: the writer's video input cannot change size mid-recording.
    private var captureWidth: Int?
    private var captureHeight: Int?
    private var restarting = false
    /// How badly the far side was interrupted, so the app can say so instead of guessing.
    private var interruptions = 0
    private var downSince: Date?
    private var downSeconds: TimeInterval = 0

    /// What the recorder knows about its own gaps, for the caller to report.
    var outage: (interruptions: Int, seconds: Int) {
        let pending = downSince.map { Date().timeIntervalSince($0) } ?? 0
        return (interruptions, Int((downSeconds + pending).rounded()))
    }

    /// Resolve the display to record and open a stream on it.
    ///
    /// The first start and every restart both come through here, so they cannot disagree about
    /// which display holds the call. The size is fixed by the first start: the writer's video
    /// input is created once with those dimensions, and a display that comes back at a different
    /// resolution must still be scaled into it.
    private func openStream(width: Int?, height: Int?) async throws -> (SCStream, Int, Int) {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        // Capture the FULL display the call is on — the product records the SCREEN, and a
        // single-window grab letterboxes the call inside a black frame. Pick the display
        // holding the meeting window (multi-monitor), else the main display. Exclude Off
        // Grid's own windows so we never record our own UI back into the recording.
        guard !content.displays.isEmpty else {
            throw NSError(domain: "rec", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"])
        }
        let meetingWin = pickMeetingWindow(content, platform)
        let display: SCDisplay = {
            if let w = meetingWin,
               let d = content.displays.first(where: { $0.frame.contains(CGPoint(x: w.frame.midX, y: w.frame.midY)) }) {
                return d
            }
            return content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays[0]
        }()
        let selfApps = content.applications.filter { $0.applicationName.lowercased().contains("off grid") }
        errLog("[rec] capturing display \(display.displayID) \(display.width)x\(display.height); excluding \(selfApps.count) Off Grid app(s)")
        let filter = SCContentFilter(display: display, excludingApplications: selfApps, exceptingWindows: [])
        let outW = width ?? display.width
        let outH = height ?? display.height

        let cfg = SCStreamConfiguration()
        cfg.width = outW
        cfg.height = outH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15) // 15 fps — plenty for a meeting
        cfg.queueDepth = 6
        cfg.showsCursor = true
        cfg.capturesAudio = true            // <-- system audio (the far side)
        cfg.sampleRate = 48000
        cfg.channelCount = 2

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q)
        try await s.startCapture()
        return (s, outW, outH)
    }

    func start() async throws {
        // DECISIVE for a black recording: ScreenCaptureKit hands back BLACK frames (no
        // error) when THIS process isn't authorized for screen recording. Since we're a
        // separate spawned binary, our authorization is independent of the parent app's.
        errLog("[rec] screen-capture preauthorized=\(CGPreflightScreenCaptureAccess())")
        let (s, outW, outH) = try await openStream(width: nil, height: nil)
        self.stream = s
        self.captureWidth = outW
        self.captureHeight = outH

        // AVAssetWriter: H.264 video + AAC audio into screen.mov
        let w = try AVAssetWriter(outputURL: screenURL, fileType: .mov)
        // CRASH-SAFETY (never lose data): without this, the moov atom is written ONLY at
        // finishWriting(), so a SIGKILL (app force-quit mid-recording) leaves an unreadable
        // file and the whole recording is lost. A movie-fragment interval makes AVFoundation
        // write the header up front + flush periodic fragments (moof/mdat), so a killed file
        // stays playable up to the last flushed fragment. At a 1s interval the on-disk file is
        // effectively real-time: a hard kill loses at most ~1s of tail, never the session —
        // and startup recovery (recoverOrphanedMeetings) can then mux it. A graceful quit
        // finalizes fully via stopProServices -> requestStop.
        w.movieFragmentInterval = CMTime(value: 1, timescale: 1)
        w.shouldOptimizeForNetworkUse = true
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
                screenFrames += 1
                if screenFrames == 1 || screenFrames % 150 == 0 {
                    errLog("[rec] wrote \(screenFrames) screen frame(s)")
                }
            }
        } else if type == .audio {
            // Only write audio once the session has started (video drives the clock).
            if started, let aIn = audioInput, aIn.isReadyForMoreMediaData {
                aIn.append(sampleBuffer)
            }
        }
    }

    /**
     A stopped stream is an interruption, not the end of the recording.

     ScreenCaptureKit stops the stream when the display it was told to capture goes away, and a
     browser quitting can take a whole display's space with it. That stream carries BOTH the screen
     and the far side of the call, so when it stopped, the other people in the meeting stopped being
     recorded. The microphone is a separate capture and carried on, which is why the result was a
     confident thirty-four minute recording of one voice. Nothing tried again, and nobody was told.

     A display that vanished usually comes back. So keep asking for it until it does, or until the
     user stops the recording. The writer is untouched: later samples append to the same inputs and
     the gap shows up as a still frame, which is the truth about that stretch.
     */
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        errLog("[rec] stream stopped with error: \(error.localizedDescription)")
        q.async { [weak self] in
            guard let self = self, !self.finished, !self.restarting else { return }
            self.restarting = true
            self.interruptions += 1
            self.downSince = Date()
            self.resumeCapture()
        }
    }

    private func resumeCapture() {
        Task { [weak self] in
            guard let self = self else { return }
            var attempt = 0
            while !self.finished {
                attempt += 1
                do {
                    let (s, _, _) = try await self.openStream(
                        width: self.captureWidth, height: self.captureHeight
                    )
                    self.stream = s
                    let lost = Date().timeIntervalSince(self.downSince ?? Date())
                    self.downSeconds += lost
                    self.downSince = nil
                    self.restarting = false
                    errLog("[rec] capture resumed after \(attempt) attempt(s), \(Int(lost))s lost")
                    return
                } catch {
                    if attempt == 1 || attempt % 10 == 0 {
                        errLog("[rec] resume attempt \(attempt) failed: \(error.localizedDescription)")
                    }
                    try? await Task.sleep(nanoseconds: Self.resumeRetryNs)
                }
            }
            self.restarting = false
        }
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
        // The gaps travel with the files. A recording that lost the far side for half an hour must
        // not reach the summariser looking like a complete one.
        let outage = recorder.outage
        let payload: [String: Any] = [
            "screen": screenURL.path,
            "mic": hasMic ? micURL.path : "",
            "interruptions": outage.interruptions,
            "lostSeconds": outage.seconds,
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

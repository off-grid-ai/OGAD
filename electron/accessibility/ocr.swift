import Foundation
import Vision
import AppKit

// OCR a single image file with the macOS Vision framework and print the
// recognized text, one line per detected block. Fast, accurate, on-device,
// AGPL-safe (no external service). Usage: ocr <image-path>

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: ocr <image-path>\n".data(using: .utf8)!)
    exit(1)
}

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not load image\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
    if let results = request.results {
        for observation in results {
            if let candidate = observation.topCandidates(1).first {
                print(candidate.string)
            }
        }
    }
} catch {
    FileHandle.standardError.write("OCR failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

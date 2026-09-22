import Foundation
import Vision
import AppKit

// OCR a single image file with the macOS Vision framework and print the
// recognized text, one line per detected block. Fast, accurate, on-device,
// AGPL-safe (no external service). Usage: ocr [--json] <image-path>

struct PixelBounds: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct TextBlock: Codable {
    let text: String
    let confidence: Float
    let bounds: PixelBounds
}

struct OcrDocument: Codable {
    let width: Int
    let height: Int
    let blocks: [TextBlock]
}

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: ocr <image-path>\n".data(using: .utf8)!)
    exit(1)
}

let jsonOutput = CommandLine.arguments.dropFirst().first == "--json"
let pathIndex = jsonOutput ? 2 : 1
guard CommandLine.arguments.count > pathIndex else {
    FileHandle.standardError.write("usage: ocr [--json] <image-path>\n".data(using: .utf8)!)
    exit(1)
}
let path = CommandLine.arguments[pathIndex]
guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("could not load image\n".data(using: .utf8)!)
    exit(1)
}

func recognizeText(
    _ cgImage: CGImage,
    recognitionLevel: VNRequestTextRecognitionLevel,
    languageCorrection: Bool
) throws -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = recognitionLevel
    request.usesLanguageCorrection = languageCorrection
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    return request.results ?? []
}

let results: [VNRecognizedTextObservation]
do {
    do {
        results = try recognizeText(
            cgImage,
            recognitionLevel: .accurate,
            languageCorrection: true
        )
    } catch {
        do {
            // Language correction can be unavailable on a valid macOS Vision
            // installation. OCR remains useful without that optional pass.
            results = try recognizeText(
                cgImage,
                recognitionLevel: .accurate,
                languageCorrection: false
            )
        } catch {
            // Vision's accurate recognizer can reject small window captures.
            // The fast recognizer still returns bounded local text for fusion.
            results = try recognizeText(
                cgImage,
                recognitionLevel: .fast,
                languageCorrection: false
            )
        }
    }
    if jsonOutput {
        let imageWidth = cgImage.width
        let imageHeight = cgImage.height
        let blocks = results.compactMap { observation -> TextBlock? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let normalized = observation.boundingBox
            // Vision uses a lower-left normalized origin. Screen and image consumers use top-left pixels.
            let x = Int((normalized.origin.x * CGFloat(imageWidth)).rounded())
            let y = Int(((1.0 - normalized.origin.y - normalized.height) * CGFloat(imageHeight)).rounded())
            let width = Int((normalized.width * CGFloat(imageWidth)).rounded())
            let height = Int((normalized.height * CGFloat(imageHeight)).rounded())
            return TextBlock(
                text: candidate.string,
                confidence: candidate.confidence,
                bounds: PixelBounds(
                    x: max(0, min(imageWidth, x)),
                    y: max(0, min(imageHeight, y)),
                    width: max(0, min(imageWidth - max(0, x), width)),
                    height: max(0, min(imageHeight - max(0, y), height))
                )
            )
        }
        let document = OcrDocument(width: imageWidth, height: imageHeight, blocks: blocks)
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(document), let json = String(data: data, encoding: .utf8) {
            print(json)
        } else {
            FileHandle.standardError.write("OCR JSON encoding failed\n".data(using: .utf8)!)
            exit(1)
        }
    } else {
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

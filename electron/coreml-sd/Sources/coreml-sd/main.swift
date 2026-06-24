// Off Grid AI Desktop — Core ML image generation CLI (Apple Neural Engine).
//
// Reuses Apple's ml-stable-diffusion pipeline, exactly like the mobile app's
// CoreMLDiffusionModule, so SD / SDXL run on the ANE on macOS. Spawned by the
// main process (like the meeting-recorder Swift helper); prints per-step
// progress to stdout (parseable as "N/total - 0.0s/it") and writes a PNG.
//
// Usage:
//   coreml-sd --model <mlmodelc-dir> --prompt "..." --output out.png \
//     [--negative "..."] [--steps 20] [--seed 42] [--guidance 7.5] [--cpu]

import Foundation
import CoreML
import StableDiffusion
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}
func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }
func fail(_ msg: String) -> Never { FileHandle.standardError.write(("error: " + msg + "\n").data(using: .utf8)!); exit(1) }

guard let modelPath = arg("--model") else { fail("--model <mlmodelc dir> required") }
guard let prompt = arg("--prompt"), !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { fail("--prompt required") }
guard let output = arg("--output") else { fail("--output <png> required") }
let negative = arg("--negative") ?? ""
let steps = Int(arg("--steps") ?? "20") ?? 20
let guidance = Float(arg("--guidance") ?? "7.5") ?? 7.5
let seed = UInt32(arg("--seed") ?? "") ?? UInt32.random(in: 0 ..< UInt32.max)

let modelURL = URL(fileURLWithPath: modelPath)

// SDXL is identified by a TextEncoder2.mlmodelc in the model dir (same heuristic as mobile).
let isXL = FileManager.default.fileExists(atPath: modelURL.appendingPathComponent("TextEncoder2.mlmodelc").path)

let config = MLModelConfiguration()
// ANE is the whole point (palettized weights need it); --cpu falls back to GPU.
config.computeUnits = flag("--cpu") ? .cpuAndGPU : .cpuAndNeuralEngine

do {
    let pipeline: StableDiffusionPipelineProtocol = try {
        if isXL {
            return try StableDiffusionXLPipeline(resourcesAt: modelURL, configuration: config, reduceMemory: true)
        }
        return try StableDiffusionPipeline(resourcesAt: modelURL, controlNet: [], configuration: config, reduceMemory: true)
    }()
    try pipeline.loadResources()

    var cfg = PipelineConfiguration(prompt: prompt)
    cfg.negativePrompt = negative
    cfg.stepCount = max(1, steps)
    cfg.seed = seed
    cfg.guidanceScale = guidance
    cfg.imageCount = 1
    cfg.disableSafety = true

    let images = try pipeline.generateImages(configuration: cfg) { progress in
        // Parseable by the main-process progress reader.
        print("\(progress.step)/\(progress.stepCount) - 0.0s/it")
        // NB: do NOT call FileHandle.standardOutput.synchronizeFile() here —
        // fsync() on stdout throws EINVAL (NSFileHandleOperationException) when
        // stdout is a PIPE (which it always is when launched from Electron or
        // captured), crashing the whole render at step 0. fflush is enough.
        fflush(stdout)
        return true
    }

    guard let cg = images.first ?? nil else { fail("no image produced") }
    let outURL = URL(fileURLWithPath: output)
    guard let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fail("could not create PNG destination")
    }
    CGImageDestinationAddImage(dest, cg, nil)
    guard CGImageDestinationFinalize(dest) else { fail("could not write PNG") }
    print("saved \(output)")
} catch {
    fail("Core ML generation failed: \(error.localizedDescription)")
}

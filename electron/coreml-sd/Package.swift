// swift-tools-version:5.9
import PackageDescription

// macOS Core ML image-generation helper for Off Grid AI Desktop. Mirrors the
// mobile app's CoreMLDiffusionModule (Apple's ml-stable-diffusion), so SD/SDXL
// runs on the Apple Neural Engine — the same Apple-ecosystem path as iOS.
let package = Package(
    name: "coreml-sd",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/ml-stable-diffusion", from: "1.1.0"),
    ],
    targets: [
        .executableTarget(
            name: "coreml-sd",
            dependencies: [
                .product(name: "StableDiffusion", package: "ml-stable-diffusion"),
            ]
        ),
    ]
)

// vision_ocr.swift — standalone macOS Vision OCR CLI (fallback backend)
//
// Usage:
//   swiftc -O -o vision_ocr vision_ocr.swift
//   ./vision_ocr /path/to/image.png [zh-Hans,en-US]
//
// Prints one JSON object on stdout:
//   {"width":W,"height":H,"observations":[{"text":"..","confidence":0.93,
//     "x":..,"y":..,"w":..,"h":..}]}
// Coordinates are pixels with origin at TOP-LEFT (already converted from
// Vision's normalised bottom-left space).

import Foundation
import Vision
import CoreGraphics
import ImageIO

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: vision_ocr <image> [langs])") }
let path = args[1]
let langs: [String] = args.count >= 3
    ? args[2].split(separator: ",").map { String($0) }
    : ["zh-Hans", "en-US"]

let url = URL(fileURLWithPath: path)
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("cannot load image: \(path)")
}
let width = cg.width
let height = cg.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = langs

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("vision perform failed: \(error)")
}

func esc(_ s: String) -> String {
    var out = ""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    return out
}

var items: [String] = []
if let results = request.results {
    for obs in results {
        guard let top = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox
        let x = Double(bb.origin.x) * Double(width)
        let y = (1.0 - Double(bb.origin.y) - Double(bb.size.height)) * Double(height)
        let w = Double(bb.size.width) * Double(width)
        let h = Double(bb.size.height) * Double(height)
        let item = "{\"text\":\"\(esc(top.string))\",\"confidence\":\(Double(top.confidence)),"
            + "\"x\":\(x),\"y\":\(y),\"w\":\(w),\"h\":\(h)}"
        items.append(item)
    }
}

let json = "{\"width\":\(width),\"height\":\(height),\"observations\":["
    + items.joined(separator: ",") + "]}"
print(json)

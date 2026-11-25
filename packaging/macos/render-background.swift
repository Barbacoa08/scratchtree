import AppKit

// Finder draws the window chrome, the file icons, and their names.
let size = NSSize(width: 652, height: 369)
let appX = 177
let applicationsX = 475
let iconY = 215
let iconSize = 112

func color(_ hex: UInt32, opacity: CGFloat = 1) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 255) / 255,
        green: CGFloat((hex >> 8) & 255) / 255,
        blue: CGFloat(hex & 255) / 255,
        alpha: opacity
    )
}

func write(_ string: String, font: NSFont, paint: NSColor, at origin: NSPoint) {
    NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: paint])
        .draw(at: origin)
}

func stroke(_ path: NSBezierPath, paint: NSColor) {
    path.lineWidth = 2.5
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    paint.setStroke()
    path.stroke()
}

func drawRoots() {
    // Flowing Roots from src/lib/components/RootIcon.svelte, enlarged and cropped.
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: 508 + x * 10.5, y: 225 + y * 10.5)
    }

    let roots = NSBezierPath()
    roots.move(to: point(1.2, 3.7))
    roots.line(to: point(14.8, 3.7))
    roots.move(to: point(8, 3.7))
    roots.curve(to: point(7.7, 10.7), controlPoint1: point(8.2, 6.7), controlPoint2: point(6.8, 8.4))
    roots.line(to: point(8.9, 14))
    roots.move(to: point(7.9, 6.5))
    roots.curve(to: point(1.4, 12.4), controlPoint1: point(6.1, 8.4), controlPoint2: point(2.7, 8.3))
    roots.move(to: point(4.5, 8.9))
    roots.curve(to: point(3.8, 13.2), controlPoint1: point(4.7, 10.3), controlPoint2: point(4.1, 11.6))
    roots.move(to: point(7.6, 7.7))
    roots.curve(to: point(14.6, 11.7), controlPoint1: point(9.4, 8), controlPoint2: point(12.6, 8.4))
    roots.move(to: point(11.3, 8.7))
    roots.curve(to: point(12, 13.2), controlPoint1: point(11.1, 10.2), controlPoint2: point(11.7, 11.6))
    stroke(roots, paint: color(0x92caff, opacity: 0.09))
}

func drawInstruction() {
    let title = "Install Scratchtree"
    let titleFont = NSFont.systemFont(ofSize: 30, weight: .semibold)
    let titleWidth = (title as NSString).size(withAttributes: [.font: titleFont]).width
    let headingStart = (size.width - titleWidth - 25) / 2
    write("#", font: .monospacedSystemFont(ofSize: 27, weight: .medium),
          paint: color(0x92caff), at: NSPoint(x: headingStart, y: 53))
    write(title, font: titleFont, paint: color(0xededed),
          at: NSPoint(x: headingStart + 25, y: 49))

    let instruction = "Drag Scratchtree to Applications."
    let instructionFont = NSFont.systemFont(ofSize: 15)
    let instructionWidth = (instruction as NSString).size(withAttributes: [.font: instructionFont]).width
    write(instruction, font: instructionFont, paint: color(0xc6d0e0),
          at: NSPoint(x: (size.width - instructionWidth) / 2, y: 94))
}

func drawArrow() {
    let arrow = NSBezierPath()
    arrow.move(to: NSPoint(x: 269, y: 208))
    arrow.curve(to: NSPoint(x: 382, y: 208),
                controlPoint1: NSPoint(x: 303, y: 232), controlPoint2: NSPoint(x: 349, y: 232))
    arrow.move(to: NSPoint(x: 364, y: 207))
    arrow.line(to: NSPoint(x: 382, y: 208))
    arrow.line(to: NSPoint(x: 376, y: 225))
    stroke(arrow, paint: color(0x92caff))
}

func drawLabelBackings() {
    // Finder can render black labels over a custom background, even in Dark appearance.
    color(0x74777a).setFill()
    for center in [appX, applicationsX] {
        let rect = NSRect(x: center - 66, y: iconY + iconSize / 2 + 5, width: 132, height: 25)
        NSBezierPath(roundedRect: rect, xRadius: 6, yRadius: 6).fill()
    }
}

func render(scale: Int, to url: URL) throws {
    let width = Int(size.width) * scale
    let height = Int(size.height) * scale
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    let backing = NSGraphicsContext(bitmapImageRep: bitmap)!
    let context = backing.cgContext
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
    let gradient = NSGradient(colors: [color(0x141414), color(0x171d26), color(0x253448)])!
    gradient.draw(in: NSRect(origin: .zero, size: size), angle: 42)
    drawRoots()
    drawInstruction()
    drawArrow()
    drawLabelBackings()
    NSGraphicsContext.restoreGraphicsState()

    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}

let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try render(scale: 1, to: destination.appendingPathComponent("background.png"))
try render(scale: 2, to: destination.appendingPathComponent("background@2x.png"))

let layout = try JSONSerialization.data(withJSONObject: [
    "window_size": [Int(size.width), Int(size.height)],
    "icon_size": iconSize,
    "icon_locations": [
        "Scratchtree.app": [appX, iconY],
        "Applications": [applicationsX, iconY],
    ],
])
print(String(decoding: layout, as: UTF8.self))

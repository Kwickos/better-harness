// Pont vers un simulateur iOS : l'écran en direct et les touches, par les frameworks privés d'Xcode
// (CoreSimulator et SimulatorKit, chargés à l'exécution : même approche que FBSimulatorControl, d'idb).
// Un processus à part : l'app ne charge pas ces frameworks, et un changement d'Xcode ne peut pas la faire planter.
//
// Usage : sim-bridge <udid> <dossier développeur> [images par seconde]
// Sortie : suite de paquets [type : 1 octet][taille : 4 octets LE][données]. Type 0 : image JPEG. Type 1 : JSON.
// Entrée, une commande par ligne :
//   touch down <x> <y> [bord]    (fractions de l'écran, de 0 à 1 ; bord : 1 haut, 2 gauche, 3 bas, 4 droite)
//   touch move|up <x> <y>
//   home
//   key down|up <code HID>
//   fps <n> | pause | resume
// L'écran n'est encodé que s'il a changé, et rien ne tourne en pause. Fin de l'entrée = fin du processus.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import IOSurface
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count >= 3 else {
    FileHandle.standardError.write(Data("usage : sim-bridge <udid> <dossier développeur> [fps]\n".utf8))
    exit(64)
}
let udid = arguments[1]
let developerDir = arguments[2]
var framesPerSecond = arguments.count > 3 ? Double(arguments[3]) ?? 15 : 15

let output = FileHandle.standardOutput
let outputQueue = DispatchQueue(label: "sortie")

func send(kind: UInt8, _ data: Data) {
    var header = Data([kind])
    var size = UInt32(data.count).littleEndian
    withUnsafeBytes(of: &size) { header.append(contentsOf: $0) }
    outputQueue.sync {
        // Un tube fermé veut dire que l'app est partie.
        do {
            try output.write(contentsOf: header)
            try output.write(contentsOf: data)
        } catch {
            exit(0)
        }
    }
}

func report(_ fields: [String: Any]) {
    if let json = try? JSONSerialization.data(withJSONObject: fields) { send(kind: 1, json) }
}

func fail(_ message: String) -> Never {
    report(["event": "error", "message": message])
    Thread.sleep(forTimeInterval: 0.05)
    exit(1)
}

// ------------------------------------------------------------ frameworks et appareil

guard dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator", RTLD_NOW) != nil else {
    fail("CoreSimulator est introuvable : Xcode est-il installé ?")
}
let simulatorKit = (developerDir as NSString).deletingLastPathComponent + "/SharedFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit"
guard dlopen(simulatorKit, RTLD_NOW) != nil else { fail("SimulatorKit est introuvable dans cet Xcode.") }

func call(_ target: AnyObject, _ name: String) -> AnyObject? {
    let selector = NSSelectorFromString(name)
    guard target.responds(to: selector) else { return nil }
    return target.perform(selector)?.takeUnretainedValue()
}

func findDevice() -> AnyObject? {
    guard let contextClass = NSClassFromString("SimServiceContext") as AnyObject?,
          let context = contextClass.perform(NSSelectorFromString("sharedServiceContextForDeveloperDir:error:"), with: developerDir, with: nil)?.takeUnretainedValue(),
          let set = context.perform(NSSelectorFromString("defaultDeviceSetWithError:"), with: nil)?.takeUnretainedValue(),
          let devices = set.value(forKey: "devices") as? [AnyObject] else { return nil }
    return devices.first { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid }
}

guard let device = findDevice() else { fail("Ce simulateur n'existe plus.") }
// L'écran principal : le premier port qui a une image.
func findScreen() -> (descriptor: AnyObject, surface: IOSurfaceRef)? {
    guard let io = call(device, "io"), let ports = io.value(forKey: "ioPorts") as? [AnyObject] else { return nil }
    for port in ports {
        guard let descriptor = call(port, "descriptor"), descriptor.responds(to: NSSelectorFromString("framebufferSurface")) else { continue }
        if let found = call(descriptor, "framebufferSurface") { return (descriptor, unsafeBitCast(found, to: IOSurfaceRef.self)) }
    }
    return nil
}

// Un appareil qui démarre n'a encore d'image sur aucun port : se brancher au hasard le laisserait noir.
var found = findScreen()
let screenDeadline = Date().addingTimeInterval(180)
while found == nil, Date() < screenDeadline {
    Thread.sleep(forTimeInterval: 0.25)
    found = findScreen()
}
guard let found else { fail("L'écran de ce simulateur est indisponible : est-il démarré ?") }
let screen = found.descriptor
var surface: IOSurfaceRef? = found.surface

// ------------------------------------------------------------ écran

let renderQueue = DispatchQueue(label: "rendu")
var dirty = true
var paused = false
var lastSize = CGSize.zero
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
/// Le panneau n'a pas besoin de la résolution native : la moitié suffit et coûte quatre fois moins.
let renderScale = 0.5
let jpegOptions = [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary

func renderFrame() {
    guard dirty, !paused, let current = surface else { return }
    dirty = false
    let width = IOSurfaceGetWidth(current), height = IOSurfaceGetHeight(current)
    guard width > 0, height > 0, IOSurfaceLock(current, .readOnly, nil) == KERN_SUCCESS else { return }
    defer { IOSurfaceUnlock(current, .readOnly, nil) }
    let targetWidth = Int(Double(width) * renderScale), targetHeight = Int(Double(height) * renderScale)
    let source = IOSurfaceGetBaseAddress(current)
    let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    guard let provider = CGDataProvider(dataInfo: nil, data: source, size: IOSurfaceGetBytesPerRow(current) * height, releaseData: { _, _, _ in }),
          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: IOSurfaceGetBytesPerRow(current), space: colorSpace, bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
          let context = CGContext(data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    guard let small = context.makeImage() else { return }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(destination, small, jpegOptions)
    guard CGImageDestinationFinalize(destination) else { return }
    let size = CGSize(width: width, height: height)
    if size != lastSize {
        lastSize = size
        report(["event": "screen", "width": targetWidth, "height": targetHeight])
    }
    send(kind: 0, data as Data)
}

let timer = DispatchSource.makeTimerSource(queue: renderQueue)
func scheduleTimer() {
    timer.schedule(deadline: .now(), repeating: 1.0 / max(1, framesPerSecond), leeway: .milliseconds(4))
}
scheduleTimer()
timer.setEventHandler(handler: renderFrame)
timer.resume()

typealias FrameBlock = @convention(block) () -> Void
typealias SurfacesBlock = @convention(block) (AnyObject?, AnyObject?) -> Void
typealias PropertiesBlock = @convention(block) (AnyObject?) -> Void
typealias RegisterFunction = @convention(c) (AnyObject, Selector, NSUUID, DispatchQueue, FrameBlock, SurfacesBlock, PropertiesBlock) -> Void

let registerSelector = NSSelectorFromString("registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:")
guard screen.responds(to: registerSelector), let messageSend = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "objc_msgSend") else {
    fail("Cet Xcode n'expose pas l'écran du simulateur comme attendu.")
}
let frameBlock: FrameBlock = { dirty = true }
let surfacesBlock: SurfacesBlock = { unmasked, _ in
    surface = unmasked.map { unsafeBitCast($0, to: IOSurfaceRef.self) }
    dirty = true
}
let propertiesBlock: PropertiesBlock = { _ in dirty = true }
let callbackID = NSUUID()
unsafeBitCast(messageSend, to: RegisterFunction.self)(screen, registerSelector, callbackID, renderQueue, frameBlock, surfacesBlock, propertiesBlock)

// ------------------------------------------------------------ touches

/// Un message Indigo tel que le construit SimulatorKit : pointeur à libérer après l'envoi.
typealias MouseFunction = @convention(c) (UnsafePointer<CGPoint>, UnsafePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32) -> UnsafeMutableRawPointer?
typealias UsageFunction = @convention(c) (UInt32, UInt32, UInt32, UInt32) -> UnsafeMutableRawPointer?
typealias SendFunction = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue?, (@convention(block) (AnyObject?) -> Void)?) -> Void

let kitHandle = dlopen(simulatorKit, RTLD_NOW)
let mouseMessage = dlsym(kitHandle, "IndigoHIDMessageForMouseNSEvent").map { unsafeBitCast($0, to: MouseFunction.self) }
let usageMessage = dlsym(kitHandle, "IndigoHIDMessageForHIDArbitrary").map { unsafeBitCast($0, to: UsageFunction.self) }
let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")

var hidClient: AnyObject?
if let hidClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") as? NSObject.Type {
    let allocated = hidClass.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    hidClient = allocated?.perform(NSSelectorFromString("initWithDevice:error:"), with: device, with: nil)?.takeUnretainedValue()
}

let hidQueue = DispatchQueue(label: "touches")
let hidDone: @convention(block) (AnyObject?) -> Void = { error in
    if let error { report(["event": "input-error", "message": String(describing: error)]) }
}

func sendHID(_ message: UnsafeMutableRawPointer?) {
    guard let message, let hidClient else { return }
    unsafeBitCast(messageSend, to: SendFunction.self)(hidClient, sendSelector, message, true, hidQueue, hidDone)
}

// Valeurs d'AppKit, stables : NSEventType.leftMouseDown, leftMouseUp, leftMouseDragged.
let touchTarget: UInt32 = 0x32
/// Le bord où le geste a commencé : c'est lui qui déclenche les gestes du système (accueil, retour…).
var gestureEdge: UInt32 = 0
func touch(_ phase: Substring, _ x: Double, _ y: Double) {
    guard let mouseMessage else { return }
    var point = CGPoint(x: x, y: y)
    let type: UInt = phase == "down" ? 1 : phase == "up" ? 2 : 6
    // SimulatorKit refuse deux mouvements à moins de 16 ms : il rend alors un message nul, ignoré à l'envoi.
    sendHID(mouseMessage(&point, nil, touchTarget, type, CGSize(width: 1, height: 1), gestureEdge))
    if phase == "up" { gestureEdge = 0 }
}

// Pages HID : 7 clavier, 12 boutons (0x40 : accueil). Les fonctions dédiées de SimulatorKit
// (`IndigoHIDMessageForButton`, `…KeyboardArbitrary`) n'ont aucun effet sur ces simulateurs.
func usage(page: UInt32, _ code: UInt32, down: Bool) {
    guard let usageMessage else { return }
    sendHID(usageMessage(touchTarget, page, code, down ? 1 : 2))
}

func goHome() {
    usage(page: 12, 0x40, down: true)
    Thread.sleep(forTimeInterval: 0.08)
    usage(page: 12, 0x40, down: false)
}

report(["event": "ready", "input": hidClient != nil && mouseMessage != nil])

// ------------------------------------------------------------ commandes

let inputThread = Thread {
    while let line = readLine() {
        let parts = line.split(separator: " ")
        guard let command = parts.first else { continue }
        switch command {
        case "touch" where parts.count >= 4:
            if parts[1] == "down", parts.count == 5 { gestureEdge = UInt32(parts[4]) ?? 0 }
            if let x = Double(parts[2]), let y = Double(parts[3]) { touch(parts[1], x, y) }
        case "home":
            goHome()
        case "key" where parts.count == 3:
            if let code = UInt32(parts[2]) { usage(page: 7, code, down: parts[1] == "down") }
        case "fps" where parts.count == 2:
            if let value = Double(parts[1]) {
                renderQueue.async {
                    framesPerSecond = value
                    scheduleTimer()
                }
            }
        case "pause":
            renderQueue.async { paused = true }
        case "resume":
            renderQueue.async {
                paused = false
                dirty = true
            }
        default:
            break
        }
    }
    exit(0)
}
inputThread.start()
RunLoop.main.run()

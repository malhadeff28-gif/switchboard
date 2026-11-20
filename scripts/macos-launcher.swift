import AppKit

final class Launcher: NSObject, NSApplicationDelegate {
    private let server = Process()
    private var quitting = false
    private var terminationSignal: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        appItem.submenu = NSMenu()
        appItem.submenu?.addItem(withTitle: "Quit Switchboard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu

        guard let launcher = Bundle.main.resourceURL?.appendingPathComponent("scripts/launch.mjs"),
              let node = Bundle.main.url(forAuxiliaryExecutable: "node") else {
            fail("The Switchboard download is incomplete. Extract the download again.")
            return
        }

        var logPath = Array((NSTemporaryDirectory() + "switchboard-errors.XXXXXX").utf8CString)
        let descriptor = mkstemp(&logPath)
        guard descriptor >= 0 else {
            fail("Could not prepare the Switchboard launch log.")
            return
        }
        unlink(&logPath)
        let errors = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        server.executableURL = node
        server.arguments = [launcher.path]
        server.standardError = errors
        server.terminationHandler = { process in
            let status = process.terminationStatus
            let end = (try? errors.seekToEnd()) ?? 0
            try? errors.seek(toOffset: end > 4096 ? end - 4096 : 0)
            let detail = String(decoding: errors.readDataToEndOfFile(), as: UTF8.self)
            DispatchQueue.main.async {
                if self.quitting || status == 0 {
                    exit(EXIT_SUCCESS)
                }
                self.fail(detail.isEmpty ? "The local server exited with status \(status)." : detail)
            }
        }
        do {
            try server.run()
        } catch {
            fail(error.localizedDescription)
            return
        }
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { NSApp.terminate(nil) }
        termination.resume()
        terminationSignal = termination

    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.isRunning else { return .terminateNow }
        quitting = true
        server.terminate()
        server.waitUntilExit()
        return .terminateNow
    }

    private func fail(_ detail: String) {
        if ProcessInfo.processInfo.environment["SWITCHBOARD_NO_BROWSER"] != "1" {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Switchboard couldn’t start"
            alert.informativeText = detail.components(separatedBy: .newlines)
                .first(where: { $0.hasPrefix("Error: ") }).map { String($0.dropFirst(7)) }
                ?? detail.trimmingCharacters(in: .whitespacesAndNewlines)
            alert.runModal()
        }
        FileHandle.standardError.write(Data(detail.utf8))
        exit(EXIT_FAILURE)
    }
}

let app = NSApplication.shared
let launcher = Launcher()
app.delegate = launcher
app.run()

// Token Relay Mac 앱: 켜져 있는 동안만 서버(server.js)를 돌리고 Mac 잠자기를 막음. 종료(⌘Q)하면 서버도 종료.
import Cocoa
import WebKit
import CoreImage

@MainActor
final class App: NSObject, NSApplicationDelegate, WKUIDelegate {
    var window: NSWindow!
    let web = WKWebView()
    var server: Process?
    var output = ""
    var phoneURL: String?
    var quitting = false
    var activity: NSObjectProtocol?
    let dataURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TokenRelay/data.json")

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Token Relay"
        window.isReleasedWhenClosed = false
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("main")
        window.makeKeyAndOrderFront(nil)
        web.uiDelegate = self
        web.loadHTMLString("<body style='font:15px -apple-system;padding:24px;color:#888'>서버 시작 중…</body>", baseURL: nil)
        // 앱이 켜져 있는 동안 잠자기 방지 (서버도 caffeinate 로 한 번 더 막음)
        activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiated], reason: "Claude 작업 실행")
        startServer()
        DispatchQueue.main.async { self.setupLidAwake() }
    }

    // ---- 덮개 닫아도 안 잠들기: pmset -c disablesleep 1 (충전기 연결 중일 때만 적용) ----
    // "항상 허용": 이 pmset 명령 두 개만 암호 없이 실행하도록 sudoers 규칙 설치 (관리자 암호 1번, 메뉴에서 해제)
    // 항상 허용 안 하면: 앱 열 때마다 관리자 암호. 어느 쪽이든 앱이 끝나면(종료/강제종료/크래시) 자동 복구
    let lidKey = "lidAwake"
    let rulePath = "/etc/sudoers.d/tokenrelay"
    var lidItem: NSMenuItem!
    var alwaysItem: NSMenuItem!
    var lidOn = false
    let pid = ProcessInfo.processInfo.processIdentifier

    func run(_ path: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    func runAdmin(_ cmd: String) -> Bool {
        var err: NSDictionary?
        NSAppleScript(source: "do shell script \"\(cmd)\" with administrator privileges")?.executeAndReturnError(&err)
        return err == nil
    }

    // 규칙이 있으면 sudo -n 으로 암호 없이 실행 가능 (-l 은 확인만, 실행 안 함)
    var alwaysAllowed: Bool { run("/usr/bin/sudo", ["-n", "-l", "/usr/bin/pmset", "-c", "disablesleep", "1"]) }
    func sudoPmset(_ v: Int) -> Bool { run("/usr/bin/sudo", ["-n", "/usr/bin/pmset", "-c", "disablesleep", "\(v)"]) }

    func installRule() -> Bool {
        let user = NSUserName().filter { $0.isLetter || $0.isNumber || "._-".contains($0) }
        let rule = "\(user) ALL=(root) NOPASSWD: /usr/bin/pmset -c disablesleep 1, /usr/bin/pmset -c disablesleep 0"
        // visudo 로 문법 검사 통과한 것만 설치 (잘못된 sudoers 는 sudo 전체를 망가뜨림)
        _ = runAdmin("f=$(/usr/bin/mktemp) && /bin/echo '\(rule)' > $f && /usr/sbin/visudo -cf $f && /usr/bin/install -m 440 -o root -g wheel $f \(rulePath); r=$?; /bin/rm -f $f; exit $r")
        let ok = alwaysAllowed
        if !ok {
            let a = NSAlert()
            a.messageText = "항상 허용을 설정하지 못했어요"
            a.informativeText = "암호를 취소했거나 이 Mac 의 sudo 설정이 /etc/sudoers.d 를 읽지 않아요. 앱을 열 때마다 암호를 묻는 방식으로 동작합니다."
            a.runModal()
        }
        return ok
    }

    func enableLidAwake() {
        if alwaysAllowed {
            lidOn = sudoPmset(1)
            // 앱이 어떻게 끝나든 원래대로: 사용자 권한 감시 프로세스 (sudo -n 이라 암호 없음)
            if lidOn {
                let w = Process()
                w.executableURL = URL(fileURLWithPath: "/bin/sh")
                w.arguments = ["-c", "trap : HUP INT TERM; while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 5; done; /usr/bin/sudo -n /usr/bin/pmset -c disablesleep 0"]
                w.standardInput = FileHandle.nullDevice
                w.standardOutput = FileHandle.nullDevice
                w.standardError = FileHandle.nullDevice
                try? w.run()
            }
        } else {
            // 켜면서, 이 앱 프로세스가 사라질 때까지 기다렸다가 0 으로 되돌리는 root 감시를 같이 띄움
            lidOn = runAdmin("/usr/bin/pmset -c disablesleep 1; /usr/bin/nohup /bin/sh -c 'trap : HUP INT TERM; while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 5; done; /usr/bin/pmset -c disablesleep 0' </dev/null >/dev/null 2>&1 &")
        }
        updateLidMenu()
    }

    func disableLidAwake() {
        if alwaysAllowed ? sudoPmset(0) : runAdmin("/usr/bin/pmset -c disablesleep 0") { lidOn = false }
        updateLidMenu()
    }

    func updateLidMenu() {
        lidItem.state = lidOn ? .on : .off
        alwaysItem.state = alwaysAllowed ? .on : .off
    }

    // 감시 프로세스가 살아 있는지 (명령줄에 이 앱 pid 가 들어 있음)
    func lidWatcherAlive() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        p.arguments = ["-f", "kill -0 \(pid) "]
        p.standardOutput = FileHandle.nullDevice
        try? p.run()
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    func setupLidAwake() {
        let d = UserDefaults.standard
        // 처음 실행, 또는 켜 놨지만 아직 항상 허용을 안 물어본 경우 한 번 묻기
        if d.object(forKey: lidKey) == nil || (d.bool(forKey: lidKey) && !d.bool(forKey: "alwaysAsked") && !alwaysAllowed) {
            d.set(true, forKey: "alwaysAsked")
            let a = NSAlert()
            a.messageText = "덮개를 닫아도 작업이 계속되게 할까요?"
            a.informativeText = "충전기가 연결돼 있을 때만 적용되고, 앱을 종료하면 원래대로 돌아갑니다.\n\n항상 허용: 지금 관리자 암호 한 번만 넣으면 다음부터 묻지 않아요. (덮개 잠자기 켜기/끄기 명령만 허용, 메뉴에서 해제 가능)\n매번 암호: 앱을 열 때마다 암호를 물어봐요."
            a.addButton(withTitle: "항상 허용")
            a.addButton(withTitle: "매번 암호")
            a.addButton(withTitle: "안 함")
            let r = a.runModal()
            d.set(r != .alertThirdButtonReturn, forKey: lidKey)
            if r == .alertFirstButtonReturn { _ = installRule() }
        }
        if d.bool(forKey: lidKey) { enableLidAwake() } else { updateLidMenu() }
    }

    @objc func toggleLid() {
        UserDefaults.standard.set(!lidOn, forKey: lidKey)
        lidOn ? disableLidAwake() : enableLidAwake()
    }

    @objc func toggleAlways() {
        if alwaysAllowed {
            if lidOn { disableLidAwake() } // 규칙 지우기 전에 원래대로
            _ = runAdmin("/bin/rm -f \(rulePath)")
        } else if installRule() && UserDefaults.standard.bool(forKey: lidKey) && !lidOn {
            enableLidAwake()
        }
        updateLidMenu()
    }

    // Finder 에서 실행된 앱은 PATH 가 짧아 node/claude 를 못 찾으므로 로그인 셸 PATH 를 가져옴
    func loginPath() -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "echo $PATH"]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        p.waitUntilExit()
        let path = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    }

    func startServer() {
        try? FileManager.default.createDirectory(at: dataURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", Bundle.main.path(forResource: "server", ofType: "js")!]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = loginPath()
        env["RELAY_DATA"] = dataURL.path
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { h in
            let s = String(decoding: h.availableData, as: UTF8.self)
            DispatchQueue.main.async { self.onOutput(s) }
        }
        p.terminationHandler = { _ in
            DispatchQueue.main.async { if !self.quitting { self.showError() } }
        }
        do { try p.run(); server = p } catch { output += "\(error)"; showError() }
    }

    func onOutput(_ s: String) {
        output += s
        for line in s.split(separator: "\n") {
            if line.contains("Token Relay 실행 중") { web.load(URLRequest(url: URL(string: "http://localhost:8787/")!)) }
            if line.hasPrefix("폰 접속: ") { phoneURL = String(line.dropFirst("폰 접속: ".count)).trimmingCharacters(in: .whitespaces) }
        }
    }

    func showError() {
        let esc = output.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        web.loadHTMLString("""
            <body style='font:14px -apple-system;padding:24px'><h3>서버가 실행되지 않았어요</h3>
            <p>node 설치 여부(<code>brew install node</code>)와 8787 포트를 다른 프로그램이 쓰는지 확인 후 앱을 다시 여세요.</p>
            <pre style='white-space:pre-wrap;background:#8881;padding:12px'>\(esc)</pre></body>
            """, baseURL: nil)
    }

    // ---- 폰에 앱 설치: APK 다운로드 링크를 QR 로 ----
    @objc func showAndroid() {
        let alert = NSAlert()
        alert.messageText = "Android 앱 설치"
        guard let url = phoneURL else {
            alert.informativeText = "Tailscale 주소를 찾지 못했어요. Mac 의 Tailscale 을 켜면 30초 안에 자동으로 연결됩니다."
            alert.runModal()
            return
        }
        alert.informativeText = "폰(Tailscale 켜진 상태) 카메라로 QR 을 찍어 APK 를 받아 설치하세요.\n설치 후 앱을 열면 이 Mac 에 바로 연결됩니다.\n\n폰 접속 주소: \(url)"
        let img = NSImageView(image: qr(url + "app.apk"))
        img.frame = NSRect(x: 0, y: 0, width: 240, height: 240)
        alert.accessoryView = img
        alert.addButton(withTitle: "닫기")
        alert.addButton(withTitle: "주소 복사")
        if alert.runModal() == .alertSecondButtonReturn {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(url, forType: .string)
        }
    }

    func qr(_ s: String) -> NSImage {
        let f = CIFilter(name: "CIQRCodeGenerator")!
        f.setValue(Data(s.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        let rep = NSCIImageRep(ciImage: f.outputImage!.transformed(by: CGAffineTransform(scaleX: 8, y: 8)))
        let img = NSImage(size: rep.size)
        img.addRepresentation(rep)
        return img
    }

    @objc func reload() { web.reload() }

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let host = NSMenuItem()
            host.submenu = m
            main.addItem(host)
        }
        let android = NSMenuItem(title: "Android 앱 설치…", action: #selector(showAndroid), keyEquivalent: "a")
        android.keyEquivalentModifierMask = [.command, .shift]
        lidItem = NSMenuItem(title: "덮개 닫아도 계속 실행 (충전 중)", action: #selector(toggleLid), keyEquivalent: "")
        alwaysItem = NSMenuItem(title: "    암호 묻지 않기 (항상 허용)", action: #selector(toggleAlways), keyEquivalent: "")
        sub("Token Relay", [
            android,
            lidItem,
            alwaysItem,
            .separator(),
            NSMenuItem(title: "Token Relay 종료 (작업도 멈춤)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ])
        // 편집 메뉴가 있어야 입력창에서 ⌘C/⌘V 가 동작
        sub("편집", [
            NSMenuItem(title: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z"),
            .separator(),
            NSMenuItem(title: "잘라내기", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
            NSMenuItem(title: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
            NSMenuItem(title: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
            NSMenuItem(title: "전체 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
        ])
        sub("보기", [NSMenuItem(title: "새로고침", action: #selector(reload), keyEquivalent: "r")])
        NSApp.mainMenu = main
    }

    // 창을 닫아도 앱(서버)은 계속 동작. Dock 아이콘 클릭 시 창 다시 표시
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ n: Notification) {
        quitting = true
        // 원래대로: 항상 허용이면 바로, 아니면 감시가 죽었을 때만 직접 (관리자 암호 한 번 더)
        if lidOn {
            if alwaysAllowed { _ = sudoPmset(0) }
            else if !lidWatcherAlive() { _ = runAdmin("/usr/bin/pmset -c disablesleep 0") }
        }
        server?.terminate()
        server?.waitUntilExit()
    }

    // 로그인 링크(target=_blank)는 기본 브라우저로
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // WKWebView 는 기본적으로 JS alert 를 무시함
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = m
        a.runModal()
        completionHandler()
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = App()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}

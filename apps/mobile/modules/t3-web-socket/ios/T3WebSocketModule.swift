import ExpoModulesCore
import Foundation
import WebKit

private final class Connection {
  let id: Int
  let verifiedSession: URLSession?
  var task: URLSessionWebSocketTask?
  var finished = false
  var requestedCloseCode: Int?
  var failure: String?

  init(id: Int, verifiedSession: URLSession?) {
    self.id = id
    self.verifiedSession = verifiedSession
  }
}

/// A WebSocket client that offers permessage-deflate. React Native's SocketRocket never does,
/// so a large snapshot reached an iPhone uncompressed. URLSession offers the extension on every
/// handshake with no public switch, which is what we want here.
public final class T3WebSocketModule: Module {
  private var connections: [Int: Connection] = [:]
  private var requests: [String: T3VerifiedRequest] = [:]
  private var nextId = 1
  private let lock = NSLock()
  private var session: URLSession?
  private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return queue
  }()

  public func definition() -> ModuleDefinition {
    Name("T3WebSocket")
    Events("open", "message", "close", "error", "verifiedResponse", "verifiedProgress", "verifiedHeaders", "verifiedChunk")

    AsyncFunction("blockWebViewNetworkLoads") { (tag: Int, promise: Promise) in
      Task { @MainActor in
        do {
          guard let host = self.appContext?.findView(withTag: tag, ofType: UIView.self),
                let view = verifiedWebView(in: host),
                view.window != nil, view.url?.absoluteString == "about:blank"
          else { throw WebViewNetworkFenceError.viewUnavailable }
          let rules = try await WebViewNetworkFence.ruleList()
          guard self.appContext?.findView(withTag: tag, ofType: UIView.self) === host,
                verifiedWebView(in: host) === view,
                view.window != nil, view.url?.absoluteString == "about:blank"
          else { throw WebViewNetworkFenceError.viewUnavailable }
          view.configuration.userContentController.add(rules)
          promise.resolve(true)
        } catch {
          promise.reject(error)
        }
      }
    }

    Function("connect") { (url: URL, protocols: [String]) -> Int in
      let session = self.session ?? self.makeSession()
      self.session = session
      return self.startConnection(url, protocols: protocols, session: session)
    }

    Function("connectVerified") { (url: URL, protocols: [String], httpsOrigin: URL, leafSpkiSha256: String) throws -> Int in
      try self.connectVerified(url, protocols: protocols, origin: httpsOrigin, pin: leafSpkiSha256)
    }

    Function("connectVerifiedRelay") { (url: URL, protocols: [String], httpsOrigin: URL, leafSpkiSha256: String, relayAuthorization: String) throws -> Int in
      try self.connectVerified(url, protocols: protocols, origin: httpsOrigin, pin: leafSpkiSha256, relayAuthorization: relayAuthorization)
    }

    Function("startVerifiedRequest") { (id: String, options: T3VerifiedRequestOptions) in
      try self.startVerifiedRequest(id, options: options)
    }

    Function("startVerifiedRelayRequest") { (id: String, options: T3VerifiedRequestOptions, relayAuthorization: String) in
      try self.startVerifiedRequest(id, options: options, relayAuthorization: relayAuthorization)
    }

    Function("acknowledgeVerifiedChunk") { (id: String) in
      self.withLock { self.requests[id] }?.acknowledgeChunk()
    }

    Function("cancelVerifiedRequest") { (id: String) in
      let request = self.withLock { self.requests.removeValue(forKey: id) }
      request?.cancel()
    }

    Function("sendText") { (id: Int, text: String) in
      guard let connection = self.connection(id), let task = connection.task else { return }
      task.send(.string(text)) { [weak self] error in
        if let error { self?.fail(connection, task: task, error: error) }
      }
    }

    Function("sendBinary") { (id: Int, bytes: Uint8Array) in
      guard let connection = self.connection(id), let task = connection.task else { return }
      let data = Data(bytes: bytes.rawPointer, count: bytes.byteLength)
      task.send(.data(data)) { [weak self] error in
        if let error { self?.fail(connection, task: task, error: error) }
      }
    }

    Function("close") { (id: Int, code: Int, reason: String) in
      guard let connection = self.connection(id) else { return }
      // URLSession can only send the codes it names; anything else goes out as a normal closure.
      let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code).flatMap { $0 == .invalid ? nil : $0 } ?? .normalClosure
      let task = self.withLock { () -> URLSessionWebSocketTask? in
        connection.requestedCloseCode = closeCode.rawValue
        return connection.task
      }
      task?.cancel(with: closeCode, reason: reason.isEmpty ? nil : reason.data(using: .utf8))
    }

    OnDestroy {
      self.session?.invalidateAndCancel()
      let sessions = self.withLock { self.connections.values.compactMap(\.verifiedSession) }
      for session in sessions { session.invalidateAndCancel() }
      let transfers = self.withLock {
        let active = Array(self.requests.values)
        self.requests.removeAll()
        return active
      }
      for transfer in transfers { transfer.cancel() }
    }
  }

  private func startVerifiedRequest(
    _ id: String, options: T3VerifiedRequestOptions, relayAuthorization: String? = nil
  ) throws {
    guard let url = options.url, let origin = options.httpsOrigin else {
      throw T3VerifiedRouteError.invalidBinding
    }
    let route = try T3VerifiedRoute(httpsOrigin: origin, leafSpkiSha256: options.leafSpkiSha256)
    var request = URLRequest(url: url)
    request.httpMethod = options.method
    request.allHTTPHeaderFields = options.headers
    guard route.allows(request),
          options.uploadFile?.isFileURL != false,
          options.downloadFile?.isFileURL != false,
          !options.stream || (options.method == "GET" && options.downloadFile == nil),
          !(options.uploadFile != nil && options.bodyBase64 != nil)
    else { throw T3VerifiedRouteError.requestOutsideBinding }
    if let body = options.bodyBase64 {
      guard body.count <= 12 * 1024 * 1024, let data = Data(base64Encoded: body),
            data.count <= 8 * 1024 * 1024
      else { throw T3VerifiedRouteError.unexpectedResponse }
      request.httpBody = data
    }
    if let relayAuthorization {
      request = try route.relayRequest(request, transport: .https, relayAuthorization: relayAuthorization)
    }
    let streamEvent: ((String, [String: Any]) -> Void)? = options.stream ? { [weak self] event, payload in
      guard let self, self.withLock({ self.requests[id] != nil }) else { return }
      self.sendEvent(event, payload.merging(["id": id]) { value, _ in value })
    } : nil
    let transfer = T3VerifiedRequest(route: route, destination: options.downloadFile, streamEvent: streamEvent) { [weak self] result in
      guard let self else { return }
      let active = self.withLock { self.requests.removeValue(forKey: id) != nil }
      if active { self.sendEvent("verifiedResponse", result.merging(["id": id]) { value, _ in value }) }
    } progress: { [weak self] fraction in
      self?.sendEvent("verifiedProgress", ["id": id, "fraction": fraction])
    }
    self.withLock { self.requests[id] = transfer }
    do {
      try transfer.start(request, uploadFile: options.uploadFile)
    } catch {
      self.withLock { _ = self.requests.removeValue(forKey: id) }
      throw error
    }
  }

  private func connectVerified(
    _ url: URL, protocols: [String], origin: URL, pin: String, relayAuthorization: String? = nil
  ) throws -> Int {
    let route = try T3VerifiedRoute(httpsOrigin: origin, leafSpkiSha256: pin)
    guard route.allows(url, transport: .wss) else { throw T3VerifiedRouteError.requestOutsideBinding }
    var admitted: URLRequest?
    if let relayAuthorization {
      var request = URLRequest(url: url)
      if !protocols.isEmpty {
        request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
      }
      admitted = try route.relayRequest(request, transport: .wss, relayAuthorization: relayAuthorization)
    }
    let session = URLSession(
      configuration: T3VerifiedRouteTransport.configuration(relayAdmission: admitted != nil),
      delegate: SessionDelegate(module: self, route: route),
      delegateQueue: self.delegateQueue
    )
    return startConnection(url, protocols: protocols, session: session, verifiedSession: session, admitted: admitted)
  }

  private func startConnection(
    _ url: URL, protocols: [String], session: URLSession, verifiedSession: URLSession? = nil,
    admitted: URLRequest? = nil
  ) -> Int {
    let task: URLSessionWebSocketTask
    if let admitted {
      task = session.webSocketTask(with: admitted)
    } else {
      task = protocols.isEmpty
        ? session.webSocketTask(with: url)
        : session.webSocketTask(with: url, protocols: protocols)
    }
    // The app splits frames at 48 KiB, but older servers and the outdated-host probe send whole
    // messages, so stay well above URLSession's 1 MiB default.
    task.maximumMessageSize = 128 * 1024 * 1024
    let connection = withLock { () -> Connection in
      let connection = Connection(id: nextId, verifiedSession: verifiedSession)
      nextId += 1
      connection.task = task
      connections[connection.id] = connection
      return connection
    }
    task.resume()
    receive(on: connection, task: task)
    return connection.id
  }

  private func makeSession() -> URLSession {
    let configuration = URLSessionConfiguration.default
    // Dev clients register URLProtocol classes that intercept the upgrade and drop the socket.
    configuration.protocolClasses = []
    return URLSession(configuration: configuration, delegate: SessionDelegate(module: self), delegateQueue: delegateQueue)
  }

  private func connection(_ id: Int) -> Connection? {
    withLock { connections[id] }
  }

  private func connection(for task: URLSessionTask) -> Connection? {
    withLock { connections.values.first { $0.task === task } }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func receive(on connection: Connection, task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        self.sendEvent("message", ["id": connection.id, "text": text])
        self.receive(on: connection, task: task)
      case .success(.data(let data)):
        self.sendEvent("message", ["id": connection.id, "data": data])
        self.receive(on: connection, task: task)
      case .success:
        self.receive(on: connection, task: task)
      case .failure(let error):
        self.fail(connection, task: task, error: error)
      }
    }
  }

  /// Every ending is reported once, from the delegate. A receive or send failure on a task that is
  /// still running (an oversized message, for one) gets no delegate callback until it is cancelled.
  private func fail(_ connection: Connection, task: URLSessionWebSocketTask, error: Error) {
    let live = withLock { () -> Bool in
      guard !connection.finished else { return false }
      if connection.failure == nil { connection.failure = error.localizedDescription }
      return true
    }
    guard live, task.state == .running else { return }
    task.cancel()
  }

  fileprivate func didOpen(task: URLSessionWebSocketTask) {
    guard let connection = connection(for: task) else { return }
    sendEvent("open", ["id": connection.id])
  }

  fileprivate func didClose(task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard let connection = connection(for: task) else { return }
    finish(connection, code: code.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "", clean: true)
  }

  fileprivate func didComplete(task: URLSessionTask, error: Error?) {
    guard let connection = connection(for: task) else { return }
    let (requested, failure) = withLock { (connection.requestedCloseCode, connection.failure) }
    if requested == nil, let message = failure ?? error?.localizedDescription {
      sendEvent("error", ["id": connection.id, "message": message])
    }
    // A task that ends without a close frame is an abnormal closure, as in browsers; one we
    // cancelled ourselves reports the code we asked for.
    finish(connection, code: requested ?? (error == nil && failure == nil ? 1005 : 1006), reason: "", clean: requested != nil)
  }

  private func finish(_ connection: Connection, code: Int, reason: String, clean: Bool) {
    let first = withLock { () -> Bool in
      if connection.finished { return false }
      connection.finished = true
      connections.removeValue(forKey: connection.id)
      return true
    }
    guard first else { return }
    connection.verifiedSession?.finishTasksAndInvalidate()
    sendEvent("close", ["id": connection.id, "code": code, "reason": reason, "wasClean": clean])
  }
}

private final class SessionDelegate: T3RouteSecurityDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
  private weak var module: T3WebSocketModule?

  init(module: T3WebSocketModule, route: T3VerifiedRoute? = nil) {
    self.module = module
    super.init(route: route)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    module?.didOpen(task: webSocketTask)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    module?.didClose(task: webSocketTask, code: closeCode, reason: reason)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    module?.didComplete(task: task, error: error)
  }
}

private enum WebViewNetworkFenceError: Error {
  case viewUnavailable
  case rulesUnavailable
}

@MainActor
private enum WebViewNetworkFence {
  private static let compiledRules = Task<WKContentRuleList, Error> {
    guard let store = WKContentRuleListStore.default() else {
      throw WebViewNetworkFenceError.rulesUnavailable
    }
    guard let rules = try await store.compileContentRuleList(
      forIdentifier: "com.t3tools.verified-web-view.network-block.v1",
      encodedContentRuleList: """
      [
        {"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
        {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}}
      ]
      """
    ) else { throw WebViewNetworkFenceError.rulesUnavailable }
    return rules
  }

  static func ruleList() async throws -> WKContentRuleList {
    try await compiledRules.value
  }
}

@MainActor
private func verifiedWebView(in host: UIView) -> WKWebView? {
  func descendants(_ view: UIView) -> [WKWebView] {
    if let webView = view as? WKWebView { return [webView] }
    return view.subviews.flatMap(descendants)
  }
  let matches = descendants(host)
  return matches.count == 1 ? matches[0] : nil
}

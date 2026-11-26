import ExpoModulesCore
import Foundation

struct T3VerifiedRequestOptions: Record {
  @Field var url: URL?
  @Field var httpsOrigin: URL?
  @Field var leafSpkiSha256 = ""
  @Field var method = "GET"
  @Field var headers: [String: String] = [:]
  @Field var bodyBase64: String?
  @Field var uploadFile: URL?
  @Field var downloadFile: URL?
  @Field var stream = false
}

final class T3VerifiedRequest: T3RouteSecurityDelegate, URLSessionDataDelegate, @unchecked Sendable {
  private let destination: URL?
  private let streamEvent: ((String, [String: Any]) -> Void)?
  private let credit = DispatchSemaphore(value: 0)
  private let emit: ([String: Any]) -> Void
  private let progress: (Double) -> Void
  private let memoryLimit = 8 * 1024 * 1024
  private let fileLimit = 128 * 1024 * 1024
  private var response: HTTPURLResponse?
  private var bytes = Data()
  private var written = 0
  private var output: FileHandle?
  private var scratch: URL?
  private var failure: Error?
  private(set) var task: URLSessionTask?

  init(
    route: T3VerifiedRoute, destination: URL?,
    streamEvent: ((String, [String: Any]) -> Void)? = nil,
    emit: @escaping ([String: Any]) -> Void, progress: @escaping (Double) -> Void
  ) {
    self.destination = destination
    self.streamEvent = streamEvent
    self.emit = emit
    self.progress = progress
    super.init(route: route)
  }

  func start(_ request: URLRequest, uploadFile: URL?) throws {
    if let uploadFile {
      guard let size = try uploadFile.resourceValues(forKeys: [.fileSizeKey]).fileSize,
            size <= fileLimit else { throw T3VerifiedRouteError.unexpectedResponse }
    }
    let configuration = T3VerifiedRouteTransport.configuration(
      relayAdmission: request.value(forHTTPHeaderField: T3VerifiedRoute.relayAuthorizationHeader) != nil
    )
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = streamEvent == nil ? 300 : 7 * 24 * 60 * 60
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    if let uploadFile {
      task = session.uploadTask(with: request, fromFile: uploadFile)
    } else {
      task = session.dataTask(with: request)
    }
    task?.resume()
  }

  func acknowledgeChunk() {
    credit.signal()
  }

  func cancel() {
    task?.cancel()
    credit.signal()
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    self.response = http
    streamEvent?("verifiedHeaders", ["status": http.statusCode, "headers": headers(http)])
    do {
      if let destination, (200..<300).contains(http.statusCode) {
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else {
          throw T3VerifiedRouteError.unexpectedResponse
        }
        scratch = temporary
        output = try FileHandle(forWritingTo: temporary)
      }
      completionHandler(.allow)
    } catch {
      failure = error
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do {
      if let streamEvent {
        for offset in stride(from: 0, to: data.count, by: 64 * 1024) {
          guard dataTask.state == .running else { return }
          let chunk = data.subdata(in: offset..<min(offset + 64 * 1024, data.count))
          streamEvent("verifiedChunk", ["dataBase64": chunk.base64EncodedString()])
          guard credit.wait(timeout: .now() + 30) == .success else {
            throw T3VerifiedRouteError.unexpectedResponse
          }
        }
      } else if let output {
        written += data.count
        guard written <= fileLimit else { throw T3VerifiedRouteError.unexpectedResponse }
        try output.write(contentsOf: data)
      } else {
        guard bytes.count + data.count <= memoryLimit else { throw T3VerifiedRouteError.unexpectedResponse }
        bytes.append(data)
      }
    } catch {
      failure = error
      dataTask.cancel()
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    if totalBytesExpectedToSend > 0 {
      progress(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    defer {
      if let scratch { try? FileManager.default.removeItem(at: scratch) }
      session.finishTasksAndInvalidate()
    }
    do {
      try output?.close()
      if let error = failure ?? error { throw error }
      guard let response else { throw T3VerifiedRouteError.unexpectedResponse }
      if let scratch, let destination {
        try FileManager.default.moveItem(at: scratch, to: destination)
      }
      emit(["status": response.statusCode, "headers": headers(response), "bodyBase64": bytes.base64EncodedString()])
    } catch {
      emit(["error": "Verified request failed."])
    }
  }

  private func headers(_ response: HTTPURLResponse) -> [String: String] {
    response.allHeaderFields.reduce(into: [:]) { headers, field in
      if let name = field.key as? String { headers[name] = String(describing: field.value) }
    }
  }
}

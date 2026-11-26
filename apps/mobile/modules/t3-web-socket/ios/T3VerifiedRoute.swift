import CryptoKit
import Foundation
import Security

enum T3VerifiedRouteError: LocalizedError {
  case invalidBinding
  case requestOutsideBinding
  case unexpectedResponse

  var errorDescription: String? {
    switch self {
    case .invalidBinding: return "Invalid verified route binding."
    case .requestOutsideBinding: return "Request does not match the verified route."
    case .unexpectedResponse: return "Unexpected response from the verified route."
    }
  }
}

struct T3VerifiedRoute: Sendable {
  static let relayAuthorizationHeader = "Proxy-Authorization"
  enum Transport: String {
    case https
    case wss
  }

  private let host: String
  private let port: Int
  private let leafSpkiSha256: Data

  init(httpsOrigin: URL, leafSpkiSha256: String) throws {
    guard let origin = Self.components(for: httpsOrigin, transport: .https),
          origin.percentEncodedPath.isEmpty || origin.percentEncodedPath == "/",
          origin.percentEncodedQuery == nil,
          let host = origin.percentEncodedHost?.lowercased(),
          let digest = Data(base64Encoded: leafSpkiSha256), digest.count == 32
    else { throw T3VerifiedRouteError.invalidBinding }

    self.host = host
    port = origin.port ?? 443
    self.leafSpkiSha256 = digest
  }

  func allows(_ url: URL, transport: Transport) -> Bool {
    guard let endpoint = Self.components(for: url, transport: transport) else { return false }
    return endpoint.percentEncodedHost?.lowercased() == host && (endpoint.port ?? 443) == port
  }

  func allows(_ request: URLRequest, transport: Transport = .https) -> Bool {
    guard let url = request.url, allows(url, transport: transport) else { return false }
    return request.value(forHTTPHeaderField: "Host") == nil
      && request.value(forHTTPHeaderField: Self.relayAuthorizationHeader) == nil
      && request.value(forHTTPHeaderField: "Upgrade") == nil
  }

  func relayRequest(
    _ request: URLRequest, transport: Transport, relayAuthorization: String
  ) throws -> URLRequest {
    let credential = relayAuthorization.utf8.dropFirst("Bearer ".utf8.count)
    guard allows(request, transport: transport),
          relayAuthorization.hasPrefix("Bearer "),
          (1...512).contains(credential.count),
          credential.allSatisfy({ (33...126).contains($0) && $0 != 44 })
    else { throw T3VerifiedRouteError.requestOutsideBinding }
    var admitted = request
    admitted.setValue(relayAuthorization, forHTTPHeaderField: Self.relayAuthorizationHeader)
    guard admitted.value(forHTTPHeaderField: Self.relayAuthorizationHeader) == relayAuthorization
    else { throw T3VerifiedRouteError.unexpectedResponse }
    return admitted
  }

  func acceptsServerTrust(_ trust: SecTrust) -> Bool {
    guard SecTrustEvaluateWithError(trust, nil),
          let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
    else { return false }
    return matchesLeaf(SecCertificateCopyData(leaf) as Data)
  }

  func matchesLeaf(_ certificate: Data) -> Bool {
    guard let spki = Self.subjectPublicKeyInfo(in: certificate) else { return false }
    return Data(SHA256.hash(data: spki)) == leafSpkiSha256
  }

  func disposition(for challenge: URLAuthenticationChallenge)
    -> (URLSession.AuthChallengeDisposition, URLCredential?)
  {
    let protectionSpace = challenge.protectionSpace
    guard protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          !protectionSpace.isProxy(),
          protectionSpace.host.lowercased() == host, protectionSpace.port == port,
          challenge.previousFailureCount == 0,
          let trust = protectionSpace.serverTrust, acceptsServerTrust(trust)
    else { return (.cancelAuthenticationChallenge, nil) }
    return (.useCredential, URLCredential(trust: trust))
  }

  private static func components(for url: URL, transport: Transport) -> URLComponents? {
    guard url.baseURL == nil,
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme?.lowercased() == transport.rawValue,
          let host = components.percentEncodedHost, !host.isEmpty,
          !host.contains("%"), !host.contains(":"), !host.hasSuffix("."),
          (1...65535).contains(components.port ?? 443),
          components.user == nil, components.password == nil, components.fragment == nil
    else { return nil }
    return components
  }

  private static func subjectPublicKeyInfo(in certificate: Data) -> Data? {
    let bytes = [UInt8](certificate)
    var offset = 0
    guard let outer = readDer(0x30, bytes, &offset, limit: bytes.count),
          outer.endIndex == bytes.count
    else { return nil }
    offset = outer.startIndex
    guard let tbs = readDer(0x30, bytes, &offset, limit: outer.endIndex) else { return nil }
    offset = tbs.startIndex
    if offset < tbs.endIndex, bytes[offset] == 0xa0 {
      guard readDer(0xa0, bytes, &offset, limit: tbs.endIndex) != nil else { return nil }
    }
    // The signed certificate fields before SubjectPublicKeyInfo.
    let precedingFields: [UInt8] = [0x02, 0x30, 0x30, 0x30, 0x30]
    for tag in precedingFields {
      guard readDer(tag, bytes, &offset, limit: tbs.endIndex) != nil else { return nil }
    }
    let spkiStart = offset
    guard readDer(0x30, bytes, &offset, limit: tbs.endIndex) != nil else { return nil }
    return Data(bytes[spkiStart..<offset])
  }

  private static func readDer(_ tag: UInt8, _ bytes: [UInt8], _ offset: inout Int, limit: Int) -> Range<Int>? {
    guard limit - offset >= 2, bytes[offset] == tag else { return nil }
    let lengthByte = Int(bytes[offset + 1])
    offset += 2
    var length = lengthByte
    if lengthByte >= 128 {
      let count = lengthByte & 0x7f
      guard (1...4).contains(count), count <= limit - offset, bytes[offset] != 0 else { return nil }
      length = 0
      for _ in 0..<count {
        length = (length << 8) | Int(bytes[offset])
        offset += 1
      }
      guard length >= 128 else { return nil }
    }
    guard length <= limit - offset else { return nil }
    let start = offset
    offset += length
    return start..<offset
  }
}

struct T3VerifiedRouteTransport: Sendable {
  let route: T3VerifiedRoute

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    guard route.allows(request) else { throw T3VerifiedRouteError.requestOutsideBinding }
    let session = URLSession(
      configuration: Self.configuration(),
      delegate: T3RouteSecurityDelegate(route: route),
      delegateQueue: nil
    )
    defer { session.finishTasksAndInvalidate() }
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else { throw T3VerifiedRouteError.unexpectedResponse }
    return (data, response)
  }

  static func configuration(relayAdmission: Bool = false) -> URLSessionConfiguration {
    // URLSession applies accepted server trust across the session's tasks.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = []
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    // Relay admission belongs to the pinned origin, including when system proxies are configured.
    if relayAdmission { configuration.connectionProxyDictionary = [:] }
    return configuration
  }
}

class T3RouteSecurityDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let route: T3VerifiedRoute?

  init(route: T3VerifiedRoute?) {
    self.route = route
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let (disposition, credential) = route?.disposition(for: challenge) ?? (.performDefaultHandling, nil)
    completionHandler(disposition, credential)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    urlSession(session, didReceive: challenge, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(route == nil ? request : nil)
  }
}

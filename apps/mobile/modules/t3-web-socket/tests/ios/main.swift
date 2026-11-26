import Foundation
import Security

func check(_ passed: Bool, _ message: String) {
  guard passed else { fatalError(message) }
}

let origin = URL(string: "https://route.test:8443")!
let pin = "Tf9HzpC0kqiiEQjOINSb38h3wZ2VD98GJGsjxDpodW8="
let route = try T3VerifiedRoute(httpsOrigin: origin, leafSpkiSha256: pin)

let authorityCases: [(T3VerifiedRoute.Transport, String, Bool)] = [
  (.https, "https://ROUTE.test:8443/auth?code=fixture", true),
  (.wss, "wss://route.test:8443/ws?ticket=fixture", true),
  (.https, "https://route.test/auth", false),
  (.https, "https://route.test.evil.test:8443/auth", false),
  (.https, "https://route.test.:8443/auth", false),
  (.https, "https://other@route.test:8443/auth", false),
  (.https, "https://route.test:8443/auth#fragment", false),
  (.https, "http://route.test:8443/auth", false),
  (.https, "wss://route.test:8443/ws", false),
  (.wss, "https://route.test:8443/ws", false),
  (.wss, "ws://route.test:8443/ws", false),
]
for (transport, url, allowed) in authorityCases {
  check(route.allows(URL(string: url)!, transport: transport) == allowed, "Unexpected authority decision for \(url)")
}

let defaultRoute = try T3VerifiedRoute(httpsOrigin: URL(string: "https://route.test/")!, leafSpkiSha256: pin)
check(defaultRoute.allows(URL(string: "wss://route.test:443/ws")!, transport: .wss), "Explicit HTTPS default port must match")
check((try? T3VerifiedRoute(httpsOrigin: origin, leafSpkiSha256: "invalid")) == nil, "Invalid digest accepted")
check((try? T3VerifiedRoute(httpsOrigin: URL(string: "https://route.test/path")!, leafSpkiSha256: pin)) == nil, "Non-origin enrollment URL accepted")

var request = URLRequest(url: URL(string: "https://route.test:8443/bootstrap")!)
request.setValue("Bearer fixture", forHTTPHeaderField: "Authorization")
check(route.allows(request), "Bound authenticated request rejected")
let relayAuthorization = "Bearer relay-session"
let admitted = try route.relayRequest(request, transport: .https, relayAuthorization: relayAuthorization)
check(admitted.value(forHTTPHeaderField: "Authorization") == "Bearer fixture", "Destination credential changed")
check(admitted.value(forHTTPHeaderField: "Proxy-Authorization") == relayAuthorization, "Relay header missing")
check((try? route.relayRequest(admitted, transport: .https, relayAuthorization: relayAuthorization)) == nil, "Caller relay header accepted")
check((try? route.relayRequest(request, transport: .https, relayAuthorization: "Bearer one, Bearer two")) == nil, "Ambiguous relay header accepted")
let ticket = URL(string: "wss://route.test:8443/ws?ticket=fixture%2Bvalue")!
let upgrade = try route.relayRequest(URLRequest(url: ticket), transport: .wss, relayAuthorization: relayAuthorization)
check(upgrade.url == ticket, "WebSocket ticket changed")
check((try? route.relayRequest(URLRequest(url: ticket), transport: .https, relayAuthorization: relayAuthorization)) == nil, "Wrong scheme accepted")
request.setValue("other.test", forHTTPHeaderField: "hOsT")
check(!route.allows(request), "Authority override accepted")
check((try? route.relayRequest(request, transport: .https, relayAuthorization: relayAuthorization)) == nil, "Relay authority override accepted")

// The expected digest is from openssl x509 -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary.
let leaf = Data(base64Encoded: """
  MIIBfzCCASWgAwIBAgIUXFMwynK/nRU6KMkigdHbNmJJf1AwCgYIKoZIzj0EAwIw
  FTETMBEGA1UEAwwKcm91dGUudGVzdDAeFw0yNjExMTkxMTE4NDVaFw0yNjExMjEx
  MTE4NDVaMBUxEzARBgNVBAMMCnJvdXRlLnRlc3QwWTATBgcqhkjOPQIBBggqhkjO
  PQMBBwNCAAQ2CXMcEjlPsMHBBjNLfNK/o9lm0ZbR2YKpkCZV4pZbsnt1ig4KUBlh
  pM0pL5f0cPtl8l3jIM37vkjBkZf/JRbuo1MwUTAdBgNVHQ4EFgQUUMgmAfgEQgK1
  cao55iUXh24UluQwHwYDVR0jBBgwFoAUUMgmAfgEQgK1cao55iUXh24UluQwDwYD
  VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA4ftRuEgr6Fg7OTNNln7A
  nQYcDqcRINrlXt4XIp2lVcUCIG0tm3o/aMCqX04mak3VcAqMcDAa0yYiHvXcGlBo
  MFM5
  """, options: .ignoreUnknownCharacters)!
check(route.matchesLeaf(leaf), "Expected OpenSSL SPKI digest mismatch")
let differentPin = try T3VerifiedRoute(httpsOrigin: origin, leafSpkiSha256: Data(repeating: 0, count: 32).base64EncodedString())
check(!differentPin.matchesLeaf(leaf), "Wrong enrolled key accepted")
check(!route.matchesLeaf(leaf.dropLast()), "Malformed certificate accepted")

let certificate = SecCertificateCreateWithData(nil, leaf as CFData)!
var trust: SecTrust?
check(SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, "route.test" as CFString), &trust) == errSecSuccess, "Fixture trust allocation failed")
check(!route.acceptsServerTrust(trust!), "An untrusted leaf passed with a matching pin")
print("Passed verified route authority, SPKI digest, and system trust checks")

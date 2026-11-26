package expo.modules.t3nativecontrols

import java.net.InetAddress
import java.net.ProtocolException
import java.security.cert.X509Certificate
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.X509TrustManager
import okhttp3.HttpUrl
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class VerifiedRouteTransportTest {
  private val relayAuthorization = "Bearer relay-session"
  private val issuer = HeldCertificate.Builder().certificateAuthority(0).build()
  private val leaf = leafCertificate("localhost")
  private val trust = HandshakeCertificates.Builder().addTrustedCertificate(issuer.certificate).build()

  @Test
  fun httpCredentialsStayOnThePinnedOriginWhenItRedirects() {
    server(leaf).use { enrolled ->
      server(leaf).use { otherOrigin ->
        enrolled.enqueue(MockResponse().setResponseCode(307).addHeader("Location", otherOrigin.url("/")))
        otherOrigin.enqueue(MockResponse().setBody("other origin"))

        transport(enrolled.url("/")).newCall(request(enrolled.url("/session")), relayAuthorization).execute().use { response ->
          assertEquals(307, response.code)
        }

        val received = enrolled.takeRequest()
        assertEquals("Bearer session", received.getHeader("Authorization"))
        assertEquals(listOf(relayAuthorization), received.headers.values("Proxy-Authorization"))
        assertEquals(0, otherOrigin.requestCount)
        assertThrows(IllegalArgumentException::class.java) {
          transport(enrolled.url("/")).newCall(request(otherOrigin.url("/session")), relayAuthorization)
        }
        assertThrows(IllegalArgumentException::class.java) {
          val overriddenRequest = request(enrolled.url("/session")).newBuilder().header("proxy-authorization", "Bearer caller").build()
          transport(enrolled.url("/")).newCall(overriddenRequest, relayAuthorization)
        }
        assertThrows(IllegalArgumentException::class.java) {
          transport(enrolled.url("/")).newCall(request(enrolled.url("/session")), "Bearer one, Bearer two")
        }
        assertThrows(IllegalArgumentException::class.java) {
          val overriddenRequest = request(enrolled.url("/session")).newBuilder().header("Host", "other.example").build()
          transport(enrolled.url("/")).newCall(overriddenRequest)
        }
        assertEquals(0, otherOrigin.requestCount)
      }
    }
  }

  @Test
  fun httpRejectsTheIssuerPinBeforeSendingTheRequest() {
    server(leaf).use { enrolled ->
      enrolled.enqueue(MockResponse())
      assertThrows(SSLPeerUnverifiedException::class.java) {
        transport(enrolled.url("/"), issuer).newCall(request(enrolled.url("/session")), relayAuthorization).execute().close()
      }
      assertEquals(0, enrolled.requestCount)
    }
  }

  @Test
  fun httpRequiresTlsTrustAndTheExpectedHostnameEvenWithTheRightPin() {
    val wrongHostname = leafCertificate("other.example")
    server(wrongHostname).use { enrolled ->
      enrolled.enqueue(MockResponse())
      assertThrows(SSLPeerUnverifiedException::class.java) {
        transport(enrolled.url("/"), wrongHostname).newCall(request(enrolled.url("/session"))).execute().close()
      }
      assertEquals(0, enrolled.requestCount)
    }

    val untrusted = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    server(untrusted, null).use { enrolled ->
      enrolled.enqueue(MockResponse())
      assertThrows(SSLHandshakeException::class.java) {
        VerifiedRouteTransport(enrolled.url("/"), untrusted.certificate.publicKey.encoded.toByteString().sha256())
          .newCall(request(enrolled.url("/session"))).execute().close()
      }
      assertEquals(0, enrolled.requestCount)
    }
  }

  @Test
  fun websocketChecksTheLeafBeforeEachUpgrade() {
    val changedLeaf = leafCertificate("localhost")
    val enrolled = server(leaf)
    val origin = enrolled.url("/")
    val transport = transport(origin)
    enrolled.use {
      enrolled.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          webSocket.close(code, reason)
        }
      }))
      val result = upgrade(transport, enrolled.url("/ws?ticket=fixture"))
      assertEquals(null, result)
      val received = enrolled.takeRequest()
      assertEquals("/ws?ticket=fixture", received.path)
      assertEquals(listOf(relayAuthorization), received.headers.values("Proxy-Authorization"))
    }
    server(changedLeaf, port = origin.port).use { changed ->
      changed.enqueue(MockResponse().setResponseCode(403))
      val result = upgrade(transport, changed.url("/ws?ticket=fixture"))
      assertEquals(SSLPeerUnverifiedException::class.java, result?.javaClass)
      assertEquals(0, changed.requestCount)
    }
  }

  @Test
  fun closingWhileConnectingCancelsBeforeSendingTheUpgradeTicket() {
    val enteredHandshake = CompletableFuture<Unit>()
    val releaseHandshake = CompletableFuture<Unit>()
    val finished = CompletableFuture<Unit>()
    val gatedTrust = object : X509TrustManager by trust.trustManager {
      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        trust.trustManager.checkServerTrusted(chain, authType)
        enteredHandshake.complete(Unit)
        releaseHandshake.get(10, TimeUnit.SECONDS)
      }
    }
    server(leaf).use { enrolled ->
      enrolled.enqueue(MockResponse().setResponseCode(403))
      val pin = leaf.certificate.publicKey.encoded.toByteString().sha256()
      val socketFactory = javax.net.ssl.SSLContext.getInstance("TLS").apply {
        init(null, arrayOf(gatedTrust), null)
      }.socketFactory
      val transport = VerifiedRouteTransport(enrolled.url("/"), pin, socketFactory, gatedTrust)
      val request = Request.Builder().url(enrolled.url("/ws?ticket=fixture")).build()
      val socket = transport.newWebSocket(request, object : WebSocketListener() {
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          finished.complete(Unit)
        }
      })
      try {
        enteredHandshake.get(10, TimeUnit.SECONDS)
        socket.close(1000, "")
        releaseHandshake.complete(Unit)
        finished.get(10, TimeUnit.SECONDS)
        assertEquals(0, enrolled.requestCount)
      } finally {
        releaseHandshake.complete(Unit)
        socket.cancel()
      }
    }
  }

  @Test
  fun websocketDoesNotFollowRedirectWithATicket() {
    server(leaf).use { enrolled ->
      server(leaf).use { otherOrigin ->
        val redirect = otherOrigin.url("/ws?ticket=fixture")
        enrolled.enqueue(MockResponse().setResponseCode(307).addHeader("Location", redirect))
        otherOrigin.enqueue(MockResponse().setResponseCode(403))
        val result = upgrade(transport(enrolled.url("/")), enrolled.url("/ws?ticket=fixture"))
        assertEquals(ProtocolException::class.java, result?.javaClass)
        assertEquals("/ws?ticket=fixture", enrolled.takeRequest().path)
        assertEquals(0, otherOrigin.requestCount)
      }
    }
  }

  private fun transport(origin: HttpUrl, pinned: HeldCertificate = leaf): VerifiedRouteTransport {
    val pin = pinned.certificate.publicKey.encoded.toByteString().sha256()
    return VerifiedRouteTransport(origin, pin, trust.sslSocketFactory(), trust.trustManager)
  }

  private fun leafCertificate(host: String): HeldCertificate =
    HeldCertificate.Builder().addSubjectAlternativeName(host).signedBy(issuer).build()

  private fun server(certificate: HeldCertificate, issuer: HeldCertificate? = this.issuer, port: Int = 0): MockWebServer {
    val tls = HandshakeCertificates.Builder()
    if (issuer == null) {
      tls.heldCertificate(certificate)
    } else {
      tls.heldCertificate(certificate, issuer.certificate)
    }
    return MockWebServer().apply {
      useHttps(tls.build().sslSocketFactory(), false)
      start(InetAddress.getLoopbackAddress(), port)
    }
  }

  private fun request(url: HttpUrl): Request =
    Request.Builder().url(url).header("Authorization", "Bearer session").build()

  private fun upgrade(transport: VerifiedRouteTransport, url: HttpUrl): Throwable? {
    val result = CompletableFuture<Throwable?>()
    val request = Request.Builder().url(url.toString().replaceFirst("https://", "wss://")).build()
    val socket = transport.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        result.complete(null)
        webSocket.close(1000, "")
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        result.complete(t)
      }
    }, relayAuthorization)
    return try {
      result.join()
    } finally {
      socket.cancel()
    }
  }
}

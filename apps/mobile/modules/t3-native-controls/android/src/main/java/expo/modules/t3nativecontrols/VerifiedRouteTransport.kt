package expo.modules.t3nativecontrols

import java.net.Proxy
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager
import okhttp3.Call
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

internal class VerifiedRouteTransport(
  private val origin: HttpUrl,
  leafSpkiSha256: ByteString,
  socketFactory: SSLSocketFactory? = null,
  trustManager: X509TrustManager? = null,
) {
  init {
    require(origin.isHttps && origin.encodedPath == "/" && origin.query == null && origin.fragment == null)
    require(origin.encodedUsername.isEmpty() && origin.encodedPassword.isEmpty())
    require(leafSpkiSha256.size == 32)
    require((socketFactory == null) == (trustManager == null))
  }

  // This client owns its connection pool and can only dial the enrolled authority.
  private val client = OkHttpClient().let { defaults ->
    defaults.newBuilder()
      .apply {
        if (socketFactory != null && trustManager != null) sslSocketFactory(socketFactory, trustManager)
      }
      .hostnameVerifier { host, session ->
        // OkHttp calls this after the trust manager and before writing any HTTP headers.
        host == origin.host && defaults.hostnameVerifier.verify(host, session) &&
          (session.peerCertificates.firstOrNull() as? X509Certificate)
            ?.publicKey?.encoded?.toByteString()?.sha256() == leafSpkiSha256
      }
      .proxy(Proxy.NO_PROXY)
      .readTimeout(30, TimeUnit.SECONDS)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()
  }

  fun newCall(request: Request, relayAuthorization: String? = null): Call =
    client.newCall(prepareRequest(request, relayAuthorization))

  fun newWebSocket(
    request: Request,
    listener: WebSocketListener,
    relayAuthorization: String? = null,
  ): VerifiedWebSocket = VerifiedWebSocket(client, prepareRequest(request, relayAuthorization), listener)

  private fun prepareRequest(request: Request, relayAuthorization: String?): Request {
    // OkHttp normalizes WSS to HTTPS when constructing the request.
    val url = request.url
    require(url.isHttps && url.host == origin.host && url.port == origin.port && url.fragment == null)
    require(url.encodedUsername.isEmpty() && url.encodedPassword.isEmpty())
    require(request.header("Host") == null && request.header("Proxy-Authorization") == null)
    if (relayAuthorization == null) return request
    require(relayAuthorization.startsWith("Bearer "))
    val credential = relayAuthorization.substring("Bearer ".length)
    require(credential.length in 1..512 && credential.all { it in '!'..'~' && it != ',' })
    return request.newBuilder().header("Proxy-Authorization", relayAuthorization).build()
  }
}

internal class VerifiedWebSocket(client: OkHttpClient, request: Request, listener: WebSocketListener) {
  private enum class State { CONNECTING, OPEN, CLOSING }
  private val state = AtomicReference(State.CONNECTING)
  private val socket = client.newWebSocket(request, object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      if (state.compareAndSet(State.CONNECTING, State.OPEN)) listener.onOpen(webSocket, response)
    }

    override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(webSocket, text)

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) = listener.onMessage(webSocket, bytes)

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) =
      listener.onClosing(webSocket, code, reason)

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
      listener.onClosed(webSocket, code, reason)

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
      listener.onFailure(webSocket, t, response)
  })

  fun send(value: String) = socket.send(value)
  fun send(value: ByteString) = socket.send(value)

  fun close(code: Int, reason: String) {
    when (state.getAndSet(State.CLOSING)) {
      // OkHttp queues close frames even before it has sent the upgrade request.
      State.CONNECTING -> socket.cancel()
      State.OPEN -> if (!socket.close(code, reason)) socket.cancel()
      State.CLOSING -> Unit
    }
  }

  fun cancel() {
    state.set(State.CLOSING)
    socket.cancel()
  }
}

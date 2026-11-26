package expo.modules.t3nativecontrols

import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.typedarray.Uint8Array
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.BufferedSink
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString
import okio.source

class VerifiedRequestOptions : Record {
  @Field val url: String = ""
  @Field val httpsOrigin: String = ""
  @Field val leafSpkiSha256: String = ""
  @Field val method: String = ""
  @Field val headers: Map<String, String> = emptyMap()
  @Field val bodyBase64: String? = null
  @Field val uploadFile: String? = null
  @Field val downloadFile: String? = null
  @Field val stream: Boolean = false
}

class T3VerifiedNetworkModule : Module() {
  private val nextSocketId = AtomicInteger(1)
  private val sockets = ConcurrentHashMap<Int, VerifiedWebSocket>()
  private val requests = ConcurrentHashMap<String, Call>()
  private val streamCredits = ConcurrentHashMap<String, Semaphore>()

  override fun definition() = ModuleDefinition {
    Name("T3VerifiedNetwork")
    Events("open", "message", "error", "close", "verifiedResponse", "verifiedProgress", "verifiedHeaders", "verifiedChunk")

    AsyncFunction("blockWebViewNetworkLoads") { tag: Int ->
      val host = appContext.findView<View>(tag)
      val webView = host?.webViewDescendants()?.singleOrNull()
      check(webView != null && webView.isAttachedToWindow && webView.url == "about:blank")
      webView.settings.blockNetworkLoads = true
      true
    }.runOnQueue(Queues.MAIN)

    Function("connectVerified") { url: String, protocols: List<String>, origin: String, pin: String ->
      connectVerified(url, protocols, origin, pin)
    }

    Function("connectVerifiedRelay") {
        url: String, protocols: List<String>, origin: String, pin: String, relayAuthorization: String ->
      connectVerified(url, protocols, origin, pin, relayAuthorization)
    }

    Function("sendText") { id: Int, value: String ->
      sockets[id]?.send(value)
      Unit
    }

    Function("sendBinary") { id: Int, value: Uint8Array ->
      sockets[id]?.send(ByteArray(value.length) { index -> value[index].toByte() }.toByteString())
      Unit
    }

    Function("close") { id: Int, code: Int, reason: String ->
      sockets[id]?.close(code, reason)
      Unit
    }

    Function("startVerifiedRequest") { id: String, options: VerifiedRequestOptions ->
      startRequest(id, options)
    }

    Function("startVerifiedRelayRequest") { id: String, options: VerifiedRequestOptions, relayAuthorization: String ->
      startRequest(id, options, relayAuthorization)
    }

    Function("acknowledgeVerifiedChunk") { id: String ->
      streamCredits[id]?.release()
      Unit
    }

    Function("cancelVerifiedRequest") { id: String ->
      requests.remove(id)?.cancel()
      streamCredits.remove(id)?.release()
      Unit
    }

    OnDestroy {
      val activeSockets = synchronized(sockets) {
        sockets.values.toList().also { sockets.clear() }
      }
      activeSockets.forEach { it.cancel() }
      requests.values.forEach { it.cancel() }
      requests.clear()
      streamCredits.values.forEach { it.release() }
      streamCredits.clear()
    }
  }

  private fun connectVerified(
    url: String,
    protocols: List<String>,
    origin: String,
    pin: String,
    relayAuthorization: String? = null,
  ): Int {
    require(Uri.parse(url).scheme == "wss")
    val request = Request.Builder().url(url).apply {
      if (protocols.isNotEmpty()) header("Sec-WebSocket-Protocol", protocols.joinToString(", "))
    }.build()
    val transport = transport(origin, pin)
    val id = nextSocketId.getAndIncrement()
    synchronized(sockets) {
      sockets[id] = transport.newWebSocket(request, object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
          sendEvent("open", mapOf("id" to id))
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
          sendEvent("message", mapOf("id" to id, "text" to text))
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
          sendEvent("message", mapOf("id" to id, "dataBase64" to bytes.base64()))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
          webSocket.close(1000, "")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
          finishSocket(id, code, reason, true)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          finishSocket(id, 1006, "", false)
        }
      }, relayAuthorization)
    }
    return id
  }

  private fun finishSocket(id: Int, code: Int, reason: String, clean: Boolean) {
    val active = synchronized(sockets) { sockets.remove(id) != null }
    if (!active) return
    if (!clean) sendEvent("error", mapOf("id" to id, "message" to "Verified WebSocket failed."))
    sendEvent("close", mapOf("id" to id, "code" to code, "reason" to reason, "wasClean" to clean))
  }

  private fun startRequest(id: String, options: VerifiedRequestOptions, relayAuthorization: String? = null) {
    val uploader = options.uploadFile?.let(::localFile)
    val destination = options.downloadFile?.let(::localFile)
    require(uploader == null || options.bodyBase64 == null)
    require(!options.stream || (options.method == "GET" && destination == null))
    require(uploader == null || uploader.length() <= FILE_LIMIT)
    val bytes = options.bodyBase64?.let {
      require(it.length <= 12 * 1024 * 1024)
      requireNotNull(it.decodeBase64()).also { data -> require(data.size <= MEMORY_LIMIT) }
    }
    val body = when {
      options.method == "GET" || options.method == "HEAD" -> null
      else -> object : RequestBody() {
        override fun isOneShot() = true
        override fun contentType() = null
        override fun contentLength() = uploader?.length() ?: bytes?.size?.toLong() ?: 0L

        override fun writeTo(sink: BufferedSink) {
          if (uploader != null) {
            uploader.source().use { source ->
              val buffer = Buffer()
              val total = contentLength()
              var sent = 0L
              var reported = 0L
              while (true) {
                val size = source.read(buffer, 64 * 1024L)
                if (size == -1L) break
                sink.write(buffer, size)
                sent += size
                if (total > 0 && (sent == total || sent - reported >= 256 * 1024L)) {
                  sendEvent("verifiedProgress", mapOf("id" to id, "fraction" to sent.toDouble() / total))
                  reported = sent
                }
              }
            }
          } else if (bytes != null) {
            sink.write(bytes)
          }
        }
      }
    }
    val request = Request.Builder().url(options.url).method(options.method, body).apply {
      for ((name, value) in options.headers) header(name, value)
    }.build()
    val call = transport(options.httpsOrigin, options.leafSpkiSha256).newCall(request, relayAuthorization)
    check(requests.putIfAbsent(id, call) == null)
    val credit = if (options.stream) Semaphore(0).also { streamCredits[id] = it } else null
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        completeRequest(id, call, mapOf("error" to "Verified request failed."))
      }

      override fun onResponse(call: Call, response: Response) {
        try {
          response.use {
            val headers = mapOf(
              "status" to it.code,
              "headers" to it.headers.toMultimap().mapValues { entry -> entry.value.joinToString(", ") },
            )
            val bodyBase64 = if (credit == null) readResponse(it, destination) else {
              if (!call.isCanceled()) sendEvent("verifiedHeaders", headers + ("id" to id))
              val source = it.body?.source()
              val buffer = ByteArray(64 * 1024)
              while (source != null && !call.isCanceled()) {
                val size = source.read(buffer)
                if (size < 0) break
                sendEvent("verifiedChunk", mapOf(
                  "id" to id, "dataBase64" to buffer.toByteString(0, size).base64(),
                ))
                if (!credit.tryAcquire(30, TimeUnit.SECONDS)) throw IOException("Stream consumer stalled.")
              }
              ""
            }
            completeRequest(id, call, headers + ("bodyBase64" to bodyBase64))
          }
        } catch (error: IOException) {
          onFailure(call, error)
        } catch (error: InterruptedException) {
          Thread.currentThread().interrupt()
          onFailure(call, IOException(error))
        }
      }
    })
  }

  private fun readResponse(response: Response, destination: File?): String {
    val source = response.body?.source() ?: return ""
    if (destination == null || !response.isSuccessful) {
      if (source.request(MEMORY_LIMIT.toLong() + 1)) throw IOException("Response is too large.")
      return source.readByteString().base64()
    }
    val scratch = File.createTempFile("verified-", ".part", destination.parentFile)
    try {
      scratch.outputStream().use { output ->
        val buffer = ByteArray(64 * 1024)
        var written = 0L
        while (true) {
          val size = source.read(buffer)
          if (size == -1) break
          written += size
          if (written > FILE_LIMIT) throw IOException("Response is too large.")
          output.write(buffer, 0, size)
        }
      }
      if (!scratch.renameTo(destination)) throw IOException("Could not save the response.")
      return ""
    } finally {
      scratch.delete()
    }
  }

  private fun completeRequest(id: String, call: Call, event: Map<String, Any>) {
    if (requests.remove(id, call)) {
      streamCredits.remove(id)
      sendEvent("verifiedResponse", event + ("id" to id))
    }
  }

  private fun transport(origin: String, pin: String) =
    VerifiedRouteTransport(origin.toHttpUrl(), requireNotNull(pin.decodeBase64()))

  private fun localFile(value: String): File {
    val uri = Uri.parse(value)
    require(uri.scheme == "file" && uri.authority.isNullOrEmpty())
    return File(requireNotNull(uri.path))
  }

  private companion object {
    const val MEMORY_LIMIT = 8 * 1024 * 1024
    const val FILE_LIMIT = 128L * 1024 * 1024
  }
}

private fun View.webViewDescendants(): Sequence<WebView> = when (this) {
  is WebView -> sequenceOf(this)
  is ViewGroup -> (0 until childCount).asSequence().flatMap { getChildAt(it).webViewDescendants() }
  else -> emptySequence()
}

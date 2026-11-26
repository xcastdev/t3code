package expo.modules.t3nativecontrols

import android.content.SharedPreferences
import expo.modules.kotlin.exception.CodedException
import expo.modules.securestore.SecureStoreModule
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureStoreCommitTest {
  @Test
  fun `failed encrypted commit throws the SecureStore write error`() {
    for (previous in listOf(null, "previous-encrypted-value")) {
      val prefs = preferences(commitSucceeds = false, initial = previous)
      val error = assertThrows(CodedException::class.java) { saveEncryptedItem(prefs) }
      assertEquals("ERR_WRITE", error.code)
      assertEquals(previous, prefs.getString("test-key", null))
    }
  }

  @Test
  fun `successful encrypted commit completes the write`() {
    val prefs = preferences(commitSucceeds = true, initial = "previous-encrypted-value")
    assertTrue(saveEncryptedItem(prefs))
    assertEquals("test-ciphertext", JSONObject(prefs.getString("test-key", null)!!).getString("ct"))
  }

  private fun preferences(commitSucceeds: Boolean, initial: String?): SharedPreferences {
    var visible = initial
    var pending: String? = null
    val editor = proxy<SharedPreferences.Editor> { receiver, method, args ->
      when (method) {
        "putString" -> {
          pending = args!![1] as String?
          receiver
        }
        "commit" -> {
          visible = pending
          commitSucceeds
        }
        else -> error("Unexpected Editor method: $method")
      }
    }
    return proxy<SharedPreferences> { _, method, _ ->
      when (method) {
        "edit" -> editor
        "getString" -> visible
        else -> error("Unexpected SharedPreferences method: $method")
      }
    }
  }

  private fun saveEncryptedItem(prefs: SharedPreferences): Boolean {
    val save = SecureStoreModule::class.java.getDeclaredMethod(
      "saveEncryptedItem",
      JSONObject::class.java,
      SharedPreferences::class.java,
      String::class.java,
      Boolean::class.javaPrimitiveType,
      String::class.java,
    ).apply { isAccessible = true }
    val encryptedItem = JSONObject().put("ct", "test-ciphertext")
    return try {
      save.invoke(SecureStoreModule(), encryptedItem, prefs, "test-key", false, "test-keychain") as Boolean
    } catch (error: InvocationTargetException) {
      throw error.targetException
    }
  }

  private inline fun <reified T> proxy(crossinline invoke: (Any, String, Array<out Any?>?) -> Any?): T =
    Proxy.newProxyInstance(T::class.java.classLoader, arrayOf(T::class.java)) { receiver, method, args ->
      invoke(receiver, method.name, args)
    } as T
}

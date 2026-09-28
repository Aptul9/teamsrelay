package io.github.aptul9.teamsrelay.push

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// The content of a message of the relay (app/src/agent/push/fcm.ts): AES-256-GCM with the key of this phone, ct being
// the ciphertext followed by the 16-byte tag. A message sealed with another key (the phone registered again) throws.
object Seal {
    fun open(key: ByteArray, iv: ByteArray, ct: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return String(c.doFinal(ct), Charsets.UTF_8)
    }
}

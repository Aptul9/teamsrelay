package io.github.aptul9.teamsrelay.push

import java.util.Base64
import javax.crypto.AEADBadTagException
import org.junit.Assert.assertEquals
import org.junit.Test

// A message sealed by the relay code (sealFor in app/src/agent/push/fcm.ts), key 1..32, iv 0..11
class SealTest {
    private val key = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"
    private val iv = "AAECAwQFBgcICQoL"
    private val ct =
        "ChJ1_ryxBCk1CfMvCvnX30bkzvxe9glcrikR0TW7VRmqitCPI_zbGxUHakzfRJUtAnCMgrK4PNikS7Wj4jEk55oPuWczek-E87mkFjhV-65Y6ag9GP2jMw4Zh3UA2L2qsu5CxFIj3la3iKMeKmEgzoCxJnbwC3602078X6uh"

    private fun b64(s: String) = Base64.getUrlDecoder().decode(s)

    @Test
    fun opensWhatTheRelaySealed() {
        assertEquals(
            """{"title":"Anna Rossi is calling","body":"Teams call, ringing now","acc":2,"call":"ringing","ts":1790000000000}""",
            Seal.open(b64(key), b64(iv), b64(ct)),
        )
    }

    @Test(expected = AEADBadTagException::class)
    fun refusesAMessageSealedWithAnotherKey() {
        Seal.open(ByteArray(32), b64(iv), b64(ct))
    }
}

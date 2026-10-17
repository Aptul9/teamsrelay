// What the server sends this phone is sealed with the key of the phone (sealFor, app/src/agent/push/seal.ts):
// AES-256-GCM, iv of 12 bytes, ct the ciphertext followed by the 16-byte tag, each base64url. A message sealed with
// another key (the phone registered again) does not open.
use base64::{
    alphabet,
    engine::{general_purpose::GeneralPurpose, DecodePaddingMode, GeneralPurposeConfig},
    Engine,
};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};

// base64url as the server writes it, without padding (and with it)
const B64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

pub fn open(key: &str, iv: &str, ct: &str) -> Result<String, String> {
    let key = B64.decode(key).map_err(|e| format!("key: {e}"))?;
    let iv = B64.decode(iv).map_err(|e| format!("iv: {e}"))?;
    let mut ct = B64.decode(ct).map_err(|e| format!("ct: {e}"))?;
    let key = UnboundKey::new(&AES_256_GCM, &key).map_err(|_| "key: not 32 bytes".to_string())?;
    let nonce =
        Nonce::try_assume_unique_for_key(&iv).map_err(|_| "iv: not 12 bytes".to_string())?;
    let plain = LessSafeKey::new(key)
        .open_in_place(nonce, Aad::empty(), &mut ct)
        .map_err(|_| "sealed with another key".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::open;

    // a message sealed by the server code (sealFor of app/src/agent/push/seal.ts), key 1..32, iv 0..11
    const KEY: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
    const IV: &str = "AAECAwQFBgcICQoL";
    const CT: &str = "ChJ1_ryxBCk1CfMvCvnX30bkzvxe9glcrikR0TW7VRmqitCPI_zbGxUHakzfRJUtAnCMgrK4PNikS7Wj4jEk55oPuWczek-E87mkFjhV-65Y6ag9GP2jMw4Zh3UA2L2qsu5CxFIj3la3iKMeKmEgzoCxJnbwC3602078X6uh";

    #[test]
    fn opens_what_the_server_sealed() {
        assert_eq!(
            open(KEY, IV, CT).unwrap(),
            r#"{"title":"Anna Rossi is calling","body":"Teams call, ringing now","acc":2,"call":"ringing","ts":1790000000000}"#
        );
    }

    #[test]
    fn refuses_a_message_sealed_with_another_key() {
        let other = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(open(other, IV, CT).unwrap_err(), "sealed with another key");
    }

    #[test]
    fn refuses_what_is_no_sealed_message() {
        assert!(open(KEY, "AAEC", CT).unwrap_err().starts_with("iv"));
        assert!(open(KEY, IV, "not base64!").unwrap_err().starts_with("ct"));
    }
}

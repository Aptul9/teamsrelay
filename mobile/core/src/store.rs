// What the app keeps on the phone: the address of the server, the Firebase token the server knows the phone by and the
// key it answered for it, the last call of each account. One JSON file in a folder the platform names: on Android
// noBackupFilesDir, since a token or a key restored on another phone means nothing there.
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    // origin of the server, "" before the start page named one
    pub relay: String,
    // "" while the server knows no token of this phone
    pub token: String,
    // the key of the phone, base64url, which opens what the server sends
    pub key: String,
    // the last call of each account (acc, its slot on the server)
    pub calls: BTreeMap<i64, Call>,
}

// A call of an account: when it started ringing (ms, as the server sends it) and whether it ended
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub since: i64,
    pub ended: bool,
}

pub struct Store {
    file: PathBuf,
    state: Mutex<State>,
}

impl Store {
    // A file missing or unreadable starts from nothing: the start page names the server again at each start, and the
    // next registration brings token and key back
    pub fn open(dir: &Path) -> Store {
        let file = dir.join("push.json");
        let state = fs::read(&file)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Store {
            file,
            state: Mutex::new(state),
        }
    }

    pub fn get(&self) -> State {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    // Changes the state and writes it when it changed: the new file whole, then renamed over the old one. A file that
    // cannot be written (a full disk) keeps the change for as long as the app runs: the result comes back with the error,
    // so that a ringing call still shows.
    pub fn update<T>(&self, f: impl FnOnce(&mut State) -> T) -> (T, Result<(), String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let before = state.clone();
        let out = f(&mut state);
        if *state == before {
            return (out, Ok(()));
        }
        let tmp = self.file.with_extension("json.tmp");
        let saved = serde_json::to_vec(&*state)
            .map_err(|e| e.to_string())
            .and_then(|json| {
                fs::write(&tmp, json)
                    .and_then(|_| fs::rename(&tmp, &self.file))
                    .map_err(|e| format!("{}: {e}", self.file.display()))
            });
        (out, saved)
    }

    // Another server: the token and the key of the previous one go. Returns the previous server and the token it knows
    // the phone by, for it to forget the phone (server::forget).
    pub fn use_relay(&self, origin: &str) -> (Option<(String, String)>, Result<(), String>) {
        self.update(|s| {
            if s.relay == origin {
                return None;
            }
            let previous = (
                std::mem::replace(&mut s.relay, origin.to_string()),
                std::mem::take(&mut s.token),
            );
            s.key.clear();
            (!previous.0.is_empty() && !previous.1.is_empty()).then_some(previous)
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // a folder of its own per test, in the temp folder of the system
    pub fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("teamsrelay-core-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    // the result of a change that reached the disk
    pub fn saved<T>((out, saved): (T, Result<(), String>)) -> T {
        saved.unwrap();
        out
    }

    #[test]
    fn keeps_the_state_across_starts() {
        let d = dir("keeps");
        let s = Store::open(&d);
        saved(s.update(|st| {
            st.relay = "https://relay.example.com".into();
            st.calls.insert(
                2,
                Call {
                    since: 5,
                    ended: true,
                },
            );
        }));
        let again = Store::open(&d).get();
        assert_eq!(again.relay, "https://relay.example.com");
        assert_eq!(
            again.calls[&2],
            Call {
                since: 5,
                ended: true
            }
        );
    }

    #[test]
    fn starts_from_nothing_on_a_broken_file() {
        let d = dir("broken");
        fs::write(d.join("push.json"), "{not json").unwrap();
        assert_eq!(Store::open(&d).get(), State::default());
    }

    #[test]
    fn a_file_that_cannot_be_written_keeps_the_change_while_the_app_runs() {
        // a folder that does not exist: nothing can be written there
        let s = Store::open(&dir("unwritable").join("missing"));
        let (out, saved) = s.update(|st| {
            st.key = "KEY".into();
            7
        });
        assert_eq!(out, 7);
        assert!(saved.unwrap_err().contains("push.json"));
        assert_eq!(s.get().key, "KEY");
    }

    #[test]
    fn another_server_drops_token_and_key_and_names_the_previous_one() {
        let s = Store::open(&dir("another"));
        assert_eq!(saved(s.use_relay("https://a.example.com")), None);
        saved(s.update(|st| {
            st.token = "tok".into();
            st.key = "key".into();
        }));
        assert_eq!(saved(s.use_relay("https://a.example.com")), None);
        assert_eq!(s.get().key, "key");
        assert_eq!(
            saved(s.use_relay("https://b.example.com")),
            Some(("https://a.example.com".into(), "tok".into()))
        );
        let st = s.get();
        assert_eq!(
            (st.relay.as_str(), st.token.as_str(), st.key.as_str()),
            ("https://b.example.com", "", "")
        );
    }
}

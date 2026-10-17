// How a message of the server shows on the phone, the same content the web app's service worker gets
// (app/public/sw.js): decided here, drawn by the platform (Android: Notices.kt). A call that rings has one notification
// per account, which rings until the call ends; once it ends a quiet one says who called. A late push changes nothing:
// one of an older call, or a ringing one of a call already ended. A chat keeps one notification with its newest message
// (ts, when it was sent): an older one leaves the newer there, the same text again does not alert. Anything else (sign-in
// needed, check results, a missed call a check found) has a notification of its own.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    seal,
    store::{Call, State, Store},
};

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "show", rename_all = "lowercase")]
pub enum Plan {
    // answer: the account can take the call from the app (an Answer button)
    Ring {
        acc: i64,
        title: String,
        body: String,
        since: i64,
        answer: bool,
    },
    Ended {
        acc: i64,
        title: String,
        body: String,
        since: i64,
    },
    // tag: the chat, per account; again: the text on screen already, shown without alerting
    Message {
        acc: i64,
        tag: String,
        title: String,
        body: String,
        ts: i64,
        again: bool,
    },
    Alert {
        acc: i64,
        title: String,
        body: String,
    },
    // nothing to show, and why
    None {
        why: String,
    },
}

// A notification of the app on screen, as the platform reads it back: tag, the time of its message, its text
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Shown {
    pub tag: String,
    pub ts: i64,
    pub text: String,
}

// data: the data of the push message as the platform received it (v, iv, ct); shown: the notifications of the app on
// screen. Nothing of the chats is kept on the phone: the text of the newest message of a chat is the one on screen.
// Also whether the state reached the disk: the plan stands either way.
pub fn plan(store: &Store, data: &str, shown: &str) -> (Plan, Result<(), String>) {
    let none = |why: String| (Plan::None { why }, Ok(()));
    let data: Value = serde_json::from_str(data).unwrap_or_default();
    if data["v"] != "1" {
        return none("not a message of the server".into());
    }
    let key = store.get().key;
    if key.is_empty() {
        return none("no key: the server does not know this phone".into());
    }
    let text = match seal::open(
        &key,
        data["iv"].as_str().unwrap_or(""),
        data["ct"].as_str().unwrap_or(""),
    ) {
        Ok(t) => t,
        Err(e) => return none(format!("message of the server not opened: {e}")),
    };
    let message: Value = serde_json::from_str(&text).unwrap_or_default();
    let shown: Vec<Shown> = serde_json::from_str(shown).unwrap_or_default();
    store.update(|s| decide(s, &message, &shown))
}

pub fn decide(state: &mut State, m: &Value, shown: &[Shown]) -> Plan {
    let acc = m["acc"].as_i64().unwrap_or(0);
    let title = m["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or("TeamsRelay")
        .to_string();
    let body = m["body"].as_str().unwrap_or("").to_string();
    let ts = m["ts"].as_i64().unwrap_or(0);
    let last = state.calls.get(&acc).copied().unwrap_or_default();
    match m["call"].as_str() {
        Some("ringing") => {
            if ts < last.since || (ts == last.since && last.ended) {
                return Plan::None {
                    why: "late push of a call".into(),
                };
            }
            state.calls.insert(
                acc,
                Call {
                    since: ts,
                    ended: false,
                },
            );
            Plan::Ring {
                acc,
                title,
                body,
                since: ts,
                answer: m["answer"].as_bool().unwrap_or(false),
            }
        }
        Some("ended") => {
            if ts < last.since {
                return Plan::None {
                    why: "end of an older call".into(),
                };
            }
            state.calls.insert(
                acc,
                Call {
                    since: ts,
                    ended: true,
                },
            );
            Plan::Ended {
                acc,
                title,
                body,
                since: ts,
            }
        }
        _ => {
            let tag = m["tag"].as_str().unwrap_or("");
            if !tag.starts_with("chat-") {
                return Plan::Alert { acc, title, body };
            }
            let on_screen = shown.iter().find(|s| s.tag == tag);
            if on_screen.is_some_and(|s| s.ts > ts) {
                return Plan::None {
                    why: "older message of a chat".into(),
                };
            }
            let again = !body.is_empty() && on_screen.is_some_and(|s| s.text == body);
            Plan::Message {
                acc,
                tag: tag.to_string(),
                title,
                body,
                ts,
                again,
            }
        }
    }
}

// Answer taken in the app: pushes of the ring still on their way change nothing, the end of the call from the server
// replaces the notification
pub fn stop_ring(store: &Store, acc: i64, since: i64) -> Result<(), String> {
    store
        .update(|s| {
            s.calls.insert(acc, Call { since, ended: true });
        })
        .1
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::store::tests::{dir, saved};

    fn ringing(acc: i64, ts: i64) -> Value {
        json!({ "title": "Anna Rossi is calling", "body": "Teams call, ringing now", "acc": acc, "call": "ringing", "ts": ts, "answer": true })
    }

    fn ended(acc: i64, ts: i64) -> Value {
        json!({ "title": "Call from Anna Rossi", "body": "Ended after 9 s", "acc": acc, "call": "ended", "ts": ts })
    }

    #[test]
    fn a_call_rings_then_ends() {
        let mut s = State::default();
        assert_eq!(
            decide(&mut s, &ringing(2, 100), &[]),
            Plan::Ring {
                acc: 2,
                title: "Anna Rossi is calling".into(),
                body: "Teams call, ringing now".into(),
                since: 100,
                answer: true
            }
        );
        assert_eq!(
            decide(&mut s, &ended(2, 100), &[]),
            Plan::Ended {
                acc: 2,
                title: "Call from Anna Rossi".into(),
                body: "Ended after 9 s".into(),
                since: 100
            }
        );
        assert_eq!(
            s.calls[&2],
            Call {
                since: 100,
                ended: true
            }
        );
    }

    #[test]
    fn a_late_push_of_a_call_changes_nothing() {
        let mut s = State::default();
        decide(&mut s, &ringing(2, 100), &[]);
        decide(&mut s, &ended(2, 100), &[]);
        // the ring of the call that ended, delivered after its end
        assert!(matches!(
            decide(&mut s, &ringing(2, 100), &[]),
            Plan::None { .. }
        ));
        // the end of an older call
        assert!(matches!(
            decide(&mut s, &ended(2, 50), &[]),
            Plan::None { .. }
        ));
        // a new call rings again
        assert!(matches!(
            decide(&mut s, &ringing(2, 200), &[]),
            Plan::Ring { since: 200, .. }
        ));
        // the ring of an older call while a newer one rings
        assert!(matches!(
            decide(&mut s, &ringing(2, 150), &[]),
            Plan::None { .. }
        ));
        // calls of another account are their own
        assert!(matches!(
            decide(&mut s, &ringing(3, 10), &[]),
            Plan::Ring { acc: 3, .. }
        ));
    }

    #[test]
    fn answer_only_where_the_server_offers_it() {
        let mut m = ringing(2, 100);
        m.as_object_mut().unwrap().remove("answer");
        assert!(matches!(
            decide(&mut State::default(), &m, &[]),
            Plan::Ring { answer: false, .. }
        ));
    }

    #[test]
    fn a_chat_shows_its_newest_message() {
        let mut s = State::default();
        let msg = |body: &str, ts: i64| json!({ "title": "Anna Rossi", "body": body, "acc": 1, "tag": "chat-1-Anna Rossi", "ts": ts });
        let on_screen = |text: &str, ts: i64| {
            vec![Shown {
                tag: "chat-1-Anna Rossi".into(),
                ts,
                text: text.into(),
            }]
        };
        assert_eq!(
            decide(&mut s, &msg("hello", 10), &[]),
            Plan::Message {
                acc: 1,
                tag: "chat-1-Anna Rossi".into(),
                title: "Anna Rossi".into(),
                body: "hello".into(),
                ts: 10,
                again: false
            }
        );
        // the same message pushed twice: shown again without alerting
        assert!(matches!(
            decide(&mut s, &msg("hello", 10), &on_screen("hello", 10)),
            Plan::Message { again: true, .. }
        ));
        // a newer message alerts
        assert!(matches!(
            decide(&mut s, &msg("there", 20), &on_screen("hello", 10)),
            Plan::Message {
                again: false,
                ts: 20,
                ..
            }
        ));
        // an older one, delivered late, leaves the newer one there
        assert!(matches!(
            decide(&mut s, &msg("hello", 10), &on_screen("there", 20)),
            Plan::None { .. }
        ));
        // a dismissed notification starts over
        assert!(matches!(
            decide(&mut s, &msg("hello", 10), &[]),
            Plan::Message { again: false, .. }
        ));
        // nothing of the chats kept
        assert_eq!(s, State::default());
    }

    #[test]
    fn the_rest_is_an_alert() {
        let m = json!({ "title": "", "body": "Teams signed out", "acc": 4 });
        assert_eq!(
            decide(&mut State::default(), &m, &[]),
            Plan::Alert {
                acc: 4,
                title: "TeamsRelay".into(),
                body: "Teams signed out".into()
            }
        );
        // only a chat tag makes a chat
        let m = json!({ "title": "Missed call", "body": "", "acc": 4, "tag": "call-4" });
        assert!(matches!(
            decide(&mut State::default(), &m, &[]),
            Plan::Alert { .. }
        ));
    }

    #[test]
    fn plan_opens_the_message_with_the_key_of_the_phone() {
        let store = Store::open(&dir("plan"));
        let data = DATA;
        assert!(
            matches!(saved(plan(&store, data, "[]")), Plan::None { ref why } if why.starts_with("no key"))
        );
        saved(store.update(|s| s.key = KEY.into()));
        assert_eq!(saved(plan(&store, data, "[]")), ringing_anna());
        // the call is kept: the same push again rings no more once the answer stopped it
        stop_ring(&store, 2, 1790000000000).unwrap();
        assert!(matches!(saved(plan(&store, data, "[]")), Plan::None { .. }));
        assert!(matches!(
            saved(plan(&store, r#"{"v":"2"}"#, "[]")),
            Plan::None { .. }
        ));
        saved(store.update(|s| s.key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()));
        assert!(
            matches!(saved(plan(&store, data, "[]")), Plan::None { ref why } if why.contains("another key"))
        );
    }

    #[test]
    fn a_call_rings_when_the_state_cannot_be_written() {
        // a folder that does not exist: a full disk fails the same way
        let store = Store::open(&dir("plan-unwritable").join("missing"));
        let _ = store.update(|s| s.key = KEY.into());
        let (p, saved) = plan(&store, DATA, "[]");
        assert_eq!(p, ringing_anna());
        assert!(saved.is_err());
    }

    // the message of seal.rs's test, sealed by the server code with key 1..32
    const KEY: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
    const DATA: &str = r#"{"v":"1","iv":"AAECAwQFBgcICQoL","ct":"ChJ1_ryxBCk1CfMvCvnX30bkzvxe9glcrikR0TW7VRmqitCPI_zbGxUHakzfRJUtAnCMgrK4PNikS7Wj4jEk55oPuWczek-E87mkFjhV-65Y6ag9GP2jMw4Zh3UA2L2qsu5CxFIj3la3iKMeKmEgzoCxJnbwC3602078X6uh"}"#;

    fn ringing_anna() -> Plan {
        Plan::Ring {
            acc: 2,
            title: "Anna Rossi is calling".into(),
            body: "Teams call, ringing now".into(),
            since: 1790000000000,
            answer: false,
        }
    }

    #[test]
    fn plans_read_as_the_platform_expects() {
        let p = Plan::Ring {
            acc: 2,
            title: "t".into(),
            body: "b".into(),
            since: 5,
            answer: true,
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"show":"ring","acc":2,"title":"t","body":"b","since":5,"answer":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Plan::None { why: "w".into() }).unwrap(),
            r#"{"show":"none","why":"w"}"#
        );
    }
}

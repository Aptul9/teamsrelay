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
        #[serde(skip_serializing_if = "Account::is_none")]
        account: Account,
    },
    Ended {
        acc: i64,
        title: String,
        body: String,
        since: i64,
        #[serde(skip_serializing_if = "Account::is_none")]
        account: Account,
    },
    // tag: the chat, per account; again: the text on screen already, shown without alerting
    Message {
        acc: i64,
        tag: String,
        title: String,
        body: String,
        ts: i64,
        again: bool,
        #[serde(skip_serializing_if = "Account::is_none")]
        account: Account,
    },
    Alert {
        acc: i64,
        title: String,
        body: String,
        #[serde(skip_serializing_if = "Account::is_none")]
        account: Account,
    },
    // nothing to show, and why
    None {
        why: String,
    },
}

// Which account a notification is for, drawn beside its title: the organization (org, which the server sends where the
// owner has more than one account), the logo of its company (a file of the server, "" without one) and, for a mark in
// place of a missing logo, the hue and the initials of the organization, as the web app tints and letters an avatar
// (app/src/components/Avatar.tsx, app/src/lib/client.ts)
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Account {
    pub org: String,
    pub logo: String,
    pub hue: u32,
    pub initials: String,
}

impl Account {
    fn is_none(&self) -> bool {
        self.org.is_empty() && self.logo.is_empty()
    }
}

pub fn account_of(m: &Value) -> Account {
    let org = m["org"].as_str().unwrap_or("").to_string();
    Account {
        logo: m["logo"].as_str().unwrap_or("").to_string(),
        hue: hue(&org),
        initials: initials(&org),
        org,
    }
}

pub fn hue(name: &str) -> u32 {
    name.encode_utf16()
        .fold(0u32, |h, c| h.wrapping_mul(31).wrapping_add(c.into()))
        % 360
}

// The first letter of the first two words, what stands in parentheses left out
pub fn initials(name: &str) -> String {
    let mut depth = 0;
    let bare: String = name
        .chars()
        .filter(|&c| match c {
            '(' => {
                depth += 1;
                false
            }
            ')' if depth > 0 => {
                depth -= 1;
                false
            }
            _ => depth == 0,
        })
        .collect();
    bare.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .take(2)
        .filter_map(|w| w.chars().next())
        .flat_map(char::to_uppercase)
        .collect()
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
    let account = account_of(m);
    let title = m["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or("TeamsRelay");
    // the name of the account off the title, which the server adds for the browsers: the platform draws it apart
    let title = match title.strip_suffix(&format!(" · {}", account.org)) {
        Some(t) if !account.org.is_empty() => t,
        _ => title,
    }
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
                account,
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
                account,
            }
        }
        _ => {
            let tag = m["tag"].as_str().unwrap_or("");
            if !tag.starts_with("chat-") {
                return Plan::Alert {
                    acc,
                    title,
                    body,
                    account,
                };
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
                account,
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
                answer: true,
                account: Account::default()
            }
        );
        assert_eq!(
            decide(&mut s, &ended(2, 100), &[]),
            Plan::Ended {
                acc: 2,
                title: "Call from Anna Rossi".into(),
                body: "Ended after 9 s".into(),
                since: 100,
                account: Account::default()
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
                again: false,
                account: Account::default()
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
                body: "Teams signed out".into(),
                account: Account::default()
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
    fn a_notification_names_its_account() {
        let m = json!({ "title": "Anna Rossi · Npo Torino Srl", "body": "hello", "acc": 2, "tag": "chat-2-Anna Rossi", "ts": 10, "org": "Npo Torino Srl", "logo": "0123456789abcdef.png" });
        assert_eq!(
            decide(&mut State::default(), &m, &[]),
            Plan::Message {
                acc: 2,
                tag: "chat-2-Anna Rossi".into(),
                title: "Anna Rossi".into(),
                body: "hello".into(),
                ts: 10,
                again: false,
                account: Account {
                    org: "Npo Torino Srl".into(),
                    logo: "0123456789abcdef.png".into(),
                    hue: 171,
                    initials: "NT".into()
                }
            }
        );
        // the logo where the owner has a single account: no name of the account on the title
        let ring = json!({ "title": "Marco Bianchi is calling", "body": "Teams call, ringing now", "acc": 4, "call": "ringing", "ts": 100, "logo": "fedcba9876543210.png" });
        assert!(matches!(
            decide(&mut State::default(), &ring, &[]),
            Plan::Ring { ref title, ref account, .. }
                if title == "Marco Bianchi is calling" && account.logo == "fedcba9876543210.png" && account.org.is_empty()
        ));
        // a title that does not end with the account keeps all of it
        let alert = json!({ "title": "Teams signed out", "body": "", "acc": 4, "org": "Tesco" });
        assert!(matches!(
            decide(&mut State::default(), &alert, &[]),
            Plan::Alert { ref title, .. } if title == "Teams signed out"
        ));
    }

    #[test]
    fn an_account_without_logo_gets_a_mark_tinted_and_lettered_as_in_the_web_app() {
        // app/src/components/Avatar.tsx hue(), app/src/lib/client.ts initials()
        assert_eq!(
            account_of(&json!({ "org": "MSC Cruises SA" })),
            Account {
                org: "MSC Cruises SA".into(),
                logo: "".into(),
                hue: 131,
                initials: "MC".into()
            }
        );
        assert_eq!((hue("Tesco"), initials("Tesco")), (30, "T".into()));
        assert_eq!(
            (hue("Zurich Insurance"), initials("Zurich Insurance")),
            (281, "ZI".into())
        );
        assert_eq!(
            (hue("Contoso (EU), Ltd"), initials("Contoso (EU), Ltd")),
            (176, "CL".into())
        );
        assert_eq!(
            (hue("Società Ü"), initials("Società Ü")),
            (347, "SÜ".into())
        );
        assert_eq!(account_of(&json!({})), Account::default());
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
            account: Account::default(),
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
            account: Account::default(),
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"show":"ring","acc":2,"title":"t","body":"b","since":5,"answer":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Plan::None { why: "w".into() }).unwrap(),
            r#"{"show":"none","why":"w"}"#
        );
        // the account only where there is one to draw
        let p = Plan::Alert {
            acc: 4,
            title: "t".into(),
            body: "b".into(),
            account: account_of(&json!({ "org": "Tesco", "logo": "fedcba9876543210.png" })),
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"show":"alert","acc":4,"title":"t","body":"b","account":{"org":"Tesco","logo":"fedcba9876543210.png","hue":30,"initials":"T"}}"#
        );
    }
}

// The requests the app makes to its TeamsRelay server, as its web page would make them: the Origin of the server and
// the cookies of the page's session. The server sends to this phone once it knows its Firebase token and whose phone
// it is: sync posts the token with the session cookie (POST /api/push/fcm), and the server answers the key of the
// phone. Without a session there (signed out, or a session the server ended: signed out elsewhere, password changed)
// the server forgets the phone (DELETE /api/push/fcm, the token is the proof).
use std::{sync::Mutex, time::Duration};

use serde_json::{json, Value};

use crate::store::Store;

const TIMEOUT: Duration = Duration::from_secs(15);

// One registration at a time: two answers coming back in another order than they were asked in would leave the state
// of the older one
static SYNC: Mutex<()> = Mutex::new(());

#[derive(Debug, PartialEq)]
pub enum Synced {
    // the server knows the phone, and its key is kept
    Registered,
    // the server forgot the phone, its token and key went
    Forgotten,
    // signed out, and no token known to the server: nothing to do
    SignedOut,
    // the app changed server meanwhile, or names none: nothing done for this one
    Moved,
}

// The session cookie of the web page among the cookies of the server ("" without one): Better Auth names it
// better-auth.session_token (__Secure-better-auth.session_token over https). A sign-in after the server ended the
// session gives a new value under the same name.
pub fn session_of(cookies: &str) -> &str {
    cookies
        .split(';')
        .map(str::trim)
        .find(|c| {
            c.split('=')
                .next()
                .is_some_and(|name| name.ends_with("session_token"))
        })
        .unwrap_or("")
}

// origin: the server whose cookies these are, the one in use when the platform read them
pub fn sync(
    store: &Store,
    origin: &str,
    token: &str,
    cookies: &str,
    name: &str,
) -> Result<Synced, String> {
    let _one = SYNC.lock().unwrap_or_else(|e| e.into_inner());
    let state = store.get();
    if origin.is_empty() || state.relay != origin {
        return Ok(Synced::Moved);
    }
    if session_of(cookies).is_empty() {
        if state.token.is_empty() {
            return Ok(Synced::SignedOut);
        }
        return forget(store, origin, &state.token).map(|_| Synced::Forgotten);
    }
    let (status, body) = call(
        "POST",
        origin,
        "/api/push/fcm",
        cookies,
        &json!({ "token": token, "name": name }),
    )?;
    match status {
        200 => {
            let key = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["key"].as_str().map(String::from))
                .ok_or("registration: no key in the answer")?;
            let (kept, saved) = store.update(|s| {
                // the app changed server during the request: this answer belongs to the previous one
                if s.relay != origin {
                    return false;
                }
                s.key = key;
                s.token = token.to_string();
                true
            });
            saved?;
            Ok(if kept {
                Synced::Registered
            } else {
                Synced::Moved
            })
        }
        // a session the server ended: as signed out, with the token the server knows (Firebase may have handed a new
        // one since)
        401 | 403 => {
            let known = if state.token.is_empty() {
                token
            } else {
                &state.token
            };
            forget(store, origin, known).map(|_| Synced::Forgotten)
        }
        _ => Err(format!("registration refused by the server: HTTP {status}")),
    }
}

// The server forgets this phone, and its token and key go: what it may still send is not opened. A previous server
// (the app changed server) is asked too; the token and key then are the next server's, and stay.
pub fn forget(store: &Store, origin: &str, token: &str) -> Result<(), String> {
    let (status, _) = call(
        "DELETE",
        origin,
        "/api/push/fcm",
        "",
        &json!({ "token": token }),
    )?;
    if status != 200 {
        return Err(format!("{origin} did not forget the phone: HTTP {status}"));
    }
    store
        .update(|s| {
            if s.relay == origin {
                s.token.clear();
                s.key.clear();
            }
        })
        .1
}

// Answer on the notification of a ringing call, as Answer on the notification of the web app (app/public/sw.js): the
// server queues the answer of that call (since: when it started ringing, ms) and its agent clicks Accept in Teams. Ok:
// the server took it, the call still rings there and the session is the owner's.
pub fn answer(origin: &str, cookies: &str, acc: i64, since: i64) -> Result<(), String> {
    if origin.is_empty() || acc <= 0 || since <= 0 {
        return Err("no call to answer".into());
    }
    let (status, body) = call(
        "POST",
        origin,
        &format!("/api/call/answer?a={acc}"),
        cookies,
        &json!({ "since": since }),
    )?;
    if status != 200 {
        return Err(format!(
            "answer refused by the server: HTTP {status} {body}"
        ));
    }
    Ok(())
}

// A request to the server with a JSON body: its status and the text of its answer, any status. No redirect is
// followed: only the route itself answers, a redirect to a sign-in page is no 200.
fn call(
    method: &str,
    origin: &str,
    path: &str,
    cookies: &str,
    body: &Value,
) -> Result<(u16, String), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into();
    let url = format!("{origin}{path}");
    let request = match method {
        "POST" => agent.post(&url),
        // a body on DELETE: the token that proves the phone
        _ => agent.delete(&url).force_send_body(),
    };
    let mut request = request
        .header("Content-Type", "application/json")
        .header("Origin", origin);
    if !cookies.is_empty() {
        request = request.header("Cookie", cookies);
    }
    let mut response = request
        .send(body.to_string())
        .map_err(|e| format!("{origin} not reached: {e}"))?;
    let status = response.status().as_u16();
    Ok((
        status,
        response.body_mut().read_to_string().unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::mpsc,
        thread,
    };

    use super::*;
    use crate::store::tests::{dir, saved};

    // A request the stand-in server got: request line, headers in lower case, body
    #[derive(Debug)]
    struct Got {
        line: String,
        headers: Vec<(String, String)>,
        body: String,
    }

    impl Got {
        fn header(&self, name: &str) -> &str {
            self.headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
                .unwrap_or("")
        }
    }

    // A stand-in for the TeamsRelay server on a free port of this computer: it answers each request with the next
    // (status, body), and hands over what it got
    fn server(answers: Vec<(u16, &'static str)>) -> (String, mpsc::Receiver<Got>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for (status, answer) in answers {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut headers = Vec::new();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let (n, v) = h.split_once(':').unwrap();
                    headers.push((n.trim().to_ascii_lowercase(), v.trim().to_string()));
                }
                let length = headers
                    .iter()
                    .find(|(n, _)| n == "content-length")
                    .map(|(_, v)| v.parse().unwrap())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let mut stream = stream;
                // a redirect goes to another route of this same stand-in
                let location = if (300..400).contains(&status) {
                    "Location: /moved\r\n"
                } else {
                    ""
                };
                write!(stream, "HTTP/1.1 {status} X\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}", answer.len()).unwrap();
                tx.send(Got {
                    line: line.trim_end().to_string(),
                    headers,
                    body: String::from_utf8(body).unwrap(),
                })
                .unwrap();
            }
        });
        (origin, rx)
    }

    const SIGNED_IN: &str = "theme=dark; better-auth.session_token=abc.def";

    #[test]
    fn finds_the_session_cookie() {
        assert_eq!(session_of(SIGNED_IN), "better-auth.session_token=abc.def");
        assert_eq!(
            session_of("__Secure-better-auth.session_token=x; a=b"),
            "__Secure-better-auth.session_token=x"
        );
        assert_eq!(session_of("better-auth.session_data=x; a=b"), "");
        assert_eq!(session_of(""), "");
    }

    #[test]
    fn signed_in_registers_the_phone_and_keeps_its_key() {
        let (origin, got) = server(vec![(200, r#"{"key":"KEY"}"#)]);
        let store = Store::open(&dir("register"));
        saved(store.use_relay(&origin));
        assert_eq!(
            sync(&store, &origin, "tok123", SIGNED_IN, "Google Pixel 6").unwrap(),
            Synced::Registered
        );
        let r = got.recv().unwrap();
        assert_eq!(r.line, "POST /api/push/fcm HTTP/1.1");
        assert_eq!(r.header("cookie"), SIGNED_IN);
        assert_eq!(r.header("origin"), origin);
        assert_eq!(r.header("content-type"), "application/json");
        assert_eq!(
            serde_json::from_str::<Value>(&r.body).unwrap(),
            json!({ "token": "tok123", "name": "Google Pixel 6" })
        );
        let s = store.get();
        assert_eq!((s.token.as_str(), s.key.as_str()), ("tok123", "KEY"));
    }

    #[test]
    fn signed_out_has_the_server_forget_the_phone() {
        let (origin, got) = server(vec![(200, r#"{"ok":true}"#)]);
        let store = Store::open(&dir("signed-out"));
        saved(store.use_relay(&origin));
        saved(store.update(|s| (s.token, s.key) = ("old".into(), "KEY".into())));
        assert_eq!(
            sync(&store, &origin, "tok123", "theme=dark", "phone").unwrap(),
            Synced::Forgotten
        );
        let r = got.recv().unwrap();
        assert_eq!(r.line, "DELETE /api/push/fcm HTTP/1.1");
        assert_eq!(r.header("cookie"), "");
        assert_eq!(
            serde_json::from_str::<Value>(&r.body).unwrap(),
            json!({ "token": "old" })
        );
        let s = store.get();
        assert_eq!((s.token.as_str(), s.key.as_str()), ("", ""));
        // signed out with nothing known to the server: no request
        assert_eq!(
            sync(&store, &origin, "tok123", "", "phone").unwrap(),
            Synced::SignedOut
        );
    }

    #[test]
    fn a_session_the_server_ended_counts_as_signed_out() {
        let (origin, got) = server(vec![
            (401, r#"{"error":"Sign in"}"#),
            (200, r#"{"ok":true}"#),
        ]);
        let store = Store::open(&dir("ended"));
        saved(store.use_relay(&origin));
        saved(store.update(|s| (s.token, s.key) = ("old".into(), "KEY".into())));
        // Firebase handed a new token since the registration: the server is asked to forget the one it knows
        assert_eq!(
            sync(&store, &origin, "new", SIGNED_IN, "phone").unwrap(),
            Synced::Forgotten
        );
        assert_eq!(got.recv().unwrap().line, "POST /api/push/fcm HTTP/1.1");
        let r = got.recv().unwrap();
        assert_eq!(r.line, "DELETE /api/push/fcm HTTP/1.1");
        assert_eq!(
            serde_json::from_str::<Value>(&r.body).unwrap(),
            json!({ "token": "old" })
        );
        assert_eq!(store.get().key, "");
    }

    #[test]
    fn a_redirect_is_no_answer_of_the_route() {
        // without its own answer the route would hand over the 200 of the page it redirects to
        let (origin, got) = server(vec![(302, ""), (200, r#"{"ok":true}"#)]);
        assert!(answer(&origin, SIGNED_IN, 2, 5)
            .unwrap_err()
            .contains("HTTP 302"));
        assert_eq!(
            got.recv().unwrap().line,
            "POST /api/call/answer?a=2 HTTP/1.1"
        );
        assert!(got
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err());
    }

    #[test]
    fn nothing_for_a_server_no_longer_in_use() {
        let store = Store::open(&dir("moved"));
        saved(store.use_relay("https://now.example.com"));
        // no server listens there: a request would fail
        assert_eq!(
            sync(&store, "http://127.0.0.1:9", "tok", SIGNED_IN, "phone").unwrap(),
            Synced::Moved
        );
        assert_eq!(
            sync(&store, "", "tok", SIGNED_IN, "phone").unwrap(),
            Synced::Moved
        );
    }

    #[test]
    fn a_refused_registration_keeps_what_was_known() {
        let (origin, _got) = server(vec![(500, "{}")]);
        let store = Store::open(&dir("refused"));
        saved(store.use_relay(&origin));
        saved(store.update(|s| (s.token, s.key) = ("tok".into(), "KEY".into())));
        assert_eq!(
            sync(&store, &origin, "tok", SIGNED_IN, "phone").unwrap_err(),
            "registration refused by the server: HTTP 500"
        );
        assert_eq!(store.get().key, "KEY");
    }

    #[test]
    fn the_previous_server_forgets_the_phone_and_the_new_one_keeps_its_state() {
        let (origin, got) = server(vec![(200, r#"{"ok":true}"#)]);
        let store = Store::open(&dir("previous"));
        saved(store.use_relay(&origin));
        saved(store.update(|s| (s.token, s.key) = ("tok".into(), "KEY".into())));
        let (previous, token) = saved(store.use_relay("https://next.example.com")).unwrap();
        saved(store.update(|s| s.key = "NEXT".into()));
        forget(&store, &previous, &token).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&got.recv().unwrap().body).unwrap(),
            json!({ "token": "tok" })
        );
        assert_eq!(store.get().key, "NEXT");
    }

    #[test]
    fn answers_a_ringing_call_with_the_session_of_the_page() {
        let (origin, got) = server(vec![
            (200, r#"{"ok":true,"id":7,"desktop":"/api/desktop/2"}"#),
            (409, r#"{"error":"Call no longer ringing"}"#),
        ]);
        answer(&origin, SIGNED_IN, 2, 1790000000000).unwrap();
        let r = got.recv().unwrap();
        assert_eq!(r.line, "POST /api/call/answer?a=2 HTTP/1.1");
        assert_eq!(r.header("cookie"), SIGNED_IN);
        assert_eq!(
            serde_json::from_str::<Value>(&r.body).unwrap(),
            json!({ "since": 1790000000000_i64 })
        );
        assert!(answer(&origin, SIGNED_IN, 2, 1790000000000)
            .unwrap_err()
            .contains("HTTP 409"));
        assert!(answer(&origin, SIGNED_IN, 0, 1).is_err());
    }

    #[test]
    fn a_server_out_of_reach_is_an_error() {
        assert!(answer("http://127.0.0.1:9", SIGNED_IN, 2, 5)
            .unwrap_err()
            .contains("not reached"));
    }
}

// The functions the Kotlin of android/ calls (Core.kt): the shared Rust of the app (teamsrelay-core) with what only
// Android has handed in, the Firebase token, the cookies of the WebView, the notifications on screen. They live in the
// library of the app (libteamsrelay_mobile_lib.so), which Core.kt also loads when Firebase starts the push service with
// no window. Nothing here may panic: a panic ends the app (panic = "abort" in release).
use std::{
    ffi::{c_char, c_int, CString},
    path::Path,
    sync::OnceLock,
    thread,
};

use jni::{
    objects::{JClass, JString},
    sys::{jboolean, jint, jlong, jstring, JNI_FALSE, JNI_TRUE},
    JNIEnv,
};
use teamsrelay_core::{notice, server, store::Store};

static STORE: OnceLock<Store> = OnceLock::new();

const INFO: c_int = 4;
const WARN: c_int = 5;

#[link(name = "log")]
extern "C" {
    fn __android_log_write(prio: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

// To logcat, under the tag of the Kotlin side
fn log(prio: c_int, text: &str) {
    if let Ok(text) = CString::new(text) {
        unsafe { __android_log_write(prio, c"TeamsRelay".as_ptr(), text.as_ptr()) };
    }
}

fn store() -> Option<&'static Store> {
    let s = STORE.get();
    if s.is_none() {
        log(WARN, "Core.init not called: nothing kept");
    }
    s
}

fn text(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(Into::into).unwrap_or_default()
}

fn jtext(env: &mut JNIEnv, s: &str) -> jstring {
    env.new_string(s)
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

// dir: noBackupFilesDir of the app, read once per process
#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_init(
    mut env: JNIEnv,
    _: JClass,
    dir: JString,
) {
    let dir = text(&mut env, &dir);
    STORE.get_or_init(|| Store::open(Path::new(&dir)));
}

// The origin of the server in use, "" before the start page named one
#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_relay(
    mut env: JNIEnv,
    _: JClass,
) -> jstring {
    let relay = store().map(|s| s.get().relay).unwrap_or_default();
    jtext(&mut env, &relay)
}

// The server the start page opens. Another one than before: the previous one forgets this phone, in the background (a
// server that does not answer keeps sending, and what it sends no longer opens here).
#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_useRelay(
    mut env: JNIEnv,
    _: JClass,
    origin: JString,
) {
    let origin = text(&mut env, &origin);
    let Some(store) = store() else { return };
    match store.use_relay(&origin) {
        Ok(Some((previous, token))) => {
            thread::spawn(move || {
                if let Err(e) = server::forget(store, &previous, &token) {
                    log(WARN, &format!("previous server: {e}"));
                }
            });
        }
        Ok(None) => {}
        Err(e) => log(WARN, &e),
    }
}

#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_session(
    mut env: JNIEnv,
    _: JClass,
    cookies: JString,
) -> jstring {
    let cookies = text(&mut env, &cookies);
    jtext(&mut env, server::session_of(&cookies))
}

// Registers the phone with the server, or has it forgotten when signed out: blocks while the server answers
#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_sync(
    mut env: JNIEnv,
    _: JClass,
    origin: JString,
    token: JString,
    cookies: JString,
    name: JString,
) {
    let (origin, token, cookies, name) = (
        text(&mut env, &origin),
        text(&mut env, &token),
        text(&mut env, &cookies),
        text(&mut env, &name),
    );
    let Some(store) = store() else { return };
    match server::sync(store, &origin, &token, &cookies, &name) {
        Ok(done) => log(INFO, &format!("registration: {done:?}")),
        Err(e) => log(WARN, &e),
    }
}

// What a push message shows (notice::Plan as JSON): data, the data of the Firebase message; shown, the notifications of
// the app on screen
#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_notice(
    mut env: JNIEnv,
    _: JClass,
    data: JString,
    shown: JString,
) -> jstring {
    let (data, shown) = (text(&mut env, &data), text(&mut env, &shown));
    let plan = match store() {
        Some(store) => notice::plan(store, &data, &shown),
        None => notice::Plan::None {
            why: "no store".into(),
        },
    };
    let json = serde_json::to_string(&plan).unwrap_or_else(|_| r#"{"show":"none"}"#.into());
    jtext(&mut env, &json)
}

#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_stopRing(
    _: JNIEnv,
    _: JClass,
    acc: jint,
    since: jlong,
) {
    if let Some(Err(e)) = store().map(|s| notice::stop_ring(s, acc.into(), since)) {
        log(WARN, &e);
    }
}

// Answer on the notification of a ringing call: whether the server took it. Blocks while the server answers.
#[no_mangle]
pub extern "system" fn Java_io_github_aptul9_teamsrelay_push_Core_answer(
    mut env: JNIEnv,
    _: JClass,
    origin: JString,
    cookies: JString,
    acc: jint,
    since: jlong,
) -> jboolean {
    let (origin, cookies) = (text(&mut env, &origin), text(&mut env, &cookies));
    match server::answer(&origin, &cookies, acc.into(), since) {
        Ok(()) => JNI_TRUE,
        Err(e) => {
            log(WARN, &e);
            JNI_FALSE
        }
    }
}

// What every build of the TeamsRelay app shares, with no platform code: the requests to the TeamsRelay server
// (server), what the app keeps (store), and the messages the server sends, opened (seal) and turned into what a
// notification shows (notice). The platform side gives it what only the platform has (on Android: the Firebase token,
// the cookies of the WebView, the notifications on screen) and draws what it decides (../plugin).
pub mod notice;
pub mod seal;
pub mod server;
pub mod store;

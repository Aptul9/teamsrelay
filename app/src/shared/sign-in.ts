// One press of Sign in after a sign-out (src/agent/jobs/sign-in.ts): seconds signed out before it (a start of Teams
// passes through the sign-in hosts for a few seconds and goes on by itself), seconds it has to bring Teams back before
// the owner is told, seconds between two attempts whatever happens (a session that signs in and out again cannot make
// a loop). The check of an account checked every N hours waits longer than the first two together (src/lib/checks.ts).
export const SIGN_IN_TRY_AFTER = 15;
export const SIGN_IN_TRY_WAIT = 60;
export const SIGN_IN_TRY_EVERY = 1800;

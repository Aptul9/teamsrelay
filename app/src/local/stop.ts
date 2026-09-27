import { errorText, log } from "@/agent/log";

// Stops on SIGINT, SIGTERM and the shutdown message of pm2 (Windows has no signals to send): the browser is closed
// so that it writes its profile out. An error nothing caught stops it the same way, logged, with exit code 1: pm2
// starts it again, and the browser does not stay behind holding the profile.
export function onStop(stop: () => Promise<void>, exit: (code: number) => void = (code) => process.exit(code)) {
  let stopping = false;
  const handler = (code: number) => {
    if (stopping) return;
    stopping = true;
    log.info("relay", "stopping");
    const force = setTimeout(() => exit(code), 10_000);
    force.unref();
    stop()
      .catch((e: unknown) => log.warn("relay", `stop: ${errorText(e)}`))
      .finally(() => exit(code));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => handler(0));
  process.on("message", (m) => m === "shutdown" && handler(0));
  process.on("uncaughtException", (e) => {
    log.warn("relay", `uncaught error: ${errorText(e)}`);
    handler(1);
  });
  process.on("unhandledRejection", (e) => {
    log.warn("relay", `unhandled rejection: ${errorText(e)}`);
    handler(1);
  });
}

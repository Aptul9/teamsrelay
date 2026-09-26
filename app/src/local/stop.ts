import { log } from "@/agent/log";

// Stops on SIGINT, SIGTERM and the shutdown message of pm2 (Windows has no signals to send): the browser is closed
// so that it writes its profile out
export function onStop(stop: () => Promise<void>, exit: (code: number) => void = (code) => process.exit(code)) {
  let stopping = false;
  const handler = () => {
    if (stopping) return;
    stopping = true;
    log.info("relay", "stopping");
    const force = setTimeout(() => exit(0), 10_000);
    force.unref();
    stop().finally(() => exit(0));
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, handler);
  process.on("message", (m) => m === "shutdown" && handler());
}

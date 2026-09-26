import type { ProcessLike } from "@/supervisor/accounts";

// Stand-in for a supervised process: records the calls, "stop" can take its time
export function fakeProcess(name: string, calls: string[], stopMs = 0): ProcessLike {
  let wanted = false;
  return {
    name,
    restarts: 0,
    lastExit: null,
    get running() {
      return wanted;
    },
    get active() {
      return wanted;
    },
    get pid() {
      return wanted ? 4242 : null;
    },
    start() {
      calls.push(`start ${name}`);
      wanted = true;
    },
    async stop() {
      calls.push(`stop ${name}`);
      await new Promise((r) => setTimeout(r, stopMs));
      wanted = false;
    },
  };
}

// Path for a test server socket: a named pipe on Windows, a file elsewhere
export function socketPath(dir: string) {
  return process.platform === "win32" ? `\\\\?\\pipe\\teamsrelay-test-${process.pid}-${Math.random().toString(36).slice(2)}` : `${dir}/control.sock`;
}

import http from "node:http";
import { config } from "./config";
import { HttpError } from "./http";

// The supervisor of the browsers container runs the browser and the agent of every account. The web app
// reaches it only through its unix socket, in the volume shared by the two containers: no Docker access.
export interface ControlClient {
  start(n: number): Promise<void>;
  stop(n: number): Promise<void>;
  // empties the browser profile (the Microsoft session) of a stopped account
  wipe(n: number): Promise<void>;
  // brings the window of the account to the front of the remote desktop
  show(n: number): Promise<boolean>;
}

type Action = "start" | "stop" | "wipe" | "show";

const VERB: Record<Action, string> = { start: "Start", stop: "Stop", wipe: "Wipe", show: "Show" };

export function controlClient(socket = config.controlSocket): ControlClient {
  function post(action: Action, n: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, method: "POST", path: `/accounts/${n}/${action}`, timeout: 40_000 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(body);
          reject(new HttpError(502, `${VERB[action]} of account ${n} failed: ${detail(body) ?? `status ${status}`}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("no answer within 40 s")));
      req.on("error", (e) => reject(new HttpError(503, `Browsers container not reachable: ${e.message}`)));
      req.end();
    });
  }

  return {
    start: async (n) => void (await post("start", n)),
    stop: async (n) => void (await post("stop", n)),
    wipe: async (n) => void (await post("wipe", n)),
    show: async (n) => (JSON.parse((await post("show", n)) || "{}") as { shown?: boolean }).shown === true,
  };
}

function detail(body: string): string | null {
  try {
    const d = (JSON.parse(body) as { detail?: unknown }).detail;
    return typeof d === "string" ? d : null;
  } catch {
    return null;
  }
}

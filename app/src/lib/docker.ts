import { config } from "./config";
import { HttpError } from "./http";

// Docker is reached only through the socket proxy, which allows nothing but start and stop of the
// slot containers and start and wait of their wipe containers (see docker-compose.yml).
export interface DockerClient {
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  // exit code of the container, once it is not running
  wait(name: string): Promise<number>;
}

export function dockerClient(api = config.dockerApi): DockerClient {
  async function post(action: "start" | "stop" | "wait", name: string) {
    if (!api) throw new HttpError(503, "Docker control not configured (DOCKER_API)");
    const url = `${api}/containers/${encodeURIComponent(name)}/${action}${action === "stop" ? "?t=10" : ""}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(40_000) });
    } catch (e) {
      throw new HttpError(502, `Docker unreachable: ${(e as Error).message}`);
    }
    if (res.ok || res.status === 304) return res; // 304: already running / already stopped
    if (res.status === 404) throw new HttpError(503, `Container ${name} does not exist: deploy again`);
    throw new HttpError(502, `Docker: ${action} ${name} failed (${res.status})`);
  }
  // 200 whatever the exit: the exit code is in the body
  async function wait(name: string) {
    let out: { StatusCode?: unknown; Error?: { Message?: string } | null };
    try {
      out = await (await post("wait", name)).json();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `Docker: wait ${name} failed: ${(e as Error).message}`);
    }
    if (typeof out.StatusCode !== "number" || out.Error?.Message) {
      throw new HttpError(502, `Docker: wait ${name} failed: ${out.Error?.Message || "no exit code"}`);
    }
    return out.StatusCode;
  }
  return {
    start: async (n) => void (await post("start", n)),
    stop: async (n) => void (await post("stop", n)),
    wait,
  };
}

import { config } from "./config";
import { HttpError } from "./http";

// Docker is reached only through the socket proxy, which allows nothing but start and stop
// of the slot containers (see docker-compose.yml).
export interface DockerClient {
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
}

export function dockerClient(api = config.dockerApi): DockerClient {
  async function post(action: "start" | "stop", name: string) {
    if (!api) throw new HttpError(503, "Docker control not configured (DOCKER_API)");
    const url = `${api}/containers/${encodeURIComponent(name)}/${action}${action === "stop" ? "?t=10" : ""}`;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(40_000) });
    } catch (e) {
      throw new HttpError(502, `Docker unreachable: ${(e as Error).message}`);
    }
    if (res.ok || res.status === 304) return; // 304: already running / already stopped
    if (res.status === 404) throw new HttpError(503, `Container ${name} does not exist: deploy again`);
    throw new HttpError(502, `Docker: ${action} ${name} failed (${res.status})`);
  }
  return { start: (n) => post("start", n), stop: (n) => post("stop", n) };
}

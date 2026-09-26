import fs from "node:fs";
import { Readable } from "node:stream";
import { HttpError } from "./http";

// Files written by the agent (images of messages, profile pictures, downloaded attachments)
export function fileResponse(file: string, headers: Record<string, string>): Response {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    throw new HttpError(404, "Not found");
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: { "Content-Length": String(size), "X-Content-Type-Options": "nosniff", ...headers },
  });
}

export function attachmentName(name: string | null): string {
  return (name ?? "").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 150) || "file";
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

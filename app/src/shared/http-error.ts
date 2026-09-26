// An answer other than 200 with its reason, {"detail": "..."} on the wire: thrown by the handlers of the web app
// (src/lib/http.ts) and of the API of the local relay (src/local/server.ts)
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

import { requestUrl } from "obsidian";
import { toArrayBuffer } from "../util/bytes";
import { withTimeout, type HttpClient, type HttpRequest, type HttpResponse } from "../net/HttpClient";

/** HttpClient over Obsidian's requestUrl (desktop + mobile, not subject to CORS). */
export class ObsidianHttpClient implements HttpClient {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const body = request.body;
    const contentType = request.contentType ?? (typeof body === "string" ? "application/json" : "application/octet-stream");
    const response = await withTimeout(
      requestUrl({
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        ...(body !== undefined ? { body: typeof body === "string" ? body : toArrayBuffer(body), contentType } : {}),
        throw: false,
      }),
      request.timeoutMs,
    );
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = String(value);
    return { status: response.status, headers, body: request.method === "HEAD" ? new Uint8Array(0) : new Uint8Array(response.arrayBuffer) };
  }
}

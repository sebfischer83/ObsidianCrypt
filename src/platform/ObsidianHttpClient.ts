import { requestUrl } from "obsidian";
import { withTimeout, type HttpClient, type HttpRequest, type HttpResponse } from "../github/HttpClient";

/** HttpClient over Obsidian's requestUrl (desktop + mobile, not subject to CORS). */
export class ObsidianHttpClient implements HttpClient {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await withTimeout(
      requestUrl({
        url: request.url,
        method: request.method,
        headers: { ...request.headers },
        ...(request.body !== undefined ? { body: request.body, contentType: "application/json" } : {}),
        throw: false,
      }),
      request.timeoutMs,
    );
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = String(value);
    return { status: response.status, headers, body: new Uint8Array(response.arrayBuffer) };
  }
}

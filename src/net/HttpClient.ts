import { utf8Decode } from "../util/bytes";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE" | "PROPFIND" | "MKCOL";

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Text (JSON, XML) or binary body. */
  readonly body?: string | Uint8Array;
  /** Content type of the body; defaults to application/json for text bodies. */
  readonly contentType?: string;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Header names in lower case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * Transport abstraction shared by all backends. Production: Obsidian `requestUrl` (works on desktop and mobile,
 * no CORS).
 * Implementations must throw a plain Error only for transport failures (offline, DNS, timeout) and
 * return every HTTP status (including 4xx/5xx) as a response.
 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class HttpTimeoutError extends Error {
  constructor() {
    super("HTTP request timed out");
    this.name = "HttpTimeoutError";
  }
}

export function responseText(response: HttpResponse): string {
  return utf8Decode(response.body);
}

export function responseJson(response: HttpResponse): unknown {
  return JSON.parse(responseText(response));
}

/** Races a promise against a timeout (the underlying request can not always be aborted). */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HttpTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("HTTP transport error"));
      },
    );
  });
}

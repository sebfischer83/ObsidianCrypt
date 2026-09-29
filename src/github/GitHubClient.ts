import { RemoteError, type RemoteErrorCategory } from "../errors/RemoteError";
import { silentLogger, type Logger } from "../util/Logger";
import type { AuthProvider } from "./GitHubAuth";
import { responseJson, type HttpClient, type HttpRequest, type HttpResponse } from "../net/HttpClient";

export interface GitHubClientOptions {
  readonly http: HttpClient;
  readonly auth: AuthProvider;
  readonly baseUrl?: string;
  readonly maxRetries?: number;
  /** Base timeout per request; large uploads get additional time proportional to their size. */
  readonly timeoutMs?: number;
  /** Longest wait the client accepts for a rate limit before giving up (the scheduler retries later). */
  readonly maxRateLimitWaitMs?: number;
  /** Minimum spacing of content-creating requests (GitHub secondary rate limit: ~80/min). */
  readonly minWriteIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly logger?: Logger;
}

export interface RequestOptions {
  readonly body?: unknown;
  /** Accept header; default JSON. */
  readonly accept?: string;
  /** Status codes treated as success without throwing (e.g. 404 for "optional" reads). */
  readonly allow?: readonly number[];
  /** Whether a retry after a transport error is safe (idempotent or verified by the caller). */
  readonly retryable?: boolean;
}

const API_VERSION = "2022-11-28";
const BACKOFF_CAP_MS = 60_000;

/**
 * Minimal GitHub REST client: authentication, JSON, exponential backoff (1s, 2s, 4s, … capped),
 * rate-limit handling and error classification. Never includes the token, URLs with secrets or
 * response bodies in errors or logs.
 */
export class GitHubClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly minWriteIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: Logger;
  private lastWriteAt = 0;
  /** Epoch ms until which the primary rate limit is exhausted. */
  private rateLimitedUntil = 0;

  constructor(private readonly o: GitHubClientOptions) {
    this.baseUrl = (o.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.maxRetries = o.maxRetries ?? 5;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.maxRateLimitWaitMs = o.maxRateLimitWaitMs ?? 60_000;
    this.minWriteIntervalMs = o.minWriteIntervalMs ?? 1_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = o.now ?? (() => Date.now());
    this.random = o.random ?? Math.random;
    this.log = o.logger ?? silentLogger;
  }

  async json<T = unknown>(method: HttpRequest["method"], path: string, options: RequestOptions = {}): Promise<{ status: number; data: T }> {
    const response = await this.send(method, path, options);
    if (response.body.length === 0) return { status: response.status, data: null as T };
    try {
      return { status: response.status, data: responseJson(response) as T };
    } catch (error: unknown) {
      throw new RemoteError("InvalidResponse", response.status, null, { cause: error });
    }
  }

  async raw(path: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.send("GET", path, { ...options, accept: options.accept ?? "application/vnd.github.raw+json" });
  }

  async send(method: HttpRequest["method"], path: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const isWrite = method !== "GET";
    const retryable = options.retryable ?? !isWrite;
    const timeoutMs = this.timeoutMs + Math.ceil((body?.length ?? 0) / 100_000) * 1000;

    for (let attempt = 0; ; attempt++) {
      await this.respectRateLimit();
      if (isWrite) await this.spaceWrites();
      const headers: Record<string, string> = {
        Accept: options.accept ?? "application/vnd.github+json",
        Authorization: await this.o.auth.authorizationHeader(),
        "X-GitHub-Api-Version": API_VERSION,
        // GitHub sends "Cache-Control: max-age=60"; a cached branch ref would look like a rollback.
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";

      let response: HttpResponse;
      try {
        response = await this.o.http.request({ method, url: `${this.baseUrl}${path}`, headers, ...(body !== undefined ? { body } : {}), timeoutMs });
      } catch (error: unknown) {
        if (retryable && attempt < this.maxRetries) {
          this.log.debug("network error, retrying", { attempt });
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new RemoteError("Network", null, null, { cause: error instanceof Error ? new Error(error.name) : undefined });
      }

      this.trackRateLimit(response);
      if ((response.status >= 200 && response.status < 300) || options.allow?.includes(response.status)) return response;

      const category = classify(response);
      const retryAfter = this.retryAfterMs(response);
      if (category === "RateLimit") {
        if (retryAfter !== null && retryAfter <= this.maxRateLimitWaitMs && attempt < this.maxRetries) {
          this.log.info("rate limited, waiting", { waitMs: retryAfter });
          await this.sleep(retryAfter);
          continue;
        }
        throw new RemoteError("RateLimit", response.status, retryAfter);
      }
      if (category === "ServerError" && (retryable || response.status === 502 || response.status === 503) && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt));
        continue;
      }
      throw new RemoteError(category, response.status);
    }
  }

  /** Exponential backoff 1s, 2s, 4s, 8s … capped at 60 s, with ±20 % jitter. */
  backoff(attempt: number): number {
    const base = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** attempt);
    return Math.round(base * (0.8 + 0.4 * this.random()));
  }

  private async respectRateLimit(): Promise<void> {
    const wait = this.rateLimitedUntil - this.now();
    if (wait <= 0) return;
    if (wait > this.maxRateLimitWaitMs) throw new RemoteError("RateLimit", null, wait);
    await this.sleep(wait);
  }

  private async spaceWrites(): Promise<void> {
    const wait = this.lastWriteAt + this.minWriteIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastWriteAt = this.now();
  }

  private trackRateLimit(response: HttpResponse): void {
    const remaining = response.headers["x-ratelimit-remaining"];
    const reset = response.headers["x-ratelimit-reset"];
    if (remaining === "0" && reset && /^\d+$/.test(reset)) this.rateLimitedUntil = Number(reset) * 1000;
  }

  private retryAfterMs(response: HttpResponse): number | null {
    const retryAfter = response.headers["retry-after"];
    if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const reset = response.headers["x-ratelimit-reset"];
    if (response.headers["x-ratelimit-remaining"] === "0" && reset && /^\d+$/.test(reset)) {
      return Math.max(0, Number(reset) * 1000 - this.now());
    }
    return classify(response) === "RateLimit" ? 60_000 : null;
  }
}

export function classify(response: HttpResponse): RemoteErrorCategory {
  const s = response.status;
  if (s === 401) return "Authentication";
  if (s === 429) return "RateLimit";
  if (s === 403) {
    if (response.headers["x-ratelimit-remaining"] === "0" || response.headers["retry-after"] !== undefined) return "RateLimit";
    return "Authorization";
  }
  if (s === 404) return "NotFound";
  if (s === 409) return "Conflict";
  if (s === 413) return "PayloadTooLarge";
  if (s === 422) return "Conflict";
  if (s >= 500) return "ServerError";
  return "InvalidResponse";
}

/** Encodes a repository-relative path for URLs (each segment separately). */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

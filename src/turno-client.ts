import type { Logger } from "./logger.js";
import { recordOutboundError } from "./health-state.js";

export class TurnoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`Turno API ${status} on ${method} ${path}: ${stringifyBody(body)}`);
    this.name = "TurnoApiError";
  }
}

function stringifyBody(b: unknown): string {
  if (typeof b === "string") return b.slice(0, 500);
  try {
    return JSON.stringify(b).slice(0, 500);
  } catch {
    return String(b);
  }
}

export interface TurnoClientOptions {
  baseUrl: string;
  bearerToken: string;
  /** Optional — only sent as TBNB-Partner-ID header if non-empty. */
  partnerId?: string;
  logger?: Logger;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

export type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Send body as application/json (default). Set false for endpoints that take no body. */
  json?: boolean;
}

/**
 * Retry ladder (ms between attempts). Length = number of retries, so total
 * attempts = RETRY_DELAYS_MS.length + 1. Transient Turno failures (429,
 * 5xx) get retried on this schedule; Retry-After header overrides the
 * default if the server specifies a larger wait.
 */
const RETRY_DELAYS_MS = [200, 1000];
const MAX_RETRY_AFTER_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.floor(asNumber * 1000);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Thin REST client around the Turno External API v2.
 * Every request carries the tenant's Bearer + TBNB-Partner-ID header.
 */
export class TurnoClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TurnoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get partnerId(): string | undefined {
    return this.opts.partnerId || undefined;
  }

  async get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, opts);
  }
  async post<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, opts);
  }
  async patch<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, opts);
  }
  async delete<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.opts.bearerToken}`,
    };
    if (this.opts.partnerId) {
      headers["TBNB-Partner-ID"] = this.opts.partnerId;
    }
    let body: string | undefined;
    if (opts.body !== undefined && opts.json !== false) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      const res = await this.fetchImpl(url, { method, headers, body });
      const elapsed = Date.now() - started;

      const text = await res.text();
      let parsed: unknown = text;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave as text
        }
      } else {
        parsed = null;
      }

      this.opts.logger?.debug(
        { method, path, status: res.status, attempt, ms: elapsed },
        "turno api call",
      );

      if (res.ok) {
        return parsed as T;
      }

      const canRetry = attempt < maxAttempts && isRetriableStatus(res.status);
      if (!canRetry) {
        recordOutboundError({ status: res.status, path });
        throw new TurnoApiError(res.status, parsed, method, path);
      }

      // Prefer the server's Retry-After hint when present, capped to protect
      // the caller from pathological values. Fall back to the ladder otherwise.
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const delayMs =
        retryAfter !== null
          ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
          : RETRY_DELAYS_MS[attempt - 1];

      this.opts.logger?.info(
        { method, path, status: res.status, attempt, nextDelayMs: delayMs },
        "turno api retry",
      );
      await sleep(delayMs);
    }

    // Loop invariant: we always either return on success or throw on final
    // non-retriable failure. This is for TypeScript's benefit only.
    throw new Error("turno-client: unreachable retry-loop exit");
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const joined = path.startsWith("/")
      ? this.opts.baseUrl + path
      : `${this.opts.baseUrl}/${path}`;
    if (!query) return joined;

    const qs: string[] = [];
    for (const [key, raw] of Object.entries(query)) {
      if (raw === undefined || raw === null) continue;
      if (Array.isArray(raw)) {
        for (const v of raw) {
          qs.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(String(v))}`);
        }
      } else {
        qs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(raw))}`);
      }
    }
    if (qs.length === 0) return joined;
    return joined + (joined.includes("?") ? "&" : "?") + qs.join("&");
  }
}

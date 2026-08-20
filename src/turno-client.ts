import type { Logger } from "./logger.js";
import { recordOutboundError } from "./health-state.js";
import { config } from "./config.js";

export class TurnoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly method: string,
    public readonly path: string,
    /**
     * Lower-cased response headers, kept for diagnosis on the error path
     * (Cloudflare's `cf-mitigated` / `cf-ray` in particular).
     */
    public readonly headers: Record<string, string> = {},
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
  /**
   * Override the browser-fingerprinted egress for this client. Omit to use
   * the process-wide config (TURNO_EGRESS_URL / TURNO_EGRESS_FOR_HOST);
   * pass `{url: ""}` to force a direct connection. Exists for tests.
   */
  egress?: { url: string; forHost?: string };
  /** Optional — only sent as TBNB-Partner-ID header if non-empty. */
  partnerId?: string;
  /** Per-attempt outbound timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  logger?: Logger;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
}

export class TurnoNetworkError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly cause: unknown,
    public readonly timedOut: boolean,
  ) {
    const why = timedOut ? "timed out" : cause instanceof Error ? cause.message : String(cause);
    super(`Turno ${method} ${path} network error: ${why}`);
    this.name = "TurnoNetworkError";
  }
}

/**
 * A 403 that is a Cloudflare managed-challenge page rather than a credential
 * rejection. Kept distinct from TurnoApiError so callers don't tell operators
 * to rotate valid keys, and so the multi-KB challenge HTML never reaches the
 * caller: only the cf_ray is retained for support correlation.
 *
 * The trigger is the client's TLS/HTTP2 fingerprint, NOT the egress IP. This
 * was measured on 2026-08-19: from one VPS, Node's fetch and stock curl both
 * got the challenge while curl_cffi impersonating Chrome got a clean
 * `401 {"error":"Unauthenticated."}` on the same request from the same
 * address. WARP egress made no difference. So the fix is a browser
 * fingerprint (see egress/server.py), not a new IP.
 */
export class TurnoCloudflareError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly cfRay: string | null,
  ) {
    super(
      `Turno ${method} ${path} blocked by Cloudflare (managed challenge), NOT an auth failure. ` +
        `Credentials were not rejected — do not rotate the Secret Key or Partner ID. ` +
        `cf_ray=${cfRay ?? "unknown"}. Cloudflare is challenging this client's TLS ` +
        `fingerprint, so a different IP will not help: route outbound calls through the ` +
        `browser-fingerprinted egress sidecar by setting TURNO_EGRESS_URL.`,
    );
    this.name = "TurnoCloudflareError";
  }
}

/**
 * A genuine Turno auth failure returns JSON (`{"error":"Unauthenticated."}`);
 * a Cloudflare block returns an HTML interstitial carrying these markers, and
 * sets `cf-mitigated: challenge` on the response. Either signal is conclusive,
 * so both are checked — the header survives a body Cloudflare later reformats.
 */
function isCloudflareChallenge(body: string, headers: Record<string, string> = {}): boolean {
  return (
    headers["cf-mitigated"] === "challenge" ||
    body.includes("_cf_chl_opt") ||
    body.includes("challenges.cloudflare.com") ||
    /<title>\s*Just a moment/i.test(body)
  );
}

function extractCfRay(body: string): string | null {
  return body.match(/cRay:\s*'([^']+)'/)?.[1] ?? null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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
 * Flatten response headers to a lower-cased record.
 *
 * Real fetch always hands back a Headers instance, but test doubles and fetch
 * shims often pass a plain object. Header extraction is on the error path, so
 * it must never be the thing that throws.
 */
/**
 * Headers this client reasons about. Used only to probe a headers object that
 * cannot be enumerated (see below).
 */
const PROBE_HEADERS = ["cf-mitigated", "cf-ray", "content-type", "retry-after"] as const;

function lowerCaseHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  // A `get`-only shim (fetch mocks, some proxy/runtime shims) exposes no
  // enumerable entries, so iterating it yields nothing and every header read
  // downstream silently comes back undefined. Ask it directly instead.
  if (typeof (headers as Headers).get === "function") {
    for (const name of PROBE_HEADERS) {
      const value = (headers as Headers).get(name);
      if (typeof value === "string") out[name] = value;
    }
    return out;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/**
 * Rewrite a Turno base URL onto the fingerprinted egress sidecar, preserving
 * the path prefix (so `https://api.turnoverbnb.com/v2` becomes
 * `http://turno-egress:8000/v2`).
 *
 * Returns baseUrl unchanged when no egress is configured, when the host does
 * not match, or when either URL fails to parse — a bad env var must not take
 * the whole client down.
 */
export function applyEgress(
  baseUrl: string,
  egress: { url: string; forHost?: string },
): string {
  if (!egress.url) return baseUrl;
  const forHost = egress.forHost ?? "api.turnoverbnb.com";
  try {
    const target = new URL(baseUrl);
    if (target.hostname.toLowerCase() !== forHost.toLowerCase()) return baseUrl;
    const via = new URL(egress.url);
    const prefix = via.pathname.replace(/\/+$/, "");
    return `${via.origin}${prefix}${target.pathname.replace(/\/+$/, "")}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Thin REST client around the Turno External API v2.
 * Every request carries the tenant's Bearer + TBNB-Partner-ID header.
 */
export class TurnoClient {
  private readonly fetchImpl: typeof fetch;
  /**
   * Where requests actually go. Differs from the logical `baseUrl` when the
   * fingerprinted egress is in play; kept separate so cache keys, logs and
   * user-facing copy still name the real Turno host.
   */
  private readonly requestBase: string;

  constructor(private readonly opts: TurnoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestBase = applyEgress(
      opts.baseUrl,
      opts.egress ?? {
        url: config.TURNO_EGRESS_URL,
        forHost: config.TURNO_EGRESS_FOR_HOST,
      },
    );
    if (this.requestBase !== opts.baseUrl) {
      opts.logger?.debug(
        { baseUrl: opts.baseUrl, via: this.requestBase },
        "turno requests routed via fingerprinted egress",
      );
    }
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

    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const timedOut =
          err instanceof DOMException &&
          (err.name === "TimeoutError" || err.name === "AbortError");
        this.opts.logger?.info(
          {
            method,
            path,
            attempt,
            timeoutMs,
            err: err instanceof Error ? err.message : String(err),
          },
          "turno api network error",
        );
        if (attempt >= maxAttempts) {
          recordOutboundError({ status: 0, path });
          throw new TurnoNetworkError(method, path, err, timedOut);
        }
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
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

      const resHeaders = lowerCaseHeaders(res.headers);

      // A Cloudflare managed-challenge on a 403 is a fingerprint block, not an
      // auth failure. Surface it distinctly and drop the challenge page —
      // logging only the cf_ray — so operators don't rotate valid credentials
      // and the multi-KB HTML doesn't burn caller context.
      if (res.status === 403 && isCloudflareChallenge(text, resHeaders)) {
        // The response header is authoritative and what Cloudflare support
        // asks for; the body scrape is a fallback for proxies that strip it.
        // Read it off resHeaders rather than res.headers.get so a plain-object
        // fetch stub can't throw inside the error path.
        const cfRay = resHeaders["cf-ray"] ?? extractCfRay(text) ?? null;
        // Warn, not info: this fails the caller outright and is the one line
        // an operator needs. Logging it at info hid the whole 2026-08-19
        // outage on a server running at LOG_LEVEL=info.
        this.opts.logger?.warn(
          { method, path, status: 403, cfRay },
          "turno api blocked by cloudflare challenge",
        );
        recordOutboundError({ status: res.status, path });
        throw new TurnoCloudflareError(method, path, cfRay);
      }

      const canRetry = attempt < maxAttempts && isRetriableStatus(res.status);
      if (!canRetry) {
        recordOutboundError({ status: res.status, path });
        const err = new TurnoApiError(res.status, parsed, method, path, resHeaders);
        // A giving-up outbound failure used to be logged only at debug, so a
        // failing call produced zero log lines and the operator had nothing to
        // go on. Warn is the floor for anything that fails a caller.
        this.opts.logger?.warn(
          { method, path, status: res.status, attempt, ms: elapsed },
          "turno api call failed",
        );
        throw err;
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
      ? this.requestBase + path
      : `${this.requestBase}/${path}`;
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

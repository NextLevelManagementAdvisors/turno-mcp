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
      { method, path, status: res.status, ms: elapsed },
      "turno api call",
    );

    if (!res.ok) {
      recordOutboundError({ status: res.status, path });
      throw new TurnoApiError(res.status, parsed, method, path);
    }
    return parsed as T;
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

import { describe, it, expect } from "vitest";
import { TurnoClient, TurnoApiError } from "../../src/turno-client.js";

interface MockResponse {
  ok?: boolean;
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeMockFetch(responder: (url: string) => MockResponse) {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const opts = (init ?? {}) as RequestInit;
    calls.push({
      url: String(url),
      method: String(opts.method),
      headers: (opts.headers as Record<string, string>) ?? {},
      body: opts.body,
    });
    const r = responder(String(url));
    const ok = r.ok ?? (r.status >= 200 && r.status < 300);
    return {
      ok,
      status: r.status,
      text: async () => r.body ?? "{}",
      headers: {
        get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null,
      },
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

describe("TurnoClient", () => {
  it("encodes array query params as `?foo[]=1&foo[]=2`", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: "{}" }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      partnerId: "00000000-0000-0000-0000-000000000001",
      fetchImpl,
    });
    await c.get("/bookings", { query: { properties: [1, 2, 3], limit: 5 } });
    const url = calls[0].url;
    expect(url).toMatch(/^https:\/\/api\.test\/v2\/bookings\?/);
    // [] are kept literal — Turno's PHP-style collection syntax expects it.
    expect(url).toContain("properties[]=1");
    expect(url).toContain("properties[]=2");
    expect(url).toContain("properties[]=3");
    expect(url).toContain("limit=5");
  });

  it("sends both Authorization: Bearer and TBNB-Partner-ID", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: "{}" }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "my-jwt",
      partnerId: "11111111-2222-3333-4444-555555555555",
      fetchImpl,
    });
    await c.get("/userinfo");
    expect(calls[0].headers.Authorization).toBe("Bearer my-jwt");
    expect(calls[0].headers["TBNB-Partner-ID"]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("omits TBNB-Partner-ID when partnerId is not set", async () => {
    const { fetchImpl, calls } = makeMockFetch(() => ({ status: 200, body: "{}" }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      fetchImpl,
    });
    await c.get("/userinfo");
    expect(calls[0].headers["TBNB-Partner-ID"]).toBeUndefined();
  });

  it("throws TurnoApiError on non-retriable 4xx (e.g. 401)", async () => {
    const { fetchImpl } = makeMockFetch(() => ({
      status: 401,
      body: '{"error":"Unauthenticated."}',
    }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      partnerId: "00000000-0000-0000-0000-000000000001",
      fetchImpl,
    });
    await expect(c.get("/userinfo")).rejects.toBeInstanceOf(TurnoApiError);
    await expect(c.get("/userinfo")).rejects.toMatchObject({ status: 401 });
  });
});

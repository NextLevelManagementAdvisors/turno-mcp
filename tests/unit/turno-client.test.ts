import { describe, it, expect } from "vitest";
import { TurnoClient, TurnoApiError, TurnoCloudflareError } from "../../src/turno-client.js";

const CF_CHALLENGE_BODY =
  `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head>` +
  `<body><script>window._cf_chl_opt = { cRay: 'a2ddea647fda1f17', cType: 'managed', ` +
  `cZone: 'api.turnoverbnb.com' };</script>` +
  `<script src="https://challenges.cloudflare.com/turnstile"></script></body></html>`;

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

  it("raises a distinct TurnoCloudflareError on a 403 Cloudflare challenge, keeping only cf_ray", async () => {
    const { fetchImpl } = makeMockFetch(() => ({
      status: 403,
      body: CF_CHALLENGE_BODY,
    }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      partnerId: "00000000-0000-0000-0000-000000000001",
      fetchImpl,
    });
    const err = await c.get("/properties").catch((e) => e);
    expect(err).toBeInstanceOf(TurnoCloudflareError);
    expect(err).not.toBeInstanceOf(TurnoApiError);
    expect((err as TurnoCloudflareError).cfRay).toBe("a2ddea647fda1f17");
    // The multi-KB challenge page must never leak into the error message.
    expect((err as Error).message).not.toContain("_cf_chl_opt");
    expect((err as Error).message).not.toContain("<!DOCTYPE");
    expect((err as Error).message).toContain("cf_ray=a2ddea647fda1f17");
    expect((err as Error).message).toMatch(/NOT an auth failure/i);
  });

  it("keeps a genuine JSON 403 as a TurnoApiError (not a Cloudflare block)", async () => {
    const { fetchImpl } = makeMockFetch(() => ({
      status: 403,
      body: '{"message":"Unable to identify the requesting entity."}',
    }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      partnerId: "00000000-0000-0000-0000-000000000001",
      fetchImpl,
    });
    const err = await c.get("/properties").catch((e) => e);
    expect(err).toBeInstanceOf(TurnoApiError);
    expect(err).not.toBeInstanceOf(TurnoCloudflareError);
    expect((err as TurnoApiError).status).toBe(403);
  });

  it("reports cfRay=null when the challenge page omits a cRay", async () => {
    const { fetchImpl } = makeMockFetch(() => ({
      status: 403,
      body: "<title>Just a moment...</title>",
    }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      fetchImpl,
    });
    const err = await c.get("/properties").catch((e) => e);
    expect(err).toBeInstanceOf(TurnoCloudflareError);
    expect((err as TurnoCloudflareError).cfRay).toBeNull();
  });

  it("prefers the cf-ray response header over the body scrape when the header is present", async () => {
    const { fetchImpl } = makeMockFetch(() => ({
      status: 403,
      body: "<title>Just a moment...</title>",
      headers: { "cf-ray": "8f1c2e9a7bd1e4f2-SJC" },
    }));
    const c = new TurnoClient({
      baseUrl: "https://api.test/v2",
      bearerToken: "t",
      fetchImpl,
    });
    const err = await c.get("/properties").catch((e) => e);
    expect(err).toBeInstanceOf(TurnoCloudflareError);
    expect((err as TurnoCloudflareError).cfRay).toBe("8f1c2e9a7bd1e4f2-SJC");
  });
});

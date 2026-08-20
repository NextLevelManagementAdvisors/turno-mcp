import { describe, it, expect } from "vitest";
import {
  applyEgress,
  TurnoApiError,
  TurnoClient,
  TurnoCloudflareError,
} from "../../src/turno-client.js";

const TURNO = "https://api.turnoverbnb.com/v2";
const EGRESS = { url: "http://turno-egress:8000", forHost: "api.turnoverbnb.com" };

/**
 * These guard the 2026-08-19 outage: Cloudflare Bot Management started
 * challenging Node's TLS fingerprint on api.turnoverbnb.com, every call came
 * back 403, and the server reported it as "Turno rejected these credentials"
 * — sending the operator after a Secret Key that was never wrong.
 *
 * Two properties matter and neither is obvious from reading the happy path:
 *  1. the egress rewrite must preserve the /v2 path prefix and must key off
 *     the HOST, because each bearer carries its own baseUrl (so a plain
 *     env-var swap silently misses every already-issued bearer), and
 *  2. a challenge must stay distinguishable from a credential rejection.
 */
describe("applyEgress", () => {
  it("routes the Turno host through the sidecar, keeping the /v2 prefix", () => {
    expect(applyEgress(TURNO, EGRESS)).toBe("http://turno-egress:8000/v2");
  });

  it("is a no-op when no egress is configured", () => {
    expect(applyEgress(TURNO, { url: "" })).toBe(TURNO);
  });

  it("leaves other hosts alone so a custom base URL still goes direct", () => {
    const sandbox = "https://sandbox.example.com/v2";
    expect(applyEgress(sandbox, EGRESS)).toBe(sandbox);
  });

  it("matches the host case-insensitively", () => {
    expect(applyEgress("https://API.TurnoverBnB.com/v2", EGRESS)).toBe(
      "http://turno-egress:8000/v2",
    );
  });

  it("honours a path prefix on the egress URL itself", () => {
    expect(applyEgress(TURNO, { ...EGRESS, url: "http://gateway:8000/turno/" })).toBe(
      "http://gateway:8000/turno/v2",
    );
  });

  it("falls back to direct rather than throwing on an unparseable egress URL", () => {
    expect(applyEgress(TURNO, { ...EGRESS, url: "not-a-url" })).toBe(TURNO);
  });
});

describe("challenge detection", () => {
  const respondWith = (status: number, body: string, headers: Record<string, string> = {}) =>
    new TurnoClient({
      baseUrl: TURNO,
      bearerToken: "secret",
      egress: { url: "" },
      fetchImpl: (async () => new Response(body, { status, headers })) as unknown as typeof fetch,
    });

  it("detects a challenge from the cf-mitigated header alone", async () => {
    // Cloudflare reformats its interstitial markup periodically; the header
    // is the signal that does not rot.
    await expect(
      respondWith(403, "<html>nothing familiar here</html>", {
        "cf-mitigated": "challenge",
      }).get("/userinfo"),
    ).rejects.toBeInstanceOf(TurnoCloudflareError);
  });

  it("detects the interstitial body when the header is absent", async () => {
    await expect(
      respondWith(403, "<html><title>Just a moment...</title></html>").get("/userinfo"),
    ).rejects.toBeInstanceOf(TurnoCloudflareError);
  });

  it("carries cf-ray through from the response header", async () => {
    await expect(
      respondWith(403, "<html>blocked</html>", {
        "cf-mitigated": "challenge",
        "cf-ray": "a2de4e90ddb44ca7-PHX",
      }).get("/userinfo"),
    ).rejects.toMatchObject({ cfRay: "a2de4e90ddb44ca7-PHX" });
  });

  it("does NOT flag a real credential rejection", async () => {
    await expect(
      respondWith(401, JSON.stringify({ error: "Unauthenticated." })).get("/userinfo"),
    ).rejects.toBeInstanceOf(TurnoApiError);
  });

  it("does NOT flag a genuine Turno 403 with a JSON body", async () => {
    const err = await respondWith(403, JSON.stringify({ error: "Forbidden." }))
      .get("/userinfo")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnoApiError);
    expect(err).not.toBeInstanceOf(TurnoCloudflareError);
  });
});

describe("TurnoClient egress wiring", () => {
  it("sends requests to the egress while still reporting the real baseUrl", async () => {
    const seen: string[] = [];
    const client = new TurnoClient({
      baseUrl: TURNO,
      bearerToken: "secret",
      partnerId: "3e081d7d-0413-45cb-a351-0e2c245e5671",
      egress: EGRESS,
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await client.get("/userinfo");

    expect(seen).toEqual(["http://turno-egress:8000/v2/userinfo"]);
    // The logical base URL is what cache keys and user-facing copy use, so it
    // must keep naming Turno itself.
    expect(client.baseUrl).toBe(TURNO);
  });

  it("attaches response headers to TurnoApiError for diagnosis", async () => {
    const client = new TurnoClient({
      baseUrl: TURNO,
      bearerToken: "secret",
      egress: { url: "" },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "Unauthenticated." }), {
          status: 401,
          headers: { "cf-ray": "a2de4e90ddb44ca7-PHX" },
        })) as unknown as typeof fetch,
    });

    const err = await client.get("/userinfo").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnoApiError);
    expect((err as TurnoApiError).headers["cf-ray"]).toBe("a2de4e90ddb44ca7-PHX");
  });
});

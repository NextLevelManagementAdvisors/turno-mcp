import { describe, it, expect, beforeAll } from "vitest";
import { signBearer, verifyBearer, BearerError } from "../../src/bearer.js";

beforeAll(() => {
  // Length must be ≥ 32 per crypto.ts. Value is deterministic so we can
  // reason about sign/verify without test pollution from the environment.
  process.env.TURNO_ENCRYPTION_KEY = "0".repeat(64);
});

describe("bearer", () => {
  const creds = {
    partnerId: "3e081d7d-0413-45cb-a351-0e2c245e5671",
    secretKey: "eyJ.dummy.secret",
    baseUrl: "https://api.turnoverbnb.com/v2",
  };

  it("round-trips sign → verify", () => {
    const token = signBearer({ ...creds, ttlSeconds: 60 });
    const claims = verifyBearer(token);
    expect(claims.partnerId).toBe(creds.partnerId);
    expect(claims.secretKey).toBe(creds.secretKey);
    expect(claims.baseUrl).toBe(creds.baseUrl);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects tampered signature", () => {
    const token = signBearer({ ...creds, ttlSeconds: 60 });
    const tampered = token.slice(0, -4) + "AAAA";
    expect(() => verifyBearer(tampered)).toThrow(BearerError);
    expect(() => verifyBearer(tampered)).toThrow(/invalid signature/);
  });

  it("rejects expired bearer", () => {
    const token = signBearer({ ...creds, ttlSeconds: -10 });
    expect(() => verifyBearer(token)).toThrow(/bearer expired/);
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyBearer("onlyonepart")).toThrow(/malformed bearer/);
    expect(() => verifyBearer("")).toThrow(/malformed bearer/);
    // Three parts but garbage — fails at signature verification
    expect(() => verifyBearer("aaa.bbb.ccc")).toThrow(BearerError);
  });
});

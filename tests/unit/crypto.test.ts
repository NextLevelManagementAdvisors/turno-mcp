import { describe, it, expect, beforeAll } from "vitest";
import { deriveKey, encryptSecret, decryptSecret } from "../../src/crypto.js";

beforeAll(() => {
  process.env.TURNO_ENCRYPTION_KEY = "0".repeat(64);
});

describe("crypto", () => {
  it("deriveKey produces distinct keys for different info strings", () => {
    const a = deriveKey("purpose A");
    const b = deriveKey("purpose B");
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it("deriveKey is deterministic for the same info string", () => {
    const first = deriveKey("stable info");
    const second = deriveKey("stable info");
    expect(Buffer.compare(first, second)).toBe(0);
  });

  it("encryptSecret → decryptSecret round-trips", () => {
    const plain = "some secret value 🚀";
    const enc = encryptSecret(plain);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("re-encryption of the same plaintext yields distinct IV + ciphertext", () => {
    const a = encryptSecret("repeat me");
    const b = encryptSecret("repeat me");
    expect(Buffer.compare(a.iv, b.iv)).not.toBe(0);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });
});

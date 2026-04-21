import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SECRET_INFO = "turno-mcp tenant secret v1";

const keyCache = new Map<string, Buffer>();

/**
 * Derive a 32-byte key from the root `TURNO_ENCRYPTION_KEY` for a given
 * purpose. Callers pass a stable `info` string so different purposes
 * (AES-GCM encryption, HMAC signing) get non-overlapping keys.
 */
export function deriveKey(info: string): Buffer {
  const cached = keyCache.get(info);
  if (cached) return cached;
  const salt = process.env.TURNO_ENCRYPTION_KEY;
  if (!salt || salt.length < 32) {
    throw new Error("TURNO_ENCRYPTION_KEY must be set and at least 32 chars");
  }
  const derived = Buffer.from(
    hkdfSync("sha256", Buffer.from(salt), Buffer.alloc(0), info, KEY_LENGTH),
  );
  keyCache.set(info, derived);
  return derived;
}

function getKey(): Buffer {
  return deriveKey(SECRET_INFO);
}

export interface EncryptedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptSecret(plain: string): EncryptedValue {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`unexpected GCM tag length: ${tag.length}`);
  }
  return { ciphertext, iv, tag };
}

export function decryptSecret(enc: EncryptedValue): string {
  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, enc.iv);
  decipher.setAuthTag(enc.tag);
  const plaintext = Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

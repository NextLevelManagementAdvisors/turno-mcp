import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptSecret, deriveKey, encryptSecret } from "./crypto.js";

const HMAC_INFO = "turno-mcp bearer hmac v1";
const HEADER = { alg: "HS256", typ: "JWT" } as const;
const HEADER_B64 = b64urlEncode(Buffer.from(JSON.stringify(HEADER)));

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4;
  const padded = pad ? s + "=".repeat(4 - pad) : s;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export type TokenType = "access" | "refresh" | "code";

interface InnerPayload {
  pid: string;
  b: string;
  ek: { iv: string; tag: string; ct: string };
  exp: number;
  typ?: TokenType;
  // OAuth auth-code flow extras (only present when typ === "code")
  ru?: string; // redirect_uri
  cc?: string; // code_challenge (S256)
  ci?: string; // client_id
}

export interface BearerClaims {
  partnerId: string;
  secretKey: string;
  baseUrl: string;
  exp: number;
  typ: TokenType;
  redirectUri?: string;
  codeChallenge?: string;
  clientId?: string;
}

export class BearerError extends Error {}

function sign(payload: InnerPayload): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${HEADER_B64}.${body}`;
  const sig = createHmac("sha256", deriveKey(HMAC_INFO)).update(signingInput).digest();
  return `${signingInput}.${b64urlEncode(sig)}`;
}

/**
 * Produce a self-contained signed bearer that carries the Turno
 * credentials encrypted in the payload. The server can verify + decrypt
 * these using only `TURNO_ENCRYPTION_KEY` — no tenant store required.
 *
 * Format is JWT-compatible (HS256) so a standard JWT verifier with the
 * HMAC key can read the header/payload structure, but the `ek` claim
 * (AES-256-GCM encrypted Turno Secret Key) is only decryptable by us.
 */
export function signBearer(opts: {
  partnerId: string;
  secretKey: string;
  baseUrl: string;
  ttlSeconds?: number;
  typ?: "access" | "refresh";
}): string {
  const ek = encryptSecret(opts.secretKey);
  return sign({
    pid: opts.partnerId,
    b: opts.baseUrl,
    ek: {
      iv: ek.iv.toString("hex"),
      tag: ek.tag.toString("hex"),
      ct: ek.ciphertext.toString("hex"),
    },
    exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 86_400),
    typ: opts.typ ?? "access",
  });
}

/**
 * One-time authorization code for the OAuth 2.1 authorization_code flow.
 * Carries the credentials encrypted + the PKCE challenge + redirect_uri
 * so the subsequent /oauth/token exchange can verify everything without
 * any server-side state. TTL is short (default 60s) — claude.ai redeems
 * within seconds.
 */
export function signAuthCode(opts: {
  partnerId: string;
  secretKey: string;
  baseUrl: string;
  redirectUri: string;
  codeChallenge: string;
  clientId: string;
  ttlSeconds?: number;
}): string {
  const ek = encryptSecret(opts.secretKey);
  return sign({
    pid: opts.partnerId,
    b: opts.baseUrl,
    ek: {
      iv: ek.iv.toString("hex"),
      tag: ek.tag.toString("hex"),
      ct: ek.ciphertext.toString("hex"),
    },
    exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 60),
    typ: "code",
    ru: opts.redirectUri,
    cc: opts.codeChallenge,
    ci: opts.clientId,
  });
}

export function verifyBearer(token: string, expectedTyp?: TokenType): BearerClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new BearerError("malformed bearer");
  const [header, body, sigB] = parts;

  const expected = createHmac("sha256", deriveKey(HMAC_INFO))
    .update(`${header}.${body}`)
    .digest();
  const actual = b64urlDecode(sigB);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new BearerError("invalid signature");
  }

  let payload: InnerPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as InnerPayload;
  } catch {
    throw new BearerError("malformed payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new BearerError("bearer expired");
  if (!payload.pid || !payload.b || !payload.ek) {
    throw new BearerError("missing claims");
  }

  // Pre-typ tokens (issued before this refactor) are treated as "access" so
  // existing bearers keep working through rollout.
  const typ: TokenType = (payload.typ as TokenType) ?? "access";
  if (expectedTyp && typ !== expectedTyp) {
    throw new BearerError(`expected typ=${expectedTyp}, got ${typ}`);
  }

  let secretKey: string;
  try {
    secretKey = decryptSecret({
      iv: Buffer.from(payload.ek.iv, "hex"),
      tag: Buffer.from(payload.ek.tag, "hex"),
      ciphertext: Buffer.from(payload.ek.ct, "hex"),
    });
  } catch {
    throw new BearerError("could not decrypt embedded secret");
  }

  return {
    partnerId: payload.pid,
    secretKey,
    baseUrl: payload.b,
    exp: payload.exp,
    typ,
    redirectUri: payload.ru,
    codeChallenge: payload.cc,
    clientId: payload.ci,
  };
}

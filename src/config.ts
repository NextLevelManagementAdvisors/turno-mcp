import "dotenv/config";

const trueish = (v: string | undefined, def = false): boolean => {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export const config = {
  TRANSPORT: (process.env.TRANSPORT ?? "stdio") as "stdio" | "http",

  // HTTP mode
  HOST: process.env.HOST ?? "127.0.0.1",
  PORT: Number(process.env.PORT ?? 3007),
  PUBLIC_HOST: process.env.TURNO_PUBLIC_HOST ?? "turno.nlma.io",
  ENROLL_ENABLED: trueish(process.env.ENROLL_ENABLED, true),

  // Root key for HKDF-derived JWT HMAC + embedded-credential AES-GCM.
  // Bearers are self-contained JWTs — there is no tenant store.
  TURNO_ENCRYPTION_KEY: process.env.TURNO_ENCRYPTION_KEY ?? "",

  // Turno API
  TURNO_BASE_URL: (process.env.TURNO_BASE_URL ?? "https://api.turnoverbnb.com/v2").replace(/\/+$/, ""),

  // TLS cert path for /health surface — derived from PUBLIC_HOST so it tracks
  // the Let's Encrypt convention. Override via env if the cert lives elsewhere.
  TURNO_CERT_PATH:
    process.env.TURNO_CERT_PATH ??
    `/etc/letsencrypt/live/${process.env.TURNO_PUBLIC_HOST ?? "turno.nlma.io"}/cert.pem`,

  // Per-request outbound timeout. Guards against a hung Turno socket pinning
  // a Node handler indefinitely. Each retry attempt gets its own budget.
  TURNO_REQUEST_TIMEOUT_MS: Number(process.env.TURNO_REQUEST_TIMEOUT_MS ?? 30_000),

  // stdio mode
  TURNO_API_TOKEN: process.env.TURNO_API_TOKEN ?? "",
  TURNO_PARTNER_ID: process.env.TURNO_PARTNER_ID ?? "",
} as const;

export type Config = typeof config;

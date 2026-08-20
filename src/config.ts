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

  // Browser-fingerprinted egress (see egress/server.py).
  //
  // Cloudflare Bot Management on api.turnoverbnb.com classifies on the
  // TLS/HTTP2 fingerprint: Node's fetch gets a 403 challenge on every
  // request, credentials or not. When TURNO_EGRESS_URL is set, outbound
  // calls whose host is TURNO_EGRESS_FOR_HOST are re-pointed at the sidecar,
  // which replays them with a Chrome fingerprint.
  //
  // The rewrite happens at request time rather than by changing
  // TURNO_BASE_URL because each bearer carries its own base URL baked into
  // the JWT — an env swap would only fix newly issued bearers.
  //
  // Empty (the default) disables the rewrite entirely: direct-to-Turno.
  TURNO_EGRESS_URL: (process.env.TURNO_EGRESS_URL ?? "").replace(/\/+$/, ""),
  TURNO_EGRESS_FOR_HOST: process.env.TURNO_EGRESS_FOR_HOST ?? "api.turnoverbnb.com",

  // TLS cert path for /health surface — derived from PUBLIC_HOST so it tracks
  // the Let's Encrypt convention. Override via env if the cert lives elsewhere.
  TURNO_CERT_PATH:
    process.env.TURNO_CERT_PATH ??
    `/etc/letsencrypt/live/${process.env.TURNO_PUBLIC_HOST ?? "turno.nlma.io"}/cert.pem`,

  // Per-request outbound timeout. Guards against a hung Turno socket pinning
  // a Node handler indefinitely. Each retry attempt gets its own budget.
  TURNO_REQUEST_TIMEOUT_MS: Number(process.env.TURNO_REQUEST_TIMEOUT_MS ?? 30_000),

  // How long to wait for in-flight MCP sessions to drain on SIGTERM/SIGINT
  // before force-exiting. systemd's default TimeoutStopSec is 90s, so the
  // default (10s) leaves plenty of headroom.
  TURNO_SHUTDOWN_TIMEOUT_MS: Number(process.env.TURNO_SHUTDOWN_TIMEOUT_MS ?? 10_000),

  // stdio mode
  TURNO_API_TOKEN: process.env.TURNO_API_TOKEN ?? "",
  TURNO_PARTNER_ID: process.env.TURNO_PARTNER_ID ?? "",
} as const;

export type Config = typeof config;

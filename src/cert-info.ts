import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import type { Logger } from "./logger.js";

export interface CertInfo {
  expiresAt: string;
}

interface CacheEntry {
  info: CertInfo | null;
  readAt: number;
  path: string;
}

const TTL_MS = 60 * 60 * 1000; // re-read at most hourly
let cache: CacheEntry | null = null;

/**
 * Read the active TLS cert's `notAfter` for /health surfacing. Returns null
 * when the cert file isn't readable (dev machines, sandbox, etc.) — caller
 * should omit the field rather than error.
 */
export function getCertInfo(certPath: string, logger?: Logger): CertInfo | null {
  const now = Date.now();
  if (cache && cache.path === certPath && now - cache.readAt < TTL_MS) {
    return cache.info;
  }
  let info: CertInfo | null = null;
  try {
    const pem = readFileSync(certPath, "utf8");
    const cert = new X509Certificate(pem);
    info = { expiresAt: new Date(cert.validTo).toISOString() };
  } catch (err) {
    logger?.debug(
      { certPath, err: err instanceof Error ? err.message : String(err) },
      "cert read failed",
    );
  }
  cache = { info, readAt: now, path: certPath };
  return info;
}

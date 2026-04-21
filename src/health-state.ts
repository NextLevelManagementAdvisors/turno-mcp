import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Server name + version, sourced from package.json so /health stays in sync
 * with what's actually deployed.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
let pkg: { name: string; version: string };
try {
  pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
  );
} catch {
  pkg = { name: "turno-mcp", version: "unknown" };
}
export const SERVER_NAME = pkg.name;
export const SERVER_VERSION = pkg.version;

/**
 * Last-outbound-error tracking — single mutable record, ephemeral per process.
 * Intentionally tiny: just enough for /health to surface "the server reached
 * Turno but Turno rejected us" vs. "everything's fine since boot".
 */
export interface OutboundErrorRecord {
  at: string;
  status?: number;
  path?: string;
}
let lastOutboundError: OutboundErrorRecord | null = null;

export function recordOutboundError(rec: { status?: number; path?: string }): void {
  lastOutboundError = { at: new Date().toISOString(), ...rec };
}

export function getLastOutboundError(): OutboundErrorRecord | null {
  return lastOutboundError;
}

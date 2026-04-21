import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import { TurnoClient } from "./turno-client.js";
import type { ToolContext } from "./tools/_shared.js";
import { config } from "./config.js";

const TTL_MS = 60_000;
const MAX_ENTRIES = 200;

interface Entry {
  ctx: ToolContext;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/**
 * Return a (cached) ToolContext for the given credentials. Each distinct
 * (partner_id, secret_key, base_url) triple gets its own TurnoClient
 * instance, kept alive for 60s so a burst of MCP requests from the same
 * tenant doesn't rebuild the client on every call.
 *
 * Used from the stateless JWT auth path — the TenantStore is gone, so
 * this is where per-connection state lives (in memory, ephemeral).
 */
export function getToolContext(opts: {
  partnerId: string;
  secretKey: string;
  baseUrl: string;
  logger: Logger;
}): ToolContext {
  const key = createHash("sha256")
    .update(`${opts.partnerId}:${opts.secretKey}:${opts.baseUrl}`)
    .digest("hex");
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    existing.expiresAt = now + TTL_MS;
    return existing.ctx;
  }

  const logger = opts.logger.child({ pid: opts.partnerId });
  const client = new TurnoClient({
    baseUrl: opts.baseUrl,
    bearerToken: opts.secretKey,
    partnerId: opts.partnerId,
    timeoutMs: config.TURNO_REQUEST_TIMEOUT_MS,
    logger,
  });
  const ctx: ToolContext = { client, logger };
  cache.set(key, { ctx, expiresAt: now + TTL_MS });

  if (cache.size > MAX_ENTRIES) {
    for (const [k, v] of cache) {
      if (v.expiresAt < now) cache.delete(k);
    }
  }
  return ctx;
}

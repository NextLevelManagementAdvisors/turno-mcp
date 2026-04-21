import express from "express";
import rateLimit from "express-rate-limit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { buildBearerAuth } from "./auth.js";
import { signBearer } from "./bearer.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/_shared.js";
import { registerTools } from "./tools/register.js";
import { TurnoClient, TurnoApiError } from "./turno-client.js";
import { enrollError, enrollForm, enrollSuccess, landingPage } from "./enroll-html.js";
import { config } from "./config.js";
import { getCertInfo } from "./cert-info.js";
import {
  getLastOutboundError,
  SERVER_NAME,
  SERVER_VERSION,
} from "./health-state.js";

interface StartOpts {
  host: string;
  port: number;
  publicHost: string;
  enrollEnabled: boolean;
  logger: Logger;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_TTL_SECONDS = 86_400; // 1 day — short enough to force refresh, long enough for normal use

function buildMcpServer(toolCtx: ToolContext): Server {
  const server = new Server(
    { name: "turno-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, toolCtx);
  return server;
}

/**
 * Validate Turno credentials with a real outbound /userinfo call before
 * handing the user a bearer. Catches typos / revoked tokens at enrollment
 * time instead of on the first MCP call.
 *
 * Returns `{ok: true, info}` on success, `{ok: false, reason}` otherwise.
 */
async function validateTurnoCredentials(
  opts: { partnerId: string; secretKey: string; baseUrl: string; logger: Logger },
): Promise<{ ok: true; info: unknown } | { ok: false; status: number; reason: string }> {
  const client = new TurnoClient({
    baseUrl: opts.baseUrl,
    bearerToken: opts.secretKey,
    partnerId: opts.partnerId,
    timeoutMs: config.TURNO_REQUEST_TIMEOUT_MS,
    logger: opts.logger,
  });
  try {
    const info = await client.get("/userinfo");
    return { ok: true, info };
  } catch (err) {
    if (err instanceof TurnoApiError) {
      return {
        ok: false,
        status: err.status,
        reason: `Turno rejected these credentials (HTTP ${err.status}). Double-check the Secret Key and Partner ID.`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, reason: `Couldn't reach Turno: ${msg}` };
  }
}

export function buildApp(opts: StartOpts): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .status(200)
      .send(landingPage(opts.publicHost));
  });

  app.get("/health", (_req, res) => {
    const body: Record<string, unknown> = {
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
    };
    const cert = getCertInfo(config.TURNO_CERT_PATH, opts.logger);
    if (cert) body.cert_expires_at = cert.expiresAt;
    const err = getLastOutboundError();
    if (err) body.last_outbound_error_at = err.at;
    res.json(body);
  });

  // Rate-limit the bearer-issuing endpoints. Each call makes a real
  // outbound /userinfo request to Turno, so bounded requests still matter.
  const enrollLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: "rate_limited",
      error_description:
        "Too many enrollment attempts from this IP. Try again in an hour.",
    },
  });

  // ─── Enrollment ───────────────────────────────────────────────────────
  if (opts.enrollEnabled) {
    app.get("/enroll", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8").status(200).send(enrollForm());
    });

    app.post("/enroll", enrollLimiter, async (req, res) => {
      const label = String(req.body?.label ?? "").trim();
      const apiToken = String(req.body?.api_token ?? "").trim();
      const partnerId = String(req.body?.partner_id ?? "").trim();
      const baseUrl =
        String(req.body?.base_url ?? config.TURNO_BASE_URL).trim().replace(/\/+$/, "") ||
        config.TURNO_BASE_URL;

      const errors: string[] = [];
      if (!label) errors.push("Label is required");
      if (!apiToken) errors.push("Secret Key is required");
      if (!partnerId) errors.push("Partner ID is required");
      else if (!UUID_RE.test(partnerId)) errors.push("Partner ID must be a UUID");
      if (!/^https:\/\//i.test(baseUrl)) errors.push("Base URL must be https://");

      if (errors.length) {
        res
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .status(400)
          .send(enrollForm(errors.join(" · ")));
        return;
      }

      const check = await validateTurnoCredentials({
        partnerId,
        secretKey: apiToken,
        baseUrl,
        logger: opts.logger,
      });
      if (!check.ok) {
        res
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .status(400)
          .send(enrollForm(check.reason));
        return;
      }

      const bearer = signBearer({
        partnerId,
        secretKey: apiToken,
        baseUrl,
        ttlSeconds: BEARER_TTL_SECONDS,
      });
      opts.logger.info({ label, baseUrl, partnerId }, "bearer issued via /enroll");
      res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .status(200)
        .send(enrollSuccess(bearer, opts.publicHost));
    });

    /**
     * OAuth 2.0 client_credentials grant. Lets OAuth-aware MCP clients
     * (claude.ai custom connectors, etc.) exchange (Partner ID, Secret Key)
     * for an MCP bearer without the user visiting /enroll manually.
     *
     * - `client_id`     = Turno Partner ID (UUID)
     * - `client_secret` = Turno Secret Key (JWT)
     * - Also accepts HTTP Basic auth as per RFC 6749
     * - Legacy alias: `grant_type=api_token` with `api_token` + `partner_id`
     */
    app.post("/token", enrollLimiter, async (req, res) => {
      const grant = String(req.body?.grant_type ?? "");
      if (grant !== "client_credentials" && grant !== "api_token") {
        res.status(400).json({
          error: "unsupported_grant_type",
          error_description:
            "Supported grants: client_credentials, api_token.",
        });
        return;
      }

      const basic = parseBasicAuth(req);
      const clientId = String(
        req.body?.client_id ?? req.body?.partner_id ?? basic?.id ?? "",
      ).trim();
      const clientSecret = String(
        req.body?.client_secret ?? req.body?.api_token ?? basic?.secret ?? "",
      ).trim();
      const baseUrl =
        String(req.body?.base_url ?? config.TURNO_BASE_URL).trim().replace(/\/+$/, "") ||
        config.TURNO_BASE_URL;

      if (!clientSecret) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "client_secret (Turno Secret Key) is required",
        });
        return;
      }
      if (!clientId || !UUID_RE.test(clientId)) {
        res.status(400).json({
          error: "invalid_request",
          error_description:
            "client_id (Turno Partner ID UUID, from the bottom of the Tokens page) is required",
        });
        return;
      }

      const check = await validateTurnoCredentials({
        partnerId: clientId,
        secretKey: clientSecret,
        baseUrl,
        logger: opts.logger,
      });
      if (!check.ok) {
        res.status(check.status >= 500 ? 502 : 401).json({
          error: "invalid_grant",
          error_description: check.reason,
        });
        return;
      }

      const bearer = signBearer({
        partnerId: clientId,
        secretKey: clientSecret,
        baseUrl,
        ttlSeconds: BEARER_TTL_SECONDS,
      });
      opts.logger.info({ baseUrl, partnerId: clientId, grant }, "bearer issued via /token");
      res.json({
        access_token: bearer,
        token_type: "Bearer",
        expires_in: BEARER_TTL_SECONDS,
      });
    });
  }

  // ─── MCP transport ────────────────────────────────────────────────────
  const auth = buildBearerAuth({ logger: opts.logger });

  app.post("/mcp", auth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }
    if (sessionId && !transports.has(sessionId)) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found. Please re-initialize." },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };

    if (!req.toolCtx) {
      res.status(500).json({ error: "internal", error_description: "missing toolCtx" });
      return;
    }
    const server = buildMcpServer(req.toolCtx);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", auth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "Missing or invalid session ID" });
  });

  app.delete("/mcp", auth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res);
      transports.delete(sessionId);
      return;
    }
    res.status(400).json({ error: "Missing or invalid session ID" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

function parseBasicAuth(req: express.Request): { id: string; secret: string } | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, idx)),
      secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return null;
  }
}

// Silence unused import warning — the enrollError page is kept for future
// surface area (e.g. catching server-internal exceptions) but isn't wired yet.
void enrollError;

export function listen(opts: StartOpts): void {
  const app = buildApp(opts);
  const server = app.listen(opts.port, opts.host, () => {
    opts.logger.info(
      { host: opts.host, port: opts.port, enrollEnabled: opts.enrollEnabled },
      "turno-mcp HTTP listening",
    );
  });

  // Graceful shutdown: on SIGTERM (systemd restart) or SIGINT (Ctrl+C),
  // stop accepting new connections, drain in-flight MCP sessions for up to
  // TURNO_SHUTDOWN_TIMEOUT_MS, then exit cleanly so `Restart=always` cycles
  // don't drop tool calls mid-flight.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    opts.logger.info({ signal, inflight: transports.size }, "graceful shutdown starting");

    server.close();
    server.closeIdleConnections?.();

    const deadline = Date.now() + config.TURNO_SHUTDOWN_TIMEOUT_MS;
    while (transports.size > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    if (transports.size > 0) {
      opts.logger.warn(
        { inflight: transports.size, waitedMs: config.TURNO_SHUTDOWN_TIMEOUT_MS },
        "shutdown deadline hit, forcing exit",
      );
    } else {
      opts.logger.info("graceful shutdown complete — all sessions drained");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

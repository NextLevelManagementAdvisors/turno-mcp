import express from "express";
import rateLimit from "express-rate-limit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { buildBearerAuth } from "./auth.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/_shared.js";
import { registerTools } from "./tools/register.js";
import type { TenantStore } from "./tenants.js";
import type { TenantRegistry } from "./tenant-registry.js";
import { enrollError, enrollForm, enrollSuccess } from "./enroll-html.js";
import { config } from "./config.js";

interface StartOpts {
  host: string;
  port: number;
  publicHost: string;
  store: TenantStore;
  registry: TenantRegistry;
  enrollEnabled: boolean;
  logger: Logger;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

function buildMcpServer(toolCtx: ToolContext): Server {
  const server = new Server(
    { name: "turno-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, toolCtx);
  return server;
}

export function buildApp(opts: StartOpts): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "turno-mcp", tenants: opts.store.list().length });
  });

  // Rate-limit the tenant-creation endpoints so a leaked URL can't be
  // sprayed to grow tenants.json without bound. 5 writes/hour/IP is
  // plenty for legitimate onboarding — real enrollment is once-ever.
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

    app.post("/enroll", enrollLimiter, (req, res) => {
      const label = String(req.body?.label ?? "").trim();
      const apiToken = String(req.body?.api_token ?? "").trim();
      const partnerId = String(req.body?.partner_id ?? "").trim();
      const baseUrl =
        String(req.body?.base_url ?? config.TURNO_BASE_URL).trim().replace(/\/+$/, "") ||
        config.TURNO_BASE_URL;

      const errors: string[] = [];
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

      try {
        const { bearer } = opts.store.createWithApiToken({
          label,
          apiToken,
          partnerId: partnerId || undefined,
          baseUrl,
        });
        opts.logger.info({ label, baseUrl }, "tenant enrolled");
        res
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .status(200)
          .send(enrollSuccess(bearer, opts.publicHost));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res
          .setHeader("Content-Type", "text/html; charset=utf-8")
          .status(500)
          .send(enrollError(msg));
      }
    });

    /**
     * Programmatic enrollment for non-browser flows (e.g. an OAuth
     * client_credentials–style automation). Accepts JSON + returns JSON.
     * Treats the Turno API token + partner ID as the "client credentials".
     */
    app.post("/token", enrollLimiter, (req, res) => {
      const grant = String(req.body?.grant_type ?? "");
      if (grant !== "api_token") {
        res.status(400).json({
          error: "unsupported_grant_type",
          error_description:
            "Only grant_type=api_token is supported today. OAuth authorization_code is scaffolded for a future release.",
        });
        return;
      }
      const label = String(req.body?.label ?? req.body?.client_id ?? "api").trim();
      const apiToken = String(req.body?.api_token ?? req.body?.client_secret ?? "").trim();
      const partnerId = String(req.body?.partner_id ?? "").trim();
      const baseUrl =
        String(req.body?.base_url ?? config.TURNO_BASE_URL).trim().replace(/\/+$/, "") ||
        config.TURNO_BASE_URL;

      const TOK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!apiToken) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "api_token is required",
        });
        return;
      }
      if (!partnerId || !TOK_UUID_RE.test(partnerId)) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "partner_id (UUID, from the bottom of the Turno Tokens page) is required",
        });
        return;
      }
      const { bearer } = opts.store.createWithApiToken({
        label,
        apiToken,
        partnerId,
        baseUrl,
      });
      res.json({
        access_token: bearer,
        token_type: "Bearer",
        expires_in: 31_536_000,
      });
    });
  }

  // ─── MCP transport ────────────────────────────────────────────────────
  const auth = buildBearerAuth({ store: opts.store, registry: opts.registry });

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

export function listen(opts: StartOpts): void {
  const app = buildApp(opts);
  app.listen(opts.port, opts.host, () => {
    opts.logger.info(
      { host: opts.host, port: opts.port, enrollEnabled: opts.enrollEnabled },
      "turno-mcp HTTP listening",
    );
  });
}

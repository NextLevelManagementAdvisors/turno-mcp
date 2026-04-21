import express from "express";
import rateLimit from "express-rate-limit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { buildBearerAuth } from "./auth.js";
import { createHash, randomBytes } from "node:crypto";
import { BearerError, signAuthCode, signBearer, verifyBearer } from "./bearer.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/_shared.js";
import { registerTools } from "./tools/register.js";
import { TurnoClient, TurnoApiError } from "./turno-client.js";
import { enrollError, enrollForm, enrollSuccess, landingPage, oauthConsentForm } from "./enroll-html.js";
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
const BEARER_TTL_SECONDS = 86_400; // 1 day access tokens — short enough to force refresh, long enough for normal use
const REFRESH_TTL_SECONDS = 30 * 86_400; // 30 day refresh tokens
const CODE_TTL_SECONDS = 60; // short-lived auth code (claude.ai redeems in seconds)

function pkceVerify(verifier: string, challenge: string): boolean {
  // PKCE S256: challenge = base64url(sha256(verifier))
  const computed = createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return computed === challenge;
}

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

  // ─── OAuth 2.1 discovery (RFC 8414 + RFC 9728) ────────────────────────
  // MCP clients (claude.ai, etc.) probe these before connecting so they
  // can find our authorization_endpoint / token_endpoint.

  const issuer = `https://${opts.publicHost}`;
  const oauthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    // Public clients (no client_secret): MCP clients register dynamically
    // and rely on PKCE. We also accept client_secret_post for the
    // client_credentials grant.
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
  };

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(oauthMetadata);
  });

  // RFC 9728 Resource Metadata — points clients at the authorization
  // server for this MCP resource. Handles both /.well-known path and the
  // claude.ai-style /.well-known/.../mcp variant.
  const resourceMetadata = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header", "query"],
    scopes_supported: ["mcp"],
  };
  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json(resourceMetadata);
    },
  );

  // ─── OAuth 2.1 authorization_code flow ────────────────────────────────

  // RFC 7591 Dynamic Client Registration — minimal: we don't track
  // clients server-side at all. Every registration returns the same
  // "public" client_id; PKCE is the real binding.
  app.post("/oauth/register", enrollLimiter, (req, res) => {
    const redirectUris: unknown = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris[] is required",
      });
      return;
    }
    res.status(201).json({
      client_id: "public",
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: redirectUris,
    });
  });

  // Consent form — GET shows HTML asking for Turno credentials; the
  // OAuth params ride along as hidden fields through the POST back to
  // the same path.
  app.get("/oauth/authorize", (req, res) => {
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const state = String(req.query.state ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const codeChallengeMethod = String(req.query.code_challenge_method ?? "S256");
    const responseType = String(req.query.response_type ?? "code");

    if (responseType !== "code") {
      res
        .status(400)
        .send(enrollError(`unsupported response_type: ${responseType}`));
      return;
    }
    if (!redirectUri || !/^https?:\/\//i.test(redirectUri)) {
      res.status(400).send(enrollError("redirect_uri missing or not http(s)"));
      return;
    }
    if (!codeChallenge) {
      res.status(400).send(enrollError("code_challenge is required (PKCE)"));
      return;
    }
    if (codeChallengeMethod !== "S256") {
      res
        .status(400)
        .send(enrollError(`only code_challenge_method=S256 supported, got ${codeChallengeMethod}`));
      return;
    }
    res
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .status(200)
      .send(
        oauthConsentForm({
          clientId: clientId || "public",
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
        }),
      );
  });

  app.post("/oauth/authorize", enrollLimiter, async (req, res) => {
    const clientId = String(req.body?.client_id ?? "public");
    const redirectUri = String(req.body?.redirect_uri ?? "");
    const state = String(req.body?.state ?? "");
    const codeChallenge = String(req.body?.code_challenge ?? "");
    const codeChallengeMethod = String(req.body?.code_challenge_method ?? "S256");
    const apiToken = String(req.body?.api_token ?? "").trim();
    const partnerId = String(req.body?.partner_id ?? "").trim();
    const baseUrl =
      String(req.body?.base_url ?? config.TURNO_BASE_URL).trim().replace(/\/+$/, "") ||
      config.TURNO_BASE_URL;

    const renderErr = (msg: string, status = 400) =>
      res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .status(status)
        .send(
          oauthConsentForm({
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            err: msg,
          }),
        );

    if (!redirectUri || !/^https?:\/\//i.test(redirectUri)) {
      res.status(400).send(enrollError("redirect_uri missing"));
      return;
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      res.status(400).send(enrollError("PKCE code_challenge (S256) required"));
      return;
    }
    if (!apiToken) return renderErr("Secret Key is required");
    if (!partnerId || !UUID_RE.test(partnerId)) {
      return renderErr("Partner ID must be a UUID from the Turno Tokens page");
    }

    const check = await validateTurnoCredentials({
      partnerId,
      secretKey: apiToken,
      baseUrl,
      logger: opts.logger,
    });
    if (!check.ok) return renderErr(check.reason);

    const code = signAuthCode({
      partnerId,
      secretKey: apiToken,
      baseUrl,
      redirectUri,
      codeChallenge,
      clientId,
      ttlSeconds: CODE_TTL_SECONDS,
    });

    // RFC 6749 §4.1.2 — redirect back with the code. Preserve state
    // exactly as the client sent it.
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    opts.logger.info(
      { clientId, partnerId, redirectUri },
      "oauth authorization_code issued",
    );
    res.redirect(302, url.toString());
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

  // ─── Enrollment ───────────────────────────────────────────────────────
  if (opts.enrollEnabled) {
    app.get("/enroll", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8").status(200).send(enrollForm());
    });

    app.post("/enroll", enrollLimiter, async (req, res) => {
      const apiToken = String(req.body?.api_token ?? "").trim();
      const partnerId = String(req.body?.partner_id ?? "").trim();
      const baseUrl =
        String(req.body?.base_url ?? config.TURNO_BASE_URL).trim().replace(/\/+$/, "") ||
        config.TURNO_BASE_URL;

      const errors: string[] = [];
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
      opts.logger.info({ baseUrl, partnerId }, "bearer issued via /enroll");
      res
        .setHeader("Content-Type", "text/html; charset=utf-8")
        .status(200)
        .send(enrollSuccess(bearer, opts.publicHost));
    });

    /**
     * OAuth 2.1 token endpoint. Supports:
     *
     *   - grant_type=authorization_code + code + redirect_uri + code_verifier
     *     Exchanges an auth code from /oauth/authorize for access + refresh
     *     tokens. PKCE verifier is checked against the code's stored challenge.
     *
     *   - grant_type=refresh_token + refresh_token
     *     Mints a fresh access_token (and rotates the refresh token) from a
     *     still-valid refresh JWT.
     *
     *   - grant_type=client_credentials + client_id + client_secret
     *     (Or HTTP Basic.) Treats (Partner ID, Secret Key) as OAuth creds.
     *     Legacy alias: grant_type=api_token with api_token + partner_id.
     *
     * Mounted at /token (legacy) and /oauth/token (RFC 8414 spec path).
     */
    const issuePair = (
      partnerId: string,
      secretKey: string,
      baseUrl: string,
    ): {
      access_token: string;
      refresh_token: string;
      token_type: "Bearer";
      expires_in: number;
    } => ({
      access_token: signBearer({
        partnerId, secretKey, baseUrl,
        ttlSeconds: BEARER_TTL_SECONDS, typ: "access",
      }),
      refresh_token: signBearer({
        partnerId, secretKey, baseUrl,
        ttlSeconds: REFRESH_TTL_SECONDS, typ: "refresh",
      }),
      token_type: "Bearer",
      expires_in: BEARER_TTL_SECONDS,
    });

    const tokenHandler: express.RequestHandler = async (req, res) => {
      const grant = String(req.body?.grant_type ?? "");

      // authorization_code + PKCE
      if (grant === "authorization_code") {
        const code = String(req.body?.code ?? "");
        const redirectUri = String(req.body?.redirect_uri ?? "");
        const codeVerifier = String(req.body?.code_verifier ?? "");
        if (!code || !redirectUri || !codeVerifier) {
          res.status(400).json({
            error: "invalid_request",
            error_description: "code, redirect_uri, and code_verifier are required",
          });
          return;
        }
        let claims;
        try {
          claims = verifyBearer(code, "code");
        } catch (err) {
          res.status(400).json({
            error: "invalid_grant",
            error_description: err instanceof BearerError ? err.message : "bad code",
          });
          return;
        }
        if (claims.redirectUri !== redirectUri) {
          res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
          return;
        }
        if (!claims.codeChallenge || !pkceVerify(codeVerifier, claims.codeChallenge)) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        opts.logger.info(
          { partnerId: claims.partnerId, clientId: claims.clientId },
          "oauth access/refresh pair issued via authorization_code",
        );
        res.json(issuePair(claims.partnerId, claims.secretKey, claims.baseUrl));
        return;
      }

      // refresh_token
      if (grant === "refresh_token") {
        const rt = String(req.body?.refresh_token ?? "");
        if (!rt) {
          res.status(400).json({ error: "invalid_request", error_description: "refresh_token required" });
          return;
        }
        let claims;
        try {
          claims = verifyBearer(rt, "refresh");
        } catch (err) {
          res.status(400).json({
            error: "invalid_grant",
            error_description: err instanceof BearerError ? err.message : "bad refresh token",
          });
          return;
        }
        opts.logger.info(
          { partnerId: claims.partnerId },
          "oauth access/refresh pair issued via refresh_token",
        );
        res.json(issuePair(claims.partnerId, claims.secretKey, claims.baseUrl));
        return;
      }

      // client_credentials (+ legacy api_token alias)
      if (grant === "client_credentials" || grant === "api_token") {
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

        opts.logger.info({ baseUrl, partnerId: clientId, grant }, "bearer issued via /token");
        res.json(issuePair(clientId, clientSecret, baseUrl));
        return;
      }

      res.status(400).json({
        error: "unsupported_grant_type",
        error_description:
          "Supported grants: authorization_code, refresh_token, client_credentials, api_token.",
      });
    };

    app.post("/token", enrollLimiter, tokenHandler);
    app.post("/oauth/token", enrollLimiter, tokenHandler);
  }

  // ─── MCP transport ────────────────────────────────────────────────────
  const auth = buildBearerAuth({ logger: opts.logger, publicHost: opts.publicHost });

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

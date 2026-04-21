import type { NextFunction, Request, Response } from "express";
import { BearerError, verifyBearer } from "./bearer.js";
import { getToolContext } from "./client-cache.js";
import type { Logger } from "./logger.js";
import type { ToolContext } from "./tools/_shared.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      toolCtx?: ToolContext;
      partnerId?: string;
    }
  }
}

function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h === "string") {
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const q = req.query?.token;
  if (typeof q === "string" && q.length > 0) return q.trim();
  return null;
}

export interface BearerAuthOpts {
  logger: Logger;
  publicHost: string;
}

export function buildBearerAuth(opts: BearerAuthOpts) {
  const resourceMetadataUrl = `https://${opts.publicHost}/.well-known/oauth-protected-resource`;
  // RFC 9728 / MCP spec: clients discover the authorization server from
  // this header on any 401. Must include resource_metadata or spec-compliant
  // clients (claude.ai, etc.) won't know where to start the OAuth flow.
  const wwwAuth = `Bearer realm="Turno MCP", resource_metadata="${resourceMetadataUrl}"`;

  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearer(req);
    if (!token) {
      res.setHeader("WWW-Authenticate", wwwAuth);
      res.status(401).json({
        error: "unauthorized",
        error_description: "Valid bearer token required",
      });
      return;
    }
    try {
      // Accept only access tokens on /mcp — refresh tokens must go to /token.
      const claims = verifyBearer(token, "access");
      req.partnerId = claims.partnerId;
      req.toolCtx = getToolContext({
        partnerId: claims.partnerId,
        secretKey: claims.secretKey,
        baseUrl: claims.baseUrl,
        logger: opts.logger,
      });
      next();
    } catch (err) {
      const msg = err instanceof BearerError ? err.message : "invalid bearer";
      res.setHeader("WWW-Authenticate", wwwAuth);
      res.status(401).json({
        error: "unauthorized",
        error_description: msg,
      });
    }
  };
}

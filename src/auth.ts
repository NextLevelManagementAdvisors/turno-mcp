import type { NextFunction, Request, Response } from "express";
import type { ToolContext } from "./tools/_shared.js";
import type { Tenant, TenantStore } from "./tenants.js";
import type { TenantRegistry } from "./tenant-registry.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      toolCtx?: ToolContext;
      tenantLabel?: string;
      tenant?: Tenant;
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
  store: TenantStore;
  registry: TenantRegistry;
}

export function buildBearerAuth(opts: BearerAuthOpts) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearer(req);
    if (!token) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="Turno MCP"');
      res.status(401).json({
        error: "unauthorized",
        error_description: "Valid bearer token required",
      });
      return;
    }
    const tenant = opts.store.getByBearer(token);
    if (!tenant) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="Turno MCP"');
      res.status(401).json({
        error: "unauthorized",
        error_description: "Unknown bearer token",
      });
      return;
    }
    req.tenant = tenant;
    req.toolCtx = opts.registry.get(tenant);
    req.tenantLabel = tenant.id;
    opts.store.touch(tenant.id);
    next();
  };
}

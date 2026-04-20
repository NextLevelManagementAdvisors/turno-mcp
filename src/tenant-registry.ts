import type { Logger } from "./logger.js";
import type { Tenant, TenantStore } from "./tenants.js";
import { TurnoClient } from "./turno-client.js";
import type { ToolContext } from "./tools/_shared.js";

/**
 * Lazily builds a per-tenant ToolContext (Turno client + logger) and caches it.
 * Each HTTP request uses the tenant pinned by the bearer-auth middleware.
 */
export class TenantRegistry {
  private contexts = new Map<string, ToolContext>();

  constructor(
    private readonly opts: {
      store: TenantStore;
      logger: Logger;
    },
  ) {}

  get(tenant: Tenant): ToolContext {
    const existing = this.contexts.get(tenant.id);
    if (existing) return existing;

    const apiToken = this.opts.store.decryptApiToken(tenant);
    const client = new TurnoClient({
      baseUrl: tenant.baseUrl,
      bearerToken: apiToken,
      partnerId: tenant.credential.partnerId,
      logger: this.opts.logger.child({ tenant: tenant.id }),
    });
    const ctx: ToolContext = {
      client,
      logger: this.opts.logger.child({ tenant: tenant.id }),
      tenantId: tenant.id,
    };
    this.contexts.set(tenant.id, ctx);
    return ctx;
  }

  evict(tenantId: string): void {
    this.contexts.delete(tenantId);
  }
}

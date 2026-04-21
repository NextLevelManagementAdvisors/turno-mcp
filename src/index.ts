import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { TurnoClient } from "./turno-client.js";
import { registerTools } from "./tools/register.js";
import { listen as listenHttp } from "./http-server.js";
import type { ToolContext } from "./tools/_shared.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  if (config.TRANSPORT === "http") {
    if (!config.TURNO_ENCRYPTION_KEY || config.TURNO_ENCRYPTION_KEY.length < 32) {
      console.error("TURNO_ENCRYPTION_KEY must be set and at least 32 chars when TRANSPORT=http");
      process.exit(1);
    }

    listenHttp({
      host: config.HOST,
      port: config.PORT,
      publicHost: config.PUBLIC_HOST,
      enrollEnabled: config.ENROLL_ENABLED,
      logger,
    });
    logger.info({ port: config.PORT }, "turno-mcp started (http, stateless JWT auth)");
    return;
  }

  // stdio mode — single tenant from env
  if (!config.TURNO_API_TOKEN) {
    console.error("TURNO_API_TOKEN is required in stdio mode");
    process.exit(1);
  }
  if (config.TURNO_PARTNER_ID && !UUID_RE.test(config.TURNO_PARTNER_ID)) {
    console.error("TURNO_PARTNER_ID, when set, must be a UUID");
    process.exit(1);
  }

  const client = new TurnoClient({
    baseUrl: config.TURNO_BASE_URL,
    bearerToken: config.TURNO_API_TOKEN,
    partnerId: config.TURNO_PARTNER_ID || undefined,
    timeoutMs: config.TURNO_REQUEST_TIMEOUT_MS,
    logger,
  });
  const toolCtx: ToolContext = { client, logger };

  const server = new Server(
    { name: "turno-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, toolCtx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("turno-mcp started (stdio)");
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "fatal");
  process.exit(1);
});

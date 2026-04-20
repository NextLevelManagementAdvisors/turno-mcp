import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  formatToolError,
  shapeToJsonSchema,
  type AnyToolDef,
  type ToolContext,
  type ToolResult,
} from "./_shared.js";

import { assignmentTools } from "./assignments.js";
import { blockedDateTools } from "./blocked-dates.js";
import { bookingTools } from "./bookings.js";
import { checklistTools } from "./checklists.js";
import { cleanerTools } from "./cleaners.js";
import { oauthTools } from "./oauth.js";
import { problemTools } from "./problems.js";
import { projectTools } from "./projects.js";
import { propertyTools } from "./properties.js";
import { reviewTools } from "./reviews.js";
import { webhookTools } from "./webhooks.js";

export const allTools: AnyToolDef[] = [
  ...assignmentTools,
  ...blockedDateTools,
  ...bookingTools,
  ...checklistTools,
  ...cleanerTools,
  ...oauthTools,
  ...problemTools,
  ...projectTools,
  ...propertyTools,
  ...reviewTools,
  ...webhookTools,
];

export function registerTools(server: Server, ctx: ToolContext): void {
  const byName = new Map<string, AnyToolDef>();
  for (const t of allTools) {
    if (byName.has(t.name)) {
      throw new Error(`duplicate tool name: ${t.name}`);
    }
    byName.set(t.name, t);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: shapeToJsonSchema(t.inputShape),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    let result: ToolResult;
    if (!tool) {
      result = {
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    } else {
      try {
        const parsed = z.object(tool.inputShape).parse(req.params.arguments ?? {});
        result = await tool.handler(parsed as Record<string, unknown>, ctx);
      } catch (err) {
        result = formatToolError(err);
      }
    }
    return result as unknown as Record<string, unknown>;
  });
}

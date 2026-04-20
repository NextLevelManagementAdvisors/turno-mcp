import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

export const webhookTools: AnyToolDef[] = [
  tool({
    name: "turno_list_webhook_types",
    description: "List available webhook event types. GET /v2/webhooks/available-types.",
    inputShape: {},
    handler: async (_args, ctx) => {
      const res = await ctx.client.get("/webhooks/available-types");
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_list_webhooks",
    description: "List registered webhooks. GET /v2/webhooks.",
    inputShape: {
      page: z.number().int().optional(),
      limit: z.number().int().optional(),
      sort: z.string().optional().describe("Sort field, e.g. 'id'"),
      order: z.enum(["asc", "desc"]).optional(),
      type_id: z.number().int().optional(),
      search: z.string().optional().describe("Substring search on callback URL"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get("/webhooks", { query: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_webhook",
    description: "Get a webhook by id. GET /v2/webhooks/:id.",
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/webhooks/${args.id}`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_create_webhook",
    description: "Register a new webhook. POST /v2/webhooks. DESTRUCTIVE: future events will be delivered to the callback URL.",
    destructive: true,
    inputShape: {
      callback_url: z.string().describe("HTTPS URL to receive events"),
      type_id: z.number().int().describe("Event type ID from turno_list_webhook_types"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/webhooks", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_delete_webhook",
    description: "Delete a webhook. DELETE /v2/webhooks/:id. DESTRUCTIVE: stops event delivery to that callback.",
    destructive: true,
    inputShape: { id: z.number().int() },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(`/webhooks/${args.id}`);
      return jsonContent(res ?? { deleted: true });
    },
  }),
];

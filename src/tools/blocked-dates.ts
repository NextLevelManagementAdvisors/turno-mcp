import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

export const blockedDateTools: AnyToolDef[] = [
  tool({
    name: "turno_list_blocked_dates",
    description: "List blocked dates. GET /v2/blocked-dates.",
    inputShape: {
      page: z.number().int().optional(),
      limit: z.number().int().optional(),
      sort: z.string().optional().describe("Sort field (e.g. 'alias')"),
      order: z.enum(["asc", "desc"]).optional(),
      checkin_from: z.string().optional().describe("Y-m-d"),
      checkin_to: z.string().optional().describe("Y-m-d"),
      checkout_from: z.string().optional().describe("Y-m-d"),
      checkout_to: z.string().optional().describe("Y-m-d"),
      properties: z.array(z.number().int()).optional().describe("Property IDs to filter by"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get("/blocked-dates", { query: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_get_blocked_date",
    description: "Get a blocked date by id. GET /v2/blocked-dates/:id.",
    inputShape: {
      id: z.number().int().describe("Blocked date ID"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get(`/blocked-dates/${args.id}`);
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_create_blocked_date",
    description: "Create a blocked date. POST /v2/blocked-dates. DESTRUCTIVE: blocks the property in Turno.",
    destructive: true,
    inputShape: {
      property_id: z.number().int(),
      external_blocked_date_id: z.string().describe("Your external ID for this block"),
      start_date: z.string().describe("Y-m-d H:i:s"),
      end_date: z.string().describe("Y-m-d H:i:s"),
      summary: z.string().max(255),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.post("/blocked-dates", { body: args });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_update_blocked_date",
    description: "Update a blocked date. PATCH /v2/blocked-dates/:id. DESTRUCTIVE: overwrites the block record.",
    destructive: true,
    inputShape: {
      id: z.number().int(),
      property_id: z.number().int(),
      external_blocked_date_id: z.string(),
      start_date: z.string().describe("Y-m-d H:i:s"),
      end_date: z.string().describe("Y-m-d H:i:s"),
      summary: z.string().max(255),
    },
    handler: async (args, ctx) => {
      const { id, ...body } = args;
      const res = await ctx.client.patch(`/blocked-dates/${id}`, { body });
      return jsonContent(res);
    },
  }),
  tool({
    name: "turno_delete_blocked_date",
    description: "Delete a blocked date. DELETE /v2/blocked-dates/:id. DESTRUCTIVE: removes the block permanently.",
    destructive: true,
    inputShape: {
      id: z.number().int(),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.delete(`/blocked-dates/${args.id}`);
      return jsonContent(res ?? { deleted: true });
    },
  }),
];

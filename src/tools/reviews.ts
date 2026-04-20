import { z } from "zod";
import { jsonContent, tool, type AnyToolDef } from "./_shared.js";

export const reviewTools: AnyToolDef[] = [
  tool({
    name: "turno_list_reviews",
    description: "List reviews, optionally filtered by properties and date range. GET /v2/reviews.",
    inputShape: {
      properties: z.string().optional().describe("Comma-separated property IDs"),
      start: z.string().optional().describe("Y-m-d"),
      end: z.string().optional().describe("Y-m-d"),
    },
    handler: async (args, ctx) => {
      const res = await ctx.client.get("/reviews", { query: args });
      return jsonContent(res);
    },
  }),
];
